import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import WebSocket, {WebSocketServer} from 'ws';
import {apiAuthorityFile} from '../app/api-authority.mjs';
import {ExecutionStore} from '../app/execution-store.mjs';
import {startOwnerApp} from '../app/server.mjs';

const mac = {skip: process.platform !== 'darwin', timeout: 10000};
const route = '/api/chat/realtime';
const project = 'voice-fixture';
const second = 'second-voice';
const task = 'voice-fixture-turn';
const model = 'gpt-realtime-1.5';
const waveform = Buffer.alloc(4800);
for (let offset = 0; offset < waveform.length; offset += 2) {
  waveform.writeInt16LE(Math.round(12000 * Math.sin(offset * Math.PI / 160)), offset);
}
const pcm = waveform.toString('base64');
const request = {id: task, pcm, revision: 1};
const responseId = 'resp_voice_fixture';
const inputItem = 'item_voice_input';
const assistantItem = 'item_voice_answer';
const textUsage = {total_tokens: 7, input_tokens: 4, output_tokens: 3,
  input_token_details: {text_tokens: 4, cached_tokens: 1, cached_tokens_details: {text_tokens: 1}},
  output_token_details: {text_tokens: 3}};
const rawUsage = {total_tokens: 7, input_tokens: 4, output_tokens: 3,
  input_token_details: {text_tokens: 2, audio_tokens: 2, cached_tokens: 1,
    cached_tokens_details: {text_tokens: 1, audio_tokens: 0}}, output_token_details: {text_tokens: 0, audio_tokens: 3}};
const publish = (socket, event) => socket.send(JSON.stringify(event));
const eventTypes = wire => wire.map(event => event.type);
function transcript(socket, usage = {type: 'duration', seconds: 0.1}) {
  publish(socket, {type: 'conversation.item.input_audio_transcription.completed', item_id: inputItem, content_index: 0,
    transcript: '予算を確認してください', usage});
}
function audioResponse(socket, {body = '使用量を確認しました', confirm = true} = {}) {
  publish(socket, {type: 'response.created', response: {id: responseId}});
  publish(socket, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantItem,
    output_index: 0, content_index: 0, delta: pcm});
  publish(socket, {type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: assistantItem,
    output_index: 0, content_index: 0, delta: body});
  if (confirm) publish(socket, {type: 'response.output_audio_transcript.done', response_id: responseId, item_id: assistantItem,
    output_index: 0, content_index: 0, transcript: body});
}
function done(socket, status = 'completed') {
  publish(socket, {type: 'response.done', response: {id: responseId, status, usage: rawUsage}});
}

function confirmContext(socket, event) {
  publish(socket, {type: 'conversation.item.done', previous_item_id: event.previous_item_id ?? null,
    item: {...event.item, status: 'completed'}});
}

function editArchive(fixture, id, edit) {
  const db = new DatabaseSync(join(fixture.directory, 'conversations.sqlite'));
  try {
    const row = db.prepare('SELECT messages FROM conversations WHERE project=? AND id=?').get(project, id);
    const value = JSON.parse(row.messages);
    edit(value.messages);
    db.prepare('UPDATE conversations SET messages=? WHERE project=? AND id=?').run(JSON.stringify(value), project, id);
  } finally { db.close(); }
}

async function fixture(t, onWire) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hq-voice-policy-')));
  const ledger = join(directory, 'execution-policy.json');
  const authorityPath = join(directory, apiAuthorityFile);
  const store = new ExecutionStore(ledger, {authorityId: 'personal-ai-hq-local'});
  const ledgerBinding = store.initializeReservationAuthority();
  const authority = {version: 1, organization: 'org-fixture', providerProject: 'proj_fixture',
    reservationAuthorityId: store.authorityId, ledgerBinding, defaultModel: 'fixture-responses',
    models: [{id: 'fixture-responses', contextTokens: 1000, outputTokens: 200, inputUsdPerMillion: 1,
      outputUsdPerMillion: 4, reasoningEfforts: []}], projects: {}, credit: {organization: 'org-fixture',
      observedAt: new Date().toISOString(), safeUntil: new Date(Date.now() + 300000).toISOString(), availableCreditUsd: 1.5,
      checkoutConfirmed: true, purchasedCreditUsd: 0, paidBillingEnabled: false, autoRechargeEnabled: false}, realtimeVoice: {
      projects: [project, second], model, voice: 'marin', transcriptionModel: 'gpt-transcribe', contextTokens: 32000,
      maxInputSeconds: 10, maxOutputTokens: 100, rates: {inputTextUsdPerMillion: 4, inputAudioUsdPerMillion: 32,
        cachedTextUsdPerMillion: 0.4, cachedAudioUsdPerMillion: 0.4, outputTextUsdPerMillion: 16, outputAudioUsdPerMillion: 64},
      transcription: {type: 'duration', usdPerMinute: 0.0045, billingIncrementSeconds: 60},
    }};
  const writeAuthority = (value = authority) => writeFileSync(authorityPath, JSON.stringify(value), {mode: 0o600});
  writeAuthority();
  const portfolioPath = join(directory, 'portfolio.json');
  const writePortfolio = state => writeFileSync(portfolioPath, JSON.stringify({projects:
    [{id: project, name: 'Voice receipt fixture', goal: 'Verify voice billing only', state},
      {id: second, name: 'Separate voice fixture', state: 'active'}]}), {mode: 0o600});
  writePortfolio('active');
  for (const id of [project, second]) store.updateSettings(id, 0, {mode: 'api-only', apiBudgetUsd: 1.25});
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(server, 'listening');
  const wire = [];
  const connections = [];
  let app;
  let cookie;
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await Promise.all([app?.close(), new Promise(resolve => server.close(resolve))]);
    await rm(directory, {recursive: true, force: true});
  });
  server.on('connection', socket => {
    publish(socket, {type: 'session.created', session: {type: 'realtime', model}});
    socket.on('message', bytes => {
      const event = JSON.parse(bytes);
      wire.push(event);
      if (event.type === 'session.update') publish(socket, {type: 'session.updated', session: {...event.session, model}});
      if (event.type === 'input_audio_buffer.commit') {
        publish(socket, {type: 'input_audio_buffer.committed', item_id: inputItem});
      }
      onWire?.(socket, event, {writeAuthority, authority, writePortfolio});
    });
  });
  async function open(enabled = true) {
    await app?.close();
    app = await startOwnerApp({directory, port: 0, codex: {}, apiDevelopment: enabled && {getKey: () => 'fixture-only',
      realtimeConnect(url, options) {
        connections.push(url.href);
        assert.equal(url.href, 'wss://api.openai.com/v1/realtime?model=' + model);
        assert.equal(options.headers['OpenAI-Organization'], 'org-fixture');
        assert.equal(options.headers['OpenAI-Project'], 'proj_fixture');
        return new WebSocket('ws://127.0.0.1:' + server.address().port, options);
      }}});
    const signIn = await readFile(app.signInFile, 'utf8');
    const login = await fetch(app.url + '/api/session', {method: 'POST', redirect: 'manual', headers: {Origin: 'null'},
      body: new URLSearchParams({key: /name="key" value="([a-f0-9]+)"/.exec(signIn)[1]})});
    assert.equal(login.status, 303);
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  await open();
  return {connections, wire, store, authority, writeAuthority, writePortfolio, ledger, directory, open,
    call(path = route, {id, data, auth = true, origin, forProject = project, query = {}} = {}) {
      return fetch(app.url + path + '?' + new URLSearchParams({project: forProject, ...(id ? {id} : {}), ...query}),
        {method: data ? 'POST' : 'GET', headers: {...(auth ? {cookie} : {}),
          ...(data ? {Origin: origin ?? app.url, 'Content-Type': 'application/json'} : {})},
        ...(data ? {body: JSON.stringify(data)} : {})});
    }};
}

async function events(response) {
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  return (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice('data: '.length)));
}

test('signed Realtime readiness and mutations respect project mode, revision, paid balance and stopped state', mac, async t => {
  const f = await fixture(t);
  assert.equal((await f.call(route, {auth: false})).status, 401);
  assert.equal((await f.call(route, {data: request, origin: 'http://other.invalid'})).status, 403);
  const ready = await (await f.call()).json();
  assert.deepEqual(ready, {available: true, route: 'api', model, maxInputSeconds: 10, reservedMicros: 1034900, revision: 1});
  assert.equal((await f.call(route, {data: {...request, revision: 0}})).status, 409);
  assert.equal((await f.call(route, {data: {...request, pcm: pcm + ' '}})).status, 400);
  assert.equal((await f.call(route, {data: {...request, pcm: Buffer.alloc(480002).toString('base64')}})).status, 400);
  f.writeAuthority({...f.authority, credit: {...f.authority.credit, paidBillingEnabled: true}});
  assert.equal((await (await f.call()).json()).reason, 'API_CREDIT_UNVERIFIED');
  assert.equal((await f.call(route, {data: request})).status, 409);
  const {realtimeVoice, ...textAuthority} = f.authority;
  f.writeAuthority(textAuthority);
  assert.equal((await (await f.call()).json()).reason, 'REALTIME_VOICE_AUTHORITY_REQUIRED');
  f.writeAuthority();
  f.store.updateSettings(project, 1, {mode: 'subscription-only'});
  assert.equal((await (await f.call()).json()).reason, 'ROUTE_NOT_ALLOWED');
  assert.equal((await f.call(route, {data: {...request, revision: 2}})).status, 409);
  f.store.updateSettings(project, 2, {mode: 'hybrid', stageRoutes: {consultation: 'subscription'}});
  assert.equal((await (await f.call()).json()).reason, 'ROUTE_NOT_ALLOWED');
  f.store.updateSettings(project, 3, {mode: 'api-only'});
  f.writePortfolio('paused');
  assert.equal((await (await f.call()).json()).reason, 'EXECUTION_HELD');
  assert.equal(f.connections.length, 0);
});

test('text and audio alternate in one signed Realtime archive and share only their verified usage', mac, async t => {
  const text = '  同じ会話を文字で続ける 😺\n';
  const answer = '前の相談と同じ条件で確認しました。';
  const settings = new WeakMap();
  const f = await fixture(t, (socket, event) => {
    if (event.type === 'session.update') settings.set(socket, event.session);
    if (event.type === 'conversation.item.create') confirmContext(socket, event);
    if (event.type !== 'response.create') return;
    if (settings.get(socket).output_modalities[0] === 'text') {
      const keys = {response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0};
      publish(socket, {type: 'response.created', response: {id: responseId}});
      publish(socket, {type: 'response.output_text.delta', ...keys, delta: answer});
      publish(socket, {type: 'response.output_text.done', ...keys, text: answer});
      publish(socket, {type: 'response.done', response: {id: responseId, status: 'completed', usage: textUsage}});
    } else {
      transcript(socket);
      audioResponse(socket);
      done(socket);
    }
  });
  const first = (await events(await f.call(route, {data: request}))).at(-1).turn;
  const session = first.conversationId;
  assert(first.continuationAvailable);
  assert.equal((await f.call(route, {query: {input: 'text'}, auth: false})).status, 401);
  assert.equal((await f.call(route, {query: {input: 'unknown'}})).status, 400);
  const selection = {conversation: session, input: 'text'};
  const ready = await (await f.call(route, {query: selection})).json();
  assert.equal(ready.inputMode, 'text');
  assert.equal(ready.maxInputCharacters, 12000);
  assert.equal(ready.reservedMicros, 1030400);
  assert.equal(ready.contextCount, 2);
  const textRequest = {id: 'typed-turn-fixture', revision: 1, text, continuation: ready.continuation};
  assert.equal((await f.call(route, {data: {...textRequest, pcm}})).status, 400);
  assert.equal((await f.call(route, {data: {...textRequest, text: ' '.repeat(24)}})).status, 400);
  assert.equal((await f.call(route, {data: {...textRequest, text: String.fromCharCode(0xd800)}})).status, 400);
  assert.equal((await f.call(route, {data: {...textRequest, text: 'a'.repeat(12001)}})).status, 400);
  assert.equal((await f.call(route, {data: textRequest, forProject: second})).status, 404);
  assert.equal(f.connections.length, 1);
  const from = f.wire.length;
  const stream = await events(await f.call(route, {data: textRequest}));
  assert.deepEqual(eventTypes(stream), ['started', 'transcript', 'done']);
  const typed = stream.at(-1);
  assert.equal(typed.inputTranscript, text);
  assert.equal(typed.outputTranscript, answer);
  assert.equal(typed.turn.conversationId, session);
  assert.equal(typed.turn.transcription, null);
  assert.equal(typed.turn.accountedMicros, 61);
  assert.deepEqual(eventTypes(f.wire.slice(from)), ['session.update', 'conversation.item.create', 'conversation.item.create',
    'conversation.item.create', 'response.create']);
  const [sessionEvent, ...textWire] = f.wire.slice(from);
  assert.deepEqual(sessionEvent.session.output_modalities, ['text']);
  assert.deepEqual(sessionEvent.session.audio.input, {transcription: null, turn_detection: null});
  assert.deepEqual(textWire[2].item.content, [{type: 'input_text', text}]);
  assert.equal(textWire[2].previous_item_id, textWire[1].item.id);
  await f.open();
  assert.equal((await events(await f.call(route, {data: textRequest}))).at(-1).replayed, true);
  assert.equal((await f.call(route, {data: {...textRequest, text: text.trim()}})).status, 409);
  assert.equal(f.connections.length, 2);
  const audioReady = await (await f.call(route, {query: {conversation: session}})).json();
  assert.equal(audioReady.contextCount, 4);
  assert.equal(audioReady.maxInputSeconds, 10);
  const after = f.wire.length;
  const last = (await events(await f.call(route, {data: {...request, id: 'after-text-voice', continuation: audioReady.continuation}}))).at(-1);
  assert.equal(last.turn.conversationId, session);
  assert.deepEqual(f.wire.slice(after).filter(event => event.type === 'conversation.item.create').slice(-2)
    .map(event => event.item.content[0].text), [text, answer]);
  assert.equal(last.turn.transcription.usage.seconds, 0.1);
  assert.equal((await (await f.call(route, {query: {conversation: session}})).json()).contextCount, 6);
});

test('text rechecks approval after input and retains shared reservations when provider usage is unknown', mac, async t => {
  let revoke = true;
  const f = await fixture(t, (socket, event, {writeAuthority, authority}) => {
    if (event.type === 'conversation.item.create') {
      if (revoke) writeAuthority({...authority, realtimeVoice: {...authority.realtimeVoice, projects: [second]}});
      confirmContext(socket, event);
    }
    if (event.type === 'response.create') {
      publish(socket, {type: 'response.created', response: {id: responseId}});
      socket.close();
    }
  });
  const typed = {id: 'text-approval-fixture', revision: 1, text: '利用可否を確認'};
  const interrupted = (await events(await f.call(route, {data: typed}))).at(-1).turn;
  assert.deepEqual([interrupted.phase, interrupted.reason, interrupted.response, interrupted.transcription, interrupted.accountedMicros],
    ['interrupted', 'REALTIME_VOICE_AUTHORITY_REQUIRED', null, null, 0]);
  assert.deepEqual(eventTypes(f.wire), ['session.update', 'conversation.item.create']);
  assert.equal(f.store.getWork(project).busy, false);
  revoke = false;
  f.writeAuthority();
  const secondTyped = {...typed, id: 'unknown-text-usage'};
  const uncertain = (await events(await f.call(route, {data: secondTyped}))).at(-1).turn;
  assert.equal(uncertain.phase, 'unconfirmed');
  assert.equal(uncertain.accountedMicros, null);
  assert.equal(uncertain.conversationId, null);
  await f.open();
  const restored = (await (await f.call(route, {id: secondTyped.id})).json()).turn;
  assert.deepEqual(restored, uncertain);
  assert.equal(f.store.getWork(project).busy, true);
  assert.equal((await (await f.call(route, {forProject: second, query: {input: 'text'}})).json()).reason,
    'SHARED_CREDIT_INSUFFICIENT');
  assert.equal((await events(await f.call(route, {data: secondTyped}))).at(-1).replayed, true);
  assert.equal(f.connections.length, 2);
});

test('a text turn holds the organization reservation if the provider emits any matching audio', mac, async t => {
  for (const sendsAudio of [true, false]) await t.test(sendsAudio ? 'PCM with text usage' : 'audio tokens without PCM', async t => {
    const f = await fixture(t, (socket, event) => {
      if (event.type === 'conversation.item.create') confirmContext(socket, event);
      if (event.type !== 'response.create') return;
      publish(socket, {type: 'response.created', response: {id: responseId}});
      if (sendsAudio) publish(socket, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantItem,
        output_index: 0, content_index: 0, delta: pcm});
      publish(socket, {type: 'response.done', response: {id: responseId, status: 'completed', usage: sendsAudio ? textUsage : rawUsage}});
    });
    f.writeAuthority({...f.authority, credit: {...f.authority.credit, availableCreditUsd: 4}});
    const data = {id: 'unexpected-audio', revision: 1, text: '文字で確認'};
    const stream = await events(await f.call(route, {data}));
    assert.deepEqual(eventTypes(stream), ['started', 'done']);
    const {turn} = stream.at(-1);
    assert.equal(turn.phase, 'unconfirmed');
    assert.equal(turn.reason, 'REALTIME_TEXT_MODE_UNVERIFIED');
    assert.equal(turn.accountedMicros, null);
    assert.equal(turn.conversationId, null);
    assert.equal(turn.transcription, null);
    assert.equal(turn.response.usage.totalTokens, 7);
    assert.equal(f.store.getWork(project).settledApiMicros, 0);
    await f.open();
    assert.equal((await (await f.call(route, {id: data.id})).json()).turn.reason, turn.reason);
    const other = await (await f.call(route, {forProject: second, query: {input: 'text'}})).json();
    assert.equal(other.reason, 'BUDGET_RECONCILIATION_REQUIRED');
    assert.equal(f.connections.length, 1);
  });
});

test('an unsupported or underpriced model profile cannot send audio or reserve an understated amount', mac, async t => {
  const f = await fixture(t);
  const profile = f.authority.realtimeVoice;
  for (const override of [{model: 'gpt-realtime-2.1'}, {contextTokens: 512},
    {rates: {...profile.rates, inputAudioUsdPerMillion: 31}}, {transcriptionModel: 'whisper-1'},
    {transcription: {...profile.transcription, usdPerMinute: 0.004}},
    {transcription: {...profile.transcription, billingIncrementSeconds: 1}},
    {transcription: {type: 'tokens', maxInputTokens: 1, maxOutputTokens: 1,
      inputTextUsdPerMillion: 1, inputAudioUsdPerMillion: 1, outputTextUsdPerMillion: 1}}]) {
    f.writeAuthority({...f.authority, realtimeVoice: {...profile, ...override}});
    assert.equal((await (await f.call()).json()).reason, 'REALTIME_VOICE_TARIFF_UNVERIFIED');
    const denied = await f.call(route, {data: request});
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).code, 'REALTIME_VOICE_TARIFF_UNVERIFIED');
  }
  assert.equal(f.store.getWork(project).operation, null);
  assert.equal(f.connections.length, 0);
});

test('signed HTTP streams non-silent PCM and saves both receipts without re-dispatch across restart', mac, async t => {
  const f = await fixture(t, (socket, event) => {
    if (event.type !== 'response.create') return;
    audioResponse(socket);
    transcript(socket);
    done(socket);
  });
  const frames = await events(await f.call(route, {data: request}));
  assert.deepEqual(frames.map(frame => frame.type), ['started', 'audio', 'transcript', 'done']);
  const audioDigest = data => createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
  assert.equal(audioDigest(frames[1].pcm), audioDigest(pcm));
  const stored = frames.at(-1);
  assert.equal(f.store.getWork(project, task).operation.reservedMicros, 1034900);
  assert.deepEqual([stored.turn.phase, stored.turn.accountedMicros, stored.turn.response.accountedMicros,
    stored.turn.transcription.accountedMicros], ['completed', 4761, 261, 4500]);
  assert.deepEqual([stored.inputTranscript, stored.outputTranscript], ['予算を確認してください', '使用量を確認しました']);
  assert.match(stored.turn.conversationId ?? '', /^realtime\/[a-f0-9-]{36}$/);
  const wireAudio = f.wire.filter(event => event.type === 'input_audio_buffer.append');
  assert.deepEqual(wireAudio.map(event => audioDigest(event.audio)), [audioDigest(pcm)]);
  assert.equal(f.connections.length, 1);
  const saved = await readFile(f.ledger, 'utf8');
  assert.ok(!saved.includes(pcm) && !saved.includes(stored.inputTranscript) && !saved.includes('fixture-only'));
  await f.open();
  assert.deepEqual(await (await f.call(route, {id: task})).json(), {turn: stored.turn});
  const archive = await (await f.call('/api/chat', {id: stored.turn.conversationId})).json();
  assert.equal(archive.conversation.source, 'openai-realtime');
  assert.deepEqual(archive.conversation.messages.map(({role, text}) => [role, text]),
    [['user', stored.inputTranscript], ['assistant', stored.outputTranscript]]);
  const search = await (await f.call('/api/chat', {query: {q: '使用量を確認しました'}})).json();
  assert.equal(search.conversations[0].id, stored.turn.conversationId);
  assert.equal((await f.call('/api/chat', {id: stored.turn.conversationId, forProject: second})).status, 404);
  assert.equal((await f.call(route, {id: task, forProject: second})).status, 404);
  const replay = await events(await f.call(route, {data: request}));
  assert.deepEqual(replay, [{type: 'done', replayed: true, turn: stored.turn}]);
  assert.equal((await f.call(route, {data: {...request, pcm: Buffer.alloc(4800).toString('base64')}})).status, 409);
  assert.deepEqual(await (await f.call('/api/execution/api')).json(), {operation: null});
  await f.open(false);
  assert.deepEqual(await (await f.call(route, {id: task})).json(), {turn: stored.turn});
  assert.equal((await f.call(route, {id: task, auth: false})).status, 401);
  assert.equal((await f.call(route, {data: request})).status, 409);
  assert.equal((await f.call('/api/chat', {id: stored.turn.conversationId})).status, 200);
  assert.equal(f.connections.length, 1);
});

test('authorization withdrawal on input commit prevents response creation and releases only the verified transcription cost', mac, async t => {
  const f = await fixture(t, (socket, event, {writeAuthority, authority}) => {
    if (event.type !== 'input_audio_buffer.commit') return;
    const {realtimeVoice, ...textOnly} = authority;
    writeAuthority(textOnly);
    transcript(socket);
  });
  const frames = await events(await f.call(route, {data: request}));
  const {turn} = frames.at(-1);
  assert.deepEqual([turn.phase, turn.reason, turn.accountedMicros, turn.response, turn.transcription.itemId],
    ['interrupted', 'REALTIME_VOICE_AUTHORITY_REQUIRED', 4500, null, inputItem]);
  assert.deepEqual(eventTypes(f.wire), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
  assert.equal(f.store.getWork(project).busy, false);
  assert.equal(f.store.getWork(project).settledApiMicros, 4500);
});

test('explicit continuation restores completed roles after restart and appends to the same archive exactly once', mac, async t => {
  const f = await fixture(t, (socket, event) => {
    if (event.type === 'conversation.item.create') confirmContext(socket, event);
    if (event.type !== 'response.create') return;
    audioResponse(socket);
    transcript(socket);
    done(socket);
  });
  const first = (await events(await f.call(route, {data: request}))).at(-1);
  const {conversationId} = first.turn;
  await f.open();
  assert.equal((await f.call(route, {auth: false, query: {conversation: conversationId}})).status, 401);
  assert.equal((await (await f.call(route, {forProject: second, query: {conversation: conversationId}})).json()).reason,
    'REALTIME_VOICE_HISTORY_NOT_FOUND');
  const preview = await (await f.call(route, {query: {conversation: conversationId}})).json();
  assert.equal(preview.contextCount, 2);
  assert.equal(preview.continuation.id, conversationId);
  const firstWireLength = f.wire.length;
  const data = {...request, id: 'continued-voice-fixture', continuation: preview.continuation};
  const followup = (await events(await f.call(route, {data}))).at(-1);
  assert.equal(followup.turn.phase, 'completed');
  assert.equal(followup.turn.conversationId, conversationId);
  const followupWire = f.wire.slice(firstWireLength);
  assert.deepEqual(eventTypes(followupWire), ['session.update', 'conversation.item.create', 'conversation.item.create',
    'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  assert.equal(followupWire[0].session.truncation, 'disabled');
  assert.deepEqual(followupWire.slice(1, 3).map(event => [event.item.role, ...event.item.content.map(content => [content.type, content.text])]),
    [['user', ['input_text', first.inputTranscript]], ['assistant', ['output_text', first.outputTranscript]]]);
  assert.equal(f.store.getWork(project).settledApiMicros, 9522);
  const savedTurn = f.store.getWork(project, data.id).operation;
  assert.equal(savedTurn.realtimeVoice.continuation.id, conversationId);
  assert.match(savedTurn.voiceSettlement.transcriptDigest, /^[a-f0-9]{64}$/);
  const cached = await (await f.call('/api/chat', {id: conversationId})).json();
  assert.equal(cached.conversation.messages.length, 4);
  assert.equal(new Set(cached.conversation.messages.map(message => message.turnId)).size, 2);
  const next = await (await f.call(route, {query: {conversation: conversationId}})).json();
  assert.equal(next.contextCount, 4);
  assert.notEqual(next.continuation.review, preview.continuation.review);
  const stale = await f.call(route, {data: {...data, id: 'stale-voice-fixture'}});
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'REALTIME_VOICE_HISTORY_CHANGED');
  assert.deepEqual(await events(await f.call(route, {data})), [{type: 'done', replayed: true, turn: followup.turn}]);
  assert.equal((await f.call(route, {data: {...data, continuation: next.continuation}})).status, 409);

  editArchive(f, conversationId, messages => { messages[3].text = '他の発言に置き換え'; });
  assert.equal((await (await f.call(route, {query: {conversation: conversationId}})).json()).reason, 'REALTIME_VOICE_HISTORY_UNVERIFIED');
  editArchive(f, conversationId, messages => messages.splice(2));
  assert.equal((await (await f.call(route, {query: {conversation: conversationId}})).json()).reason, 'REALTIME_VOICE_HISTORY_UNVERIFIED');
  assert.equal(f.connections.length, 2);
});

test('legacy transcripts remain readable without replaying an archive that predates transcript receipts', mac, async t => {
  const f = await fixture(t, (socket, event) => {
    if (event.type === 'conversation.item.create') confirmContext(socket, event);
    if (event.type !== 'response.create') return;
    audioResponse(socket);
    transcript(socket);
    done(socket);
  });
  const first = (await events(await f.call(route, {data: request}))).at(-1);
  const {conversationId} = first.turn;
  editArchive(f, conversationId, messages => messages.forEach(message => { delete message.turnId; }));
  const ledger = JSON.parse(await readFile(f.ledger, 'utf8'));
  delete ledger.projects[project].operations[task].voiceSettlement.transcriptDigest;
  writeFileSync(f.ledger, JSON.stringify(ledger));
  await f.open();
  const preview = await (await f.call(route, {query: {conversation: conversationId}})).json();
  assert.equal(preview.reason, 'REALTIME_VOICE_HISTORY_UNVERIFIED');
  const receipt = await (await f.call(route, {id: task})).json();
  assert.equal(receipt.turn.conversationId, conversationId);
  assert.equal(receipt.turn.continuationAvailable, false);
  assert.equal((await f.call('/api/chat', {id: conversationId})).status, 200);
  editArchive(f, conversationId, messages => { messages[0].text = '以前の受付と一致しない本文'; });
  const next = await (await f.call(route, {query: {conversation: conversationId}})).json();
  assert.equal(next.reason, 'REALTIME_VOICE_HISTORY_UNVERIFIED');
  assert.equal(f.connections.length, 1);
});

test('a revoked allowance during transcript reconstruction sends neither another transcript item nor fresh microphone input', mac, async t => {
  const f = await fixture(t, (socket, event, {writeAuthority, authority}) => {
    if (event.type === 'conversation.item.create') {
      const {realtimeVoice, ...textOnly} = authority;
      writeAuthority(textOnly);
      confirmContext(socket, event);
    }
    if (event.type !== 'response.create') return;
    audioResponse(socket);
    transcript(socket);
    done(socket);
  });
  const first = (await events(await f.call(route, {data: request}))).at(-1);
  const {conversationId} = first.turn;
  const preview = await (await f.call(route, {query: {conversation: conversationId}})).json();
  const firstWireLength = f.wire.length;
  const data = {...request, id: 'revoked-voice-history', continuation: preview.continuation};
  const declined = (await events(await f.call(route, {data}))).at(-1).turn;
  assert.equal(declined.reason, 'REALTIME_VOICE_AUTHORITY_REQUIRED');
  assert.equal(declined.accountedMicros, 0);
  assert.deepEqual(eventTypes(f.wire.slice(firstWireLength)), ['session.update', 'conversation.item.create']);
  assert.equal(f.store.getWork(project).busy, false);
  const saved = await (await f.call('/api/chat', {id: conversationId})).json();
  assert.equal(saved.conversation.messages.length, 2);
});

test('history over the bounded input budget remains readable without starting a truncated continuation', mac, async t => {
  const f = await fixture(t, (socket, event) => {
    if (event.type !== 'response.create') return;
    audioResponse(socket, {body: '音'.repeat(7000)});
    transcript(socket);
    done(socket);
  });
  const first = (await events(await f.call(route, {data: request}))).at(-1);
  const {conversationId} = first.turn;
  assert.equal(first.turn.phase, 'completed');
  assert.equal(first.outputTranscript.length, 7000);
  const bound = await (await f.call(route, {query: {conversation: conversationId}})).json();
  assert.equal(bound.reason, 'REALTIME_VOICE_HISTORY_LIMIT');
  assert.equal((await f.call('/api/chat', {id: conversationId})).status, 200);
  assert.equal(f.connections.length, 1);
});

test('a billed follow-up without both final transcripts leaves the old history intact and prevents silent continuation from it', mac, async t => {
  let responses = 0;
  const f = await fixture(t, (socket, event) => {
    if (event.type === 'conversation.item.create') confirmContext(socket, event);
    if (event.type !== 'response.create') return;
    audioResponse(socket, {confirm: ++responses === 1});
    transcript(socket);
    done(socket);
  });
  const first = (await events(await f.call(route, {data: request}))).at(-1);
  const {conversationId} = first.turn;
  const {continuation} = await (await f.call(route, {query: {conversation: conversationId}})).json();
  const data = {...request, id:'voice-with-unconfirmed-final', continuation};
  const second = (await events(await f.call(route, {data}))).at(-1);
  assert.deepEqual([second.turn.phase, second.turn.reason, second.turn.accountedMicros, second.turn.conversationId],
    ['completed', 'REALTIME_VOICE_TRANSCRIPT_UNAVAILABLE', 4761, null]);
  assert.equal(second.outputTranscript, undefined);
  assert.equal(f.store.getWork(project).settledApiMicros, 9522);
  const archive = await (await f.call('/api/chat', {id: conversationId})).json();
  assert.equal(archive.conversation.messages.length, 2);
  assert.equal((await (await f.call(route, {query: {conversation: conversationId}})).json()).reason, 'REALTIME_VOICE_HISTORY_UNVERIFIED');
  assert.equal((await f.call(route, {data: {...data, id: 'voice-cannot-skip-final'}})).status, 409);
  assert.equal(f.connections.length, 2);
});

test('provider disconnect retains the observed response receipt and shared headroom after a real server restart', mac, async t => {
  const f = await fixture(t, (socket, event) => {
    if (event.type !== 'response.create') return;
    audioResponse(socket);
    done(socket);
    socket.close();
  });
  const frames = await events(await f.call(route, {data: request}));
  const {turn} = frames.at(-1);
  assert.deepEqual([turn.phase, turn.accountedMicros, turn.response.id, turn.response.accountedMicros, turn.transcription],
    ['unconfirmed', null, responseId, 261, null]);
  await f.open();
  assert.deepEqual(await (await f.call(route, {id: task})).json(), {turn});
  assert.equal(f.store.getWork(project).busy, true);
  assert.equal((await (await f.call()).json()).reason, 'PROJECT_BUSY');
  assert.equal((await (await f.call(route, {forProject: second})).json()).reason, 'SHARED_CREDIT_INSUFFICIENT');
  assert.equal((await f.call(route, {data: {...request, id: 'new-voice-id'}})).status, 409);
  assert.deepEqual(await events(await f.call(route, {data: request})), [{type: 'done', replayed: true, turn}]);
  assert.equal(f.connections.length, 1);
});

test('signed interruption cancels the exact provider response, discards late playback and settles both receipts', mac, async t => {
  const audioStarted = Promise.withResolvers();
  const f = await fixture(t, (socket, event) => {
    if (event.type === 'response.create') {
      audioResponse(socket);
      transcript(socket);
      audioStarted.resolve();
    } else if (event.type === 'response.cancel') {
      publish(socket, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantItem, content_index: 0, delta: pcm});
      done(socket, 'cancelled');
    } else if (event.type === 'conversation.item.truncate') {
      publish(socket, {...event, type: 'conversation.item.truncated'});
    }
  });
  const reading = f.call(route, {data: request});
  await audioStarted.promise;
  const interruption = await f.call(route + '/interrupt', {data: {id: task, heardMs: 25}});
  assert.equal(interruption.status, 202);
  const frames = await events(await reading);
  assert.equal(frames.filter(frame => frame.type === 'audio').length, 1);
  assert.deepEqual(f.wire.find(event => event.type === 'response.cancel'), {type: 'response.cancel', response_id: responseId});
  assert.deepEqual(f.wire.find(event => event.type === 'conversation.item.truncate'),
    {type: 'conversation.item.truncate', item_id: assistantItem, content_index: 0, audio_end_ms: 25});
  assert.deepEqual([frames.at(-1).turn.phase, frames.at(-1).turn.accountedMicros], ['interrupted', 4761]);
});

test('an unpriced transcription receipt is preserved and places an organization-wide reconciliation hold', mac, async t => {
  const f = await fixture(t, (socket, event) => {
    if (event.type !== 'response.create') return;
    audioResponse(socket);
    transcript(socket, {type: 'tokens', total_tokens: 3, input_tokens: 2, output_tokens: 1,
      input_token_details: {text_tokens: 0, audio_tokens: 2}});
    done(socket);
  });
  const result = (await events(await f.call(route, {data: request}))).at(-1).turn;
  assert.deepEqual([result.phase, result.accountedMicros, result.transcription.usage.type, result.transcription.accountedMicros],
    ['unconfirmed', null, 'tokens', null]);
  assert.equal((await (await f.call(route, {forProject: second})).json()).reason, 'BUDGET_RECONCILIATION_REQUIRED');
});
