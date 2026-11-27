import {Agent} from 'node:https';
import WebSocket from 'ws';
import {normalizeRealtimeTranscriptionUsage, normalizeRealtimeUsage} from './realtime-usage.mjs';

const endpoint = 'wss://api.openai.com/v1/realtime';
const pcm = {type: 'audio/pcm', rate: 24000};
const bytesPerMillisecond = 48;
const frameLimit = 1024 * 1024;
const textLimit = 12000;
const tokenName = /^[a-z0-9][a-z0-9_.-]{0,159}$/i;
const error = code => Object.assign(new Error(code), {code});
const boundedInteger = (value, lower, upper) => Number.isSafeInteger(value) && value >= lower && value <= upper;
const validPcm = value => value?.type === pcm.type && value.rate === pcm.rate;
const noCallbacks = {};

function providerSocket(url, options) {
  return new WebSocket(url, {...options, agent: new Agent()});
}

export async function openRealtimeVoice({key, organization, project, model, voice, transcriptionModel, maxOutputTokens,
  maxInputSeconds, authorize, connect = providerSocket, signal, timeoutMs = 30000, lifetimeMs = 180000}) {
  if (![key, organization, project].every(value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value)) ||
      ![model, voice, transcriptionModel].every(value => typeof value === 'string' && tokenName.test(value)) ||
      !boundedInteger(maxOutputTokens, 1, 4096) || !boundedInteger(maxInputSeconds, 1, 60) ||
      !boundedInteger(timeoutMs, 100, 120000) || !boundedInteger(lifetimeMs, timeoutMs, 300000) ||
      typeof authorize !== 'function' || typeof connect !== 'function') throw error('REALTIME_VOICE_INVALID_CONFIGURATION');

  function admit(stage) {
    if (signal?.aborted || authorize(stage) !== true) throw error('REALTIME_VOICE_NOT_AUTHORIZED');
  }
  admit('connect');
  let socket;
  try {
    const url = new URL(endpoint);
    url.searchParams.set('model', model);
    socket = connect(url, {followRedirects: false, maxPayload: frameLimit, handshakeTimeout: timeoutMs,
      headers: {Authorization: 'Bearer ' + key, 'OpenAI-Organization': organization, 'OpenAI-Project': project}});
  } catch { throw error('REALTIME_VOICE_CONNECTION_FAILED'); }

  const ready = Promise.withResolvers();
  const session = {
    type: 'realtime', output_modalities: ['audio'], max_output_tokens: maxOutputTokens, tools: [], tool_choice: 'none',
    audio: {input: {format: pcm, transcription: {model: transcriptionModel}, turn_detection: null},
      output: {format: pcm, voice}},
  };
  let phase = 'opening';
  let active;
  let lastAudio;
  let truncation;
  const lifetime = setTimeout(() => close('REALTIME_VOICE_SESSION_EXPIRED'), lifetimeMs);
  const opening = setTimeout(() => close('REALTIME_VOICE_CONNECTION_FAILED'), timeoutMs);
  lifetime.unref();
  opening.unref();
  function abort() { close('REALTIME_VOICE_CLOSED'); }
  function close(reason = 'REALTIME_VOICE_CLOSED') {
    if (phase === 'closed') return;
    phase = 'closed';
    signal?.removeEventListener('abort', abort);
    clearTimeout(opening);
    clearTimeout(lifetime);
    clearTimeout(active?.timer);
    clearTimeout(truncation?.timer);
    ready.reject(error(reason));
    if (active) {
      const failure = error(active.committed ? 'REALTIME_VOICE_SETTLEMENT_UNKNOWN' : reason);
      if (active.committed) {
        failure.receipts = {
          response: active.response?.usage ? {id: active.responseId, ...active.response} : null,
          transcription: active.transcription ? {itemId: active.inputItemId, usage: active.transcription.usage} : null,
          responseRequested: active.responseRequested === true,
        };
      }
      active.reject(failure);
    }
    socket.terminate();
    active = undefined;
    lastAudio = undefined;
    truncation = undefined;
  }

  function send(message) {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 4 * frameLimit) {
      throw error('REALTIME_VOICE_CONNECTION_FAILED');
    }
    socket.send(JSON.stringify(message));
  }

  function checkSession(actual) {
    return actual?.type === session.type && actual.model === model && actual.max_output_tokens === maxOutputTokens &&
      actual.output_modalities?.length === 1 && actual.output_modalities[0] === 'audio' &&
      actual.tools?.length === 0 && actual.tool_choice === 'none' &&
      actual.audio?.input?.turn_detection === null && actual.audio.input.transcription?.model === transcriptionModel &&
      validPcm(actual.audio.input.format) && validPcm(actual.audio?.output?.format) && actual.audio.output.voice === voice;
  }

  function requestTruncation(output, audioEndMs) {
    truncation = {itemId: output.itemId, audioEndMs,
      timer: setTimeout(() => close('REALTIME_VOICE_TRUNCATION_UNKNOWN'), timeoutMs)};
    truncation.timer.unref();
    send({type: 'conversation.item.truncate', item_id: output.itemId, content_index: 0, audio_end_ms: audioEndMs});
  }

  function finishTurn() {
    if (!active?.response || truncation) return;
    // Cancellation stops playback immediately. Wait for the terminal event to learn
    // the complete generated item before removing the part the listener never heard.
    if (active.interrupted && !active.truncated && active.audio &&
        active.heardMs < active.audio.bytes / bytesPerMillisecond) {
      active.truncated = true;
      requestTruncation(active.audio, active.heardMs);
      return;
    }
    if (!active.transcription) return;
    const current = active;
    active = undefined;
    clearTimeout(current.timer);
    lastAudio = current.interrupted || current.playbackCompleted ? undefined : current.audio;
    current.resolve({status: current.response.status, responseId: current.responseId, usage: current.response.usage,
      inputTranscript: current.transcription.text, transcriptionUsage: current.transcription.usage,
      outputTranscript: current.interrupted ? '' : current.outputTranscript, interrupted: current.interrupted,
      responseRequested: current.responseRequested === true});
  }

  function interrupt(audioEndMs) {
    const output = active?.audio ?? lastAudio;
    const receivedMs = (output?.bytes ?? 0) / bytesPerMillisecond;
    if (truncation || active?.interrupted || !boundedInteger(audioEndMs, 0, Math.floor(receivedMs))) return false;
    const cancel = active && !active.response;
    const truncate = output && audioEndMs < receivedMs;
    if (!cancel && !truncate) return false;
    try {
      if (active) {
        active.interrupted = true;
        active.heardMs = audioEndMs;
        if (cancel && active.responseId) send({type: 'response.cancel', response_id: active.responseId});
        finishTurn();
      } else {
        requestTruncation(output, audioEndMs);
        lastAudio = undefined;
      }
      return true;
    } catch { close('REALTIME_VOICE_TRUNCATION_UNKNOWN'); return false; }
  }

  function playbackCompleted() {
    if (truncation) return false;
    if (active?.response && active.audio) { active.playbackCompleted = true; return true; }
    if (!lastAudio) return false;
    lastAudio = undefined;
    return true;
  }

  async function turn(audio, {onAudio, onTranscript} = noCallbacks) {
    if (phase !== 'ready' || active || truncation || lastAudio) throw error('REALTIME_VOICE_NOT_READY');
    if (!Buffer.isBuffer(audio) || audio.length % 2 !== 0 || audio.length < 100 * bytesPerMillisecond ||
        audio.length > maxInputSeconds * 1000 * bytesPerMillisecond) throw error('REALTIME_VOICE_INVALID_AUDIO');
    admit('input');
    const pending = Promise.withResolvers();
    active = {...pending, onAudio, onTranscript, outputTranscript: '', interrupted: false, committed: false,
      timer: setTimeout(() => close('REALTIME_VOICE_SETTLEMENT_UNKNOWN'), timeoutMs)};
    active.timer.unref();
    try {
      for (let offset = 0; offset < audio.length; offset += 9600) {
        send({type: 'input_audio_buffer.append', audio: audio.subarray(offset, offset + 9600).toString('base64')});
      }
      active.committed = true;
      send({type: 'input_audio_buffer.commit'});
    } catch { close('REALTIME_VOICE_CONNECTION_FAILED'); }
    return pending.promise;
  }

  function onEvent(message) {
    if (phase === 'closed') return;
    switch (message.type) {
      case 'error':
        close('REALTIME_VOICE_PROVIDER_FAILED');
        return;
      case 'session.created':
        if (phase !== 'opening' || message.session?.model !== model) throw error('REALTIME_VOICE_CONFIGURATION_UNVERIFIED');
        admit('configure');
        phase = 'configuring';
        send({type: 'session.update', session});
        return;
      case 'session.updated':
        if (phase !== 'configuring' || !checkSession(message.session)) throw error('REALTIME_VOICE_CONFIGURATION_UNVERIFIED');
        clearTimeout(opening);
        phase = 'ready';
        ready.resolve({turn, interrupt, playbackCompleted, close: () => close()});
        return;
      case 'input_audio_buffer.committed':
        if (!active?.committed || active.inputItemId || !validId(message.item_id)) throw error('REALTIME_VOICE_SETTLEMENT_UNKNOWN');
        active.inputItemId = message.item_id;
        if (active.interrupted) {
          active.response = {status: 'cancelled', usage: null};
          finishTurn();
          return;
        }
        admit('response');
        active.responseRequested = true;
        send({type: 'response.create', response: {max_output_tokens: maxOutputTokens}});
        return;
      case 'conversation.item.input_audio_transcription.completed': {
        if (!active?.inputItemId || message.item_id !== active.inputItemId || message.content_index !== 0) return;
        const usage = normalizeRealtimeTranscriptionUsage(message.usage);
        if (active.transcription || !usage || typeof message.transcript !== 'string' || message.transcript.length > textLimit) {
          throw error('REALTIME_VOICE_SETTLEMENT_UNKNOWN');
        }
        active.transcription = {text: message.transcript, usage};
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        if (active?.inputItemId && message.item_id === active.inputItemId) throw error('REALTIME_VOICE_SETTLEMENT_UNKNOWN');
        return;
      case 'response.created':
        if (!active?.responseRequested || active.responseId || !validId(message.response?.id)) throw error('REALTIME_VOICE_SETTLEMENT_UNKNOWN');
        active.responseId = message.response.id;
        if (active.interrupted) send({type: 'response.cancel', response_id: active.responseId});
        return;
      case 'response.output_audio.delta': {
        if (!active?.responseId || active.responseId !== message.response_id) return;
        if (active.response || !outputItemMatches(message) || typeof message.delta !== 'string' ||
            message.delta.length > frameLimit) throw error('REALTIME_VOICE_INVALID_AUDIO');
        const bytes = Buffer.from(message.delta, 'base64');
        if (!bytes.length || bytes.length % 2 !== 0 || bytes.toString('base64') !== message.delta) {
          throw error('REALTIME_VOICE_INVALID_AUDIO');
        }
        active.audio ??= {itemId: message.item_id, bytes: 0};
        if (active.audio.itemId !== message.item_id || active.audio.bytes + bytes.length > 120000 * bytesPerMillisecond) {
          throw error('REALTIME_VOICE_INVALID_AUDIO');
        }
        active.audio.bytes += bytes.length;
        if (!active.interrupted) active.onAudio?.(bytes);
        return;
      }
      case 'response.output_audio_transcript.delta':
        if (!active?.responseId || active.responseId !== message.response_id || active.interrupted) return;
        if (!outputItemMatches(message) || typeof message.delta !== 'string' ||
            active.outputTranscript.length + message.delta.length > textLimit) throw error('REALTIME_VOICE_INVALID_TRANSCRIPT');
        active.outputTranscript += message.delta;
        active.onTranscript?.(message.delta);
        return;
      case 'response.done': {
        const response = message.response;
        if (!active?.responseId || active.responseId !== response?.id) throw error('REALTIME_VOICE_SETTLEMENT_UNKNOWN');
        const usage = normalizeRealtimeUsage(response.usage);
        if (active.response || !usage || !['completed', 'cancelled', 'failed', 'incomplete'].includes(response.status)) {
          throw error('REALTIME_VOICE_SETTLEMENT_UNKNOWN');
        }
        active.response = {status: response.status, usage};
        break;
      }
      case 'conversation.item.truncated':
        if (!truncation || truncation.itemId !== message.item_id || truncation.audioEndMs !== message.audio_end_ms ||
            message.content_index !== 0) throw error('REALTIME_VOICE_TRUNCATION_UNKNOWN');
        clearTimeout(truncation.timer);
        truncation = undefined;
        break;
      default: return;
    }
    finishTurn();
  }

  function outputItemMatches(message) {
    if (!validId(message.item_id) || message.content_index !== 0) return false;
    active.outputItemId ??= message.item_id;
    return active.outputItemId === message.item_id;
  }

  socket.on('message', (frame, binary) => {
    if (binary || frame.length > frameLimit) { close('REALTIME_VOICE_PROVIDER_FAILED'); return; }
    try { onEvent(JSON.parse(frame.toString('utf8'))); }
    catch (cause) {
      close(typeof cause?.code === 'string' && cause.code.startsWith('REALTIME_VOICE_')
        ? cause.code : 'REALTIME_VOICE_PROVIDER_FAILED');
    }
  });
  socket.on('close', () => close('REALTIME_VOICE_CONNECTION_FAILED'));
  socket.on('error', () => close('REALTIME_VOICE_CONNECTION_FAILED'));
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  return ready.promise;
}

function validId(value) {
  return typeof value === 'string' && tokenName.test(value);
}
