import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
const rawUsage = {total_tokens: 7, input_tokens: 4, output_tokens: 3,
  input_token_details: {text_tokens: 2, audio_tokens: 2, cached_tokens: 1,
    cached_tokens_details: {text_tokens: 1, audio_tokens: 0}}, output_token_details: {text_tokens: 0, audio_tokens: 3}};
const publish = (socket, event) => socket.send(JSON.stringify(event));
const eventTypes = wire => wire.map(event => event.type);
function transcript(socket, usage = {type: 'duration', seconds: 0.1}) {
  publish(socket, {type: 'conversation.item.input_audio_transcription.completed', item_id: inputItem, content_index: 0,
    transcript: '予算を確認してください', usage});
}
function audioResponse(socket) {
  publish(socket, {type: 'response.created', response: {id: responseId}});
  publish(socket, {type: 'response.output_audio.delta', response_id: responseId, item_id: assistantItem, content_index: 0, delta: pcm});
  publish(socket, {type: 'response.output_audio_transcript.delta', response_id: responseId, item_id: assistantItem,
    content_index: 0, delta: '使用量を確認しました'});
}
function done(socket, status = 'completed') {
  publish(socket, {type: 'response.done', response: {id: responseId, status, usage: rawUsage}});
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
  async function open() {
    await app?.close();
    app = await startOwnerApp({directory, port: 0, codex: {}, apiDevelopment: {getKey: () => 'fixture-only',
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
  return {connections, wire, store, authority, writeAuthority, writePortfolio, ledger, open,
    call(path = route, {id, data, auth = true, origin, forProject = project} = {}) {
      return fetch(app.url + path + '?' + new URLSearchParams({project: forProject, ...(id ? {id} : {})}),
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
  assert.deepEqual(ready, {available: true, route: 'api', model, maxInputSeconds: 10, revision: 1});
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
  const wireAudio = f.wire.filter(event => event.type === 'input_audio_buffer.append');
  assert.deepEqual(wireAudio.map(event => audioDigest(event.audio)), [audioDigest(pcm)]);
  assert.equal(f.connections.length, 1);
  const saved = await readFile(f.ledger, 'utf8');
  assert.ok(!saved.includes(pcm) && !saved.includes(stored.inputTranscript) && !saved.includes('fixture-only'));
  await f.open();
  assert.deepEqual(await (await f.call(route, {id: task})).json(), {turn: stored.turn});
  assert.equal((await f.call(route, {id: task, forProject: second})).status, 404);
  const replay = await events(await f.call(route, {data: request}));
  assert.deepEqual(replay, [{type: 'done', replayed: true, turn: stored.turn}]);
  assert.equal((await f.call(route, {data: {...request, pcm: Buffer.alloc(4800).toString('base64')}})).status, 409);
  assert.deepEqual(await (await f.call('/api/execution/api')).json(), {operation: null});
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
