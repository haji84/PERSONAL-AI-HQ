import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import WebSocket, {WebSocketServer} from 'ws';
import {openRealtimeVoice} from '../app/realtime-voice.mjs';

const model = 'gpt-realtime';
const responseId = 'resp_voice1';
const assistantId = 'item_assistant1';
const textAndAudioUsage = {
  total_tokens: 18, input_tokens: 11, output_tokens: 7,
  input_token_details: {text_tokens: 7, audio_tokens: 4, cached_tokens: 0,
    cached_tokens_details: {text_tokens: 0, audio_tokens: 0, image_tokens: 0}, image_tokens: 0},
  output_token_details: {text_tokens: 2, audio_tokens: 5},
};
const audio = Buffer.alloc(4800);
const send = (ws, value) => ws.send(JSON.stringify(value));

async function fixture(t, onEvent) {
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const wire = [];
  const stages = [];
  server.on('connection', ws => {
    send(ws, {type: 'session.created', session: {type: 'realtime', model}});
    ws.on('message', bytes => {
      const value = JSON.parse(bytes);
      wire.push(value);
      if (value.type === 'session.update') {
        send(ws, {type: 'session.updated', session: {...value.session, model}});
      } else if (value.type === 'input_audio_buffer.commit') {
        send(ws, {type: 'input_audio_buffer.committed', item_id: 'item_user1'});
      }
      onEvent?.(ws, value);
    });
  });
  return {
    wire, stages,
    options: {
      key: 'fixture-key', organization: 'org_fixture', project: 'proj_fixture',
      model, voice: 'marin', transcriptionModel: 'whisper-1', maxOutputTokens: 128,
      maxInputSeconds: 5, timeoutMs: 1800,
      authorize(stage) { stages.push(stage); return true; },
      connect(url, options) {
        assert.equal(url.href, 'wss://api.openai.com/v1/realtime?model=gpt-realtime');
        assert.equal(options.followRedirects, false);
        assert.equal(options.headers['OpenAI-Project'], 'proj_fixture');
        return new WebSocket('ws://127.0.0.1:' + server.address().port, options);
      },
    },
  };
}

function resultEvents(ws, status = 'completed') {
  send(ws, {type: 'response.done', response: {id: responseId, status, usage: textAndAudioUsage}});
  send(ws, {type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_user1',
    content_index: 0, transcript: '入力の確認', usage: {type: 'duration', seconds: 0.1}});
}

test('requires authorization before opening a socket and before accepting an audio turn', async t => {
  const {options, wire} = await fixture(t);
  let attempted = false;
  await assert.rejects(openRealtimeVoice({...options, authorize: () => false, connect() { attempted = true; }}),
    {code: 'REALTIME_VOICE_NOT_AUTHORIZED'});
  assert.equal(attempted, false);
  const voice = await openRealtimeVoice({...options, authorize: phase => phase !== 'input'});
  t.after(() => voice.close());
  await assert.rejects(voice.turn(audio), {code: 'REALTIME_VOICE_NOT_AUTHORIZED'});
  assert.deepEqual(wire.map(event => event.type), ['session.update']);
});

test('uses the GA voice exchange, streams scoped PCM, and waits for both usage receipts', async t => {
  const {options, wire, stages} = await fixture(t, (ws, event) => {
    if (event.type !== 'response.create') return;
    send(ws, {type: 'response.created', response: {id: responseId}});
    send(ws, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantId,
      content_index: 0, delta: audio.toString('base64')});
    send(ws, {type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: assistantId,
      content_index: 0, delta: '応答の確認'});
    resultEvents(ws);
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  const chunks = [];
  const transcripts = [];
  const result = await voice.turn(audio, {onAudio: chunk => chunks.push(chunk), onTranscript: delta => transcripts.push(delta)});
  assert.equal(result.status, 'completed');
  assert.equal(result.responseId, responseId);
  assert.equal(result.inputTranscript, '入力の確認');
  assert.equal(result.outputTranscript, '応答の確認');
  assert.equal(result.transcriptionUsage.type, 'duration');
  assert.ok(result.usage);
  assert.deepEqual(chunks, [audio]);
  assert.deepEqual(transcripts, ['応答の確認']);
  assert.deepEqual(wire.map(event => event.type), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  assert.equal(wire[0].session.audio.input.turn_detection, null);
  assert.deepEqual(wire[0].session.tools, []);
  assert.equal(wire[3].response.max_output_tokens, 128);
  assert.ok(stages.includes('response'));
});

test('cancels the current response and verifies truncation at the heard duration', async t => {
  const {options, wire} = await fixture(t, (ws, event) => {
    if (event.type === 'response.create') {
      send(ws, {type: 'response.created', response: {id: responseId}});
      send(ws, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantId,
        content_index: 0, delta: audio.toString('base64')});
    } else if (event.type === 'response.cancel') {
      resultEvents(ws, 'cancelled');
    } else if (event.type === 'conversation.item.truncate') {
      send(ws, {type: 'conversation.item.truncated', item_id: assistantId, content_index: 0, audio_end_ms: 42});
    }
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  const result = await voice.turn(audio, {onAudio: () => assert.equal(voice.interrupt(42), true)});
  assert.equal(result.status, 'cancelled');
  assert.equal(result.interrupted, true);
  assert.equal(result.outputTranscript, '');
  assert.ok(result.usage);
  assert.deepEqual(wire.slice(-2), [
    {type: 'response.cancel', response_id: responseId},
    {type: 'conversation.item.truncate', item_id: assistantId, content_index: 0, audio_end_ms: 42},
  ]);
});

test('response usage alone does not settle a voice turn whose transcription receipt is missing', async t => {
  const {options} = await fixture(t, (ws, event) => {
    if (event.type !== 'response.create') return;
    send(ws, {type: 'response.created', response: {id: responseId}});
    send(ws, {type: 'response.done', response: {id: responseId, status: 'completed', usage: textAndAudioUsage}});
    ws.close();
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  await assert.rejects(voice.turn(audio), failure => {
    assert.equal(failure.code, 'REALTIME_VOICE_SETTLEMENT_UNKNOWN');
    assert.equal(failure.receipts.response.id, responseId);
    assert.equal(failure.receipts.response.usage.totalTokens, 18);
    assert.equal(failure.receipts.transcription, null);
    return true;
  });
});

test('does not start a model response if authorization is withdrawn after audio is committed', async t => {
  const {options, wire} = await fixture(t, (ws, event) => {
    if (event.type === 'input_audio_buffer.commit') send(ws, {type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_user1', content_index: 0, transcript: '承認取消', usage: {type: 'duration', seconds: 0.1}});
  });
  const voice = await openRealtimeVoice({...options, authorize: stage => stage !== 'response'});
  t.after(() => voice.close());
  const turn = await voice.turn(audio);
  assert.deepEqual(wire.map(event => event.type), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
  assert.equal(turn.responseRequested, false);
  assert.equal(turn.status, 'cancelled');
  assert.equal(turn.inputItemId, 'item_user1');
  assert.equal(turn.transcriptionUsage.seconds, 0.1);
});

test('does not combine a transcript and audio belonging to different assistant items', async t => {
  const {options} = await fixture(t, (ws, event) => {
    if (event.type !== 'response.create') return;
    send(ws, {type: 'response.created', response: {id: responseId}});
    send(ws, {type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: 'item_other',
      content_index: 0, delta: '別の項目'});
    send(ws, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantId,
      content_index: 0, delta: audio.toString('base64')});
    resultEvents(ws);
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  await assert.rejects(voice.turn(audio), {code: 'REALTIME_VOICE_SETTLEMENT_UNKNOWN'});
});

test('keeps the same provider session while checking a new turn after an interrupted playback', async t => {
  let turns = 0;
  const {options, wire} = await fixture(t, (ws, event) => {
    if (event.type === 'conversation.item.truncate') {
      setTimeout(() => send(ws, {type: 'conversation.item.truncated', item_id: assistantId, content_index: 0, audio_end_ms: 40}), 20);
      return;
    }
    if (event.type !== 'response.create') return;
    turns++;
    send(ws, {type: 'response.created', response: {id: responseId}});
    send(ws, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantId,
      content_index: 0, delta: audio.toString('base64')});
    resultEvents(ws);
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  await voice.turn(audio);
  await assert.rejects(voice.turn(audio), {code: 'REALTIME_VOICE_NOT_READY'});
  assert.equal(voice.interrupt(40), true);
  await assert.rejects(voice.turn(audio), {code: 'REALTIME_VOICE_NOT_READY'});
  await new Promise(resolve => setTimeout(resolve, 40));
  await voice.turn(audio);
  assert.equal(turns, 2);
  assert.equal(wire.filter(event => event.type === 'session.update').length, 1);
  assert.equal(voice.playbackCompleted(), true);
  await voice.turn(audio);
  assert.equal(turns, 3);
});

test('queues an interruption until the exact response ID arrives before the first audio', async t => {
  const waiting = Promise.withResolvers();
  const {options, wire} = await fixture(t, (ws, event) => {
    if (event.type === 'response.create') waiting.resolve(ws);
    if (event.type === 'response.cancel') resultEvents(ws, 'cancelled');
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  const turn = voice.turn(audio);
  const provider = await waiting.promise;
  assert.equal(voice.interrupt(0), true);
  send(provider, {type: 'response.created', response: {id: responseId}});
  assert.equal((await turn).interrupted, true);
  assert.deepEqual(wire.at(-1), {type: 'response.cancel', response_id: responseId});
  assert.ok(!wire.some(event => event.type === 'conversation.item.truncate'));
});

test('discards late PCM after an early interruption and confirms its removal from provider context', async t => {
  const waiting = Promise.withResolvers();
  const {options, wire} = await fixture(t, (ws, event) => {
    if (event.type === 'response.create') waiting.resolve(ws);
    if (event.type === 'response.cancel') {
      send(ws, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantId,
        content_index: 0, delta: audio.toString('base64')});
      resultEvents(ws, 'cancelled');
    }
    if (event.type === 'conversation.item.truncate') {
      send(ws, {type: 'conversation.item.truncated', item_id: assistantId, content_index: 0, audio_end_ms: 0});
    }
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  const played = [];
  const turn = voice.turn(audio, {onAudio: chunk => played.push(chunk)});
  const provider = await waiting.promise;
  assert.equal(voice.interrupt(0), true);
  send(provider, {type: 'response.created', response: {id: responseId}});
  assert.equal((await turn).status, 'cancelled');
  assert.deepEqual(played, []);
  assert.deepEqual(wire.at(-1), {type: 'conversation.item.truncate', item_id: assistantId, content_index: 0, audio_end_ms: 0});
});
