import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import WebSocket, {WebSocketServer} from 'ws';
import * as realtime from '../app/realtime-voice.mjs';
const {openRealtimeVoice} = realtime;

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
const transcriptText = ' 応答の確認 😺\n';
const transcriptIndexes = {response_id: responseId, item_id: assistantId, content_index: 0, output_index: 0};
const transcriptDelta = (delta, fields = {}) => ({type: 'response.output_audio_transcript.delta', ...transcriptIndexes, delta, ...fields});
const transcriptDone = (transcript = transcriptText, fields = {}) => ({type: 'response.output_audio_transcript.done',
  ...transcriptIndexes, transcript, ...fields});

async function fixture(t, onEvent, {sessionReadback = session => session} = {}) {
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
        send(ws, {type: 'session.updated', session: {...sessionReadback(value.session), model}});
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
    send(ws, transcriptDelta(' 応答の'));
    send(ws, transcriptDelta('確認 😺\n'));
    send(ws, transcriptDone());
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
  assert.equal(result.outputTranscript, transcriptText);
  assert.equal(result.outputTranscriptConfirmed, true);
  assert.equal(result.transcriptionUsage.type, 'duration');
  assert.ok(result.usage);
  assert.deepEqual(chunks, [audio]);
  assert.deepEqual(transcripts, [' 応答の', '確認 😺\n']);
  assert.deepEqual(wire.map(event => event.type), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  assert.equal(wire[0].session.audio.input.turn_detection, null);
  assert.equal(Object.hasOwn(wire[0].session, 'truncation'), false);
  assert.equal(stages.includes('context'), false);
  assert.deepEqual(wire[0].session.tools, []);
  assert.equal(wire[3].response.max_output_tokens, 128);
  assert.ok(stages.includes('response'));
});

test('accepts a standalone final transcript after binding the output from the same response', async t => {
  const {options} = await fixture(t, (ws, event) => {
    if (event.type !== 'response.create') return;
    send(ws, {type: 'response.created', response: {id: responseId}});
    send(ws, {type: 'response.output_audio.delta', ...transcriptIndexes, delta: audio.toString('base64')});
    send(ws, transcriptDone('prior response', {response_id: 'resp_prior'}));
    send(ws, transcriptDone());
    resultEvents(ws);
  });
  const voice = await openRealtimeVoice(options);
  t.after(() => voice.close());
  const result = await voice.turn(audio);
  assert.equal(result.outputTranscriptConfirmed, true);
  assert.equal(result.outputTranscript, transcriptText);
});

test('unproven terminal transcripts withhold the text without losing response or ASR receipts', async t => {
  const cases = [
    {events: []},
    {events: [transcriptDone('different text')]},
    {events: [transcriptDone('')]},
    {events: [transcriptDone(' \n')]},
    {events: [transcriptDone(transcriptText, {item_id: 'item_wrong'}), transcriptDone()]},
    {events: [transcriptDone(transcriptText, {content_index: 1})]},
    {events: [transcriptDone(transcriptText, {output_index: 1})]},
    {events: [transcriptDone(transcriptText, {response_id: 'resp_other'})]},
    {events: [transcriptDone(), transcriptDone()]},
    {events: [transcriptDone(), transcriptDelta('late delta')]},
    {events: [transcriptDone()], delta: null, bindAudio: false},
    {early: transcriptDone(), events: []},
    {delta: transcriptDelta('', {output_index: 0}), events: [transcriptDone()]},
    {delta: transcriptDelta(transcriptText, {output_index: 1}), events: [transcriptDone()]},
    {delayed: transcriptDone(), events: []},
    {delayed: transcriptDone(), events: [transcriptDone()]},
    {delayed: transcriptDelta('late delta'), events: [transcriptDone()]},
    {status: 'incomplete', events: [transcriptDone()]},
  ];
  for (const {events, early, delayed, delta = transcriptDelta(transcriptText), status = 'completed', bindAudio = true} of cases) {
    const {options} = await fixture(t, (ws, event) => {
      if (event.type !== 'response.create') return;
      send(ws, {type: 'response.created', response: {id: responseId}});
      if (bindAudio) send(ws, {type: 'response.output_audio.delta', ...transcriptIndexes, delta: audio.toString('base64')});
      if (early) send(ws, early);
      if (delta) send(ws, delta);
      for (const item of events) send(ws, item);
      send(ws, {type: 'response.done', response: {id: responseId, status, usage: textAndAudioUsage}});
      if (delayed) send(ws, delayed);
      send(ws, {type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_user1',
        content_index: 0, transcript: '入力の確認', usage: {type: 'duration', seconds: 0.1}});
    });
    const voice = await openRealtimeVoice(options);
    t.after(() => voice.close());
    const result = await voice.turn(audio);
    assert.equal(result.status, status);
    assert.equal(result.outputTranscriptConfirmed, false);
    assert.equal(result.outputTranscript, '');
    assert.equal(result.usage.totalTokens, 18);
    assert.deepEqual(result.transcriptionUsage, {type: 'duration', seconds: 0.1});
  }
});

const history = [{role: 'user', text: '  前の発言\r\n'}, {role: 'assistant', text: '前の返答 😺\n'}];
const ack = (event, extra) => ({type: 'conversation.item.done', item: event.item,
  previous_item_id: event.previous_item_id ?? null, ...extra});
const noAudioSent = wire => assert.equal(wire.some(event => event.type.startsWith('input_audio_buffer.') ||
  event.type === 'response.create'), false);

test('validates a bounded exact copy of server history before connecting', async t => {
  const validate = realtime.validateRealtimeHistory;
  const copy = validate(history);
  assert.deepEqual(copy, history);
  assert.notEqual(copy, history);
  assert.notEqual(copy[0], history[0]);
  assert.deepEqual(validate([]), []);
  assert.ok(validate([{role: 'assistant', text: 'é'.repeat(10000)}]));
  assert.ok(validate([{role: 'assistant', text: 'x'.repeat(12000)}]));
  assert.ok(validate(Array.from({length: 40}, () => ({role: 'user', text: 'x'}))));
  for (const invalid of [null, {}, [, {role: 'user', text: 'ok'}], [{role: 'system', text: 'setup'}],
    [{role: 'assistant', text: 'text', audio: 'bytes'}], [{role: 'user', text: ''}],
    [{role: 'user', text: '\ud800'}], [{role: 'user', text: 'x'.repeat(12001)}],
    [{role: 'user', text: 'é'.repeat(10000)}, {role: 'assistant', text: 'x'}],
    Array.from({length: 41}, () => ({role: 'assistant', text: 'x'})),
  ]) assert.equal(validate(invalid), null);
  const {options, wire} = await fixture(t);
  let connects = 0;
  await assert.rejects(openRealtimeVoice({...options, history: null, connect() { connects++; }}),
    {code: 'REALTIME_VOICE_INVALID_HISTORY'});
  assert.equal(connects, 0);
  assert.deepEqual(wire, []);
});

test('replays exact ordered text history, then and only then allows the next audio commit', async t => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const {options, wire, stages} = await fixture(t, (ws, event) => {
    if (event.type === 'conversation.item.create') {
      if (event.item.role === 'user') first.resolve({ws, event});
      else second.resolve({ws, event});
    } else if (event.type === 'response.create') {
      send(ws, {type: 'response.created', response: {id: responseId}});
      resultEvents(ws);
    }
  });
  const mutable = history.map(item => ({...item}));
  let opened = false;
  const starting = openRealtimeVoice({...options, history: mutable}).then(value => { opened = true; return value; });
  mutable[1].text = 'modified after open';
  const earlier = await first.promise;
  assert.equal(opened, false);
  assert.equal(wire[0].session.truncation, 'disabled');
  assert.deepEqual(earlier.event.item.content, [{type: 'input_text', text: history[0].text}]);
  assert.equal(Object.hasOwn(earlier.event, 'previous_item_id'), false);
  assert.equal(stages.filter(stage => stage === 'context').length, 1);
  send(earlier.ws, {...ack(earlier.event), type: 'conversation.item.added'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, false);
  assert.deepEqual(wire.map(value => value.type), ['session.update', 'conversation.item.create']);
  noAudioSent(wire);
  send(earlier.ws, ack(earlier.event));
  const later = await second.promise;
  assert.equal(opened, false);
  assert.equal(later.event.previous_item_id, earlier.event.item.id);
  assert.notEqual(later.event.item.id, earlier.event.item.id);
  assert.deepEqual(later.event.item.content, [{type: 'output_text', text: history[1].text}]);
  assert.equal(stages.filter(stage => stage === 'context').length, 2);
  send(later.ws, ack(later.event));
  const voice = await starting;
  t.after(() => voice.close());
  assert.equal((await voice.turn(audio)).status, 'completed');
  assert.deepEqual(wire.map(value => value.type), ['session.update', 'conversation.item.create', 'conversation.item.create',
    'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
});

test('rejects a missing, mismatched, or out-of-order final history acknowledgment without advancing', async t => {
  const altered = [() => null,
    event => ack(event, {item: {...event.item, id: 'unexpected'}}),
    event => ack(event, {item: {...event.item, role: 'assistant'}}),
    event => ack(event, {item: {...event.item, status: 'incomplete'}}),
    event => ack(event, {item: {...event.item, content: [{type: 'input_audio', text: history[0].text}]}}),
    event => ack(event, {item: {...event.item, content: [{type: 'input_text', text: history[0].text.trim()}]}}),
    event => ack(event, {previous_item_id: 'unknown-predecessor'}),
  ];
  for (const modify of altered) {
    const {options, wire} = await fixture(t, (ws, event) => {
      if (event.type === 'conversation.item.create') {
        const result = modify(event);
        send(ws, result ?? {...ack(event), type: 'conversation.item.added'});
      }
    });
    await assert.rejects(openRealtimeVoice({...options, timeoutMs: 125, history}), {code: 'REALTIME_VOICE_CONTEXT_UNVERIFIED'});
    assert.deepEqual(wire.map(value => value.type), ['session.update', 'conversation.item.create']);
    noAudioSent(wire);
  }
});

test('requires the exact restored predecessor, disabled truncation, and renewed authorization', async t => {
  const wrongOrder = await fixture(t, (ws, event) => {
    if (event.type === 'conversation.item.create') send(ws, ack(event, {previous_item_id: null}));
  });
  await assert.rejects(openRealtimeVoice({...wrongOrder.options, history}), {code: 'REALTIME_VOICE_CONTEXT_UNVERIFIED'});
  assert.equal(wrongOrder.wire.filter(event => event.type === 'conversation.item.create').length, 2);
  noAudioSent(wrongOrder.wire);

  const truncates = await fixture(t, null, {sessionReadback: session => ({...session, truncation: 'auto'})});
  await assert.rejects(openRealtimeVoice({...truncates.options, history}), {code: 'REALTIME_VOICE_CONTEXT_UNVERIFIED'});
  assert.deepEqual(truncates.wire.map(event => event.type), ['session.update']);

  let revoked = false;
  const stopped = await fixture(t, (ws, event) => {
    if (event.type === 'conversation.item.create') {
      revoked = true;
      send(ws, ack(event));
    }
  });
  await assert.rejects(openRealtimeVoice({...stopped.options, history, authorize: () => !revoked}),
    {code: 'REALTIME_VOICE_NOT_AUTHORIZED'});
  assert.deepEqual(stopped.wire.map(event => event.type), ['session.update', 'conversation.item.create']);
  noAudioSent(stopped.wire);

  const empty = await fixture(t);
  const voice = await openRealtimeVoice({...empty.options, history: []});
  t.after(() => voice.close());
  assert.deepEqual(empty.wire.map(event => event.type), ['session.update']);
  assert.deepEqual(empty.stages, ['connect', 'configure']);
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
  assert.equal(result.outputTranscriptConfirmed, false);
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
    send(ws, transcriptDelta('別の項目', {item_id: 'item_other'}));
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
