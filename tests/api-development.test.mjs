import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import WebSocket, {WebSocketServer} from 'ws';
import {startOwnerApp} from '../app/server.mjs';
import {apiAuthorityFile} from '../app/api-authority.mjs';
import {createChatStore} from '../app/chat-store.mjs';
import {ExecutionStore} from '../app/execution-store.mjs';

const instruction = {id: 'api-fixture-task', prompt: '答えを2にする', stage: 'implementation'};
const id = 'api-fixture';
const modelId = 'fixture-model-2026-11-27';

async function authenticatedRequests(app) {
  const signIn = await readFile(app.signInFile, 'utf8');
  const login = await fetch(app.url + '/api/session', {method: 'POST', redirect: 'manual', headers: {Origin: 'null'},
    body: new URLSearchParams({key: /name="key" value="([a-f0-9]+)"/.exec(signIn)[1]})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return (path, {data, project = id, query = {}, auth = true, origin = app.url} = {}) =>
    fetch(app.url + path + '?' + new URLSearchParams({project, ...query}), {method: data ? 'POST' : 'GET',
      headers: {...(auth ? {cookie} : {}), ...(data ? {Origin: origin, 'Content-Type': 'application/json'} : {})},
      ...(data ? {body: JSON.stringify(data)} : {})});
}

async function fixture(t, fetchImpl, {handover = false, auxiliary = [], codex = {}, realtimeConnect, verifyInSandbox, tailnet} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hq-api-app-')));
  let app, requests;
  const servers = new Set();
  t.after(async () => {
    await Promise.all([...servers].map(server => server.close()));
    await rm(directory, {recursive: true, force: true});
  });
  const checkout = join(directory, 'workspaces', id);
  await mkdir(checkout, {recursive: true, mode: 0o700});
  await writeFile(join(checkout, '.hq-owned-workspace'), id, {mode: 0o600});
  const source = join(checkout, 'source.mjs');
  await writeFile(source, 'export const answer = 1;\n');
  const requirements = join(checkout, 'GOAL.md');
  if (handover) await writeFile(requirements, '# 受入条件\n既存機能を維持し、答えを2にする。\n');
  for (const path of auxiliary) await writeFile(join(checkout, path), 'export const testFlag = false;\n');
  await writeFile(join(checkout, 'check.test.mjs'), `import assert from 'node:assert/strict';
import test from 'node:test';
import {answer} from './source.mjs';
test('answer equals the required value', () => assert.equal(answer, 2));\n`);
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', checkout, ...args], {env: {...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid'}, stdio: 'ignore'});
  git('init', '--quiet');
  git('add', '--', 'source.mjs', 'check.test.mjs', ...auxiliary);
  if (handover) git('add', '--', 'GOAL.md');
  git('commit', '--quiet', '-m', 'Fixture initial files');
  const portfolio = join(directory, 'portfolio.json');
  await writeFile(portfolio, JSON.stringify({projects: [
    {id, name: 'API fixture', state: 'unknown', cwd: checkout, goal: '答えを2にする', enableCodexWrite: codex.canWrite === true,
      ...(handover ? {handoverRequirements: 'GOAL.md'} : {})},
    {id: 'other-fixture', name: 'Another isolated fixture', state: 'unknown'},
  ]}), {mode: 0o600});
  const ledgerFile = join(directory, 'execution-policy.json');
  const store = new ExecutionStore(ledgerFile, {authorityId: 'personal-ai-hq-local'});
  const ledgerBinding = store.initializeReservationAuthority();
  const observedAt = new Date().toISOString();
  await writeFile(join(directory, apiAuthorityFile), JSON.stringify({version: 1, organization: 'org-fixture', providerProject: 'proj_fixture',
    reservationAuthorityId: store.authorityId, ledgerBinding,
    defaultModel: modelId, credit: {organization: 'org-fixture', observedAt, safeUntil: new Date(Date.now() + 300000).toISOString(),
      availableCreditUsd: 2, checkoutConfirmed: true, purchasedCreditUsd: 0, paidBillingEnabled: false, autoRechargeEnabled: false},
    models: [{id: modelId, contextTokens: 16000, outputTokens: 2000, inputUsdPerMillion: 2, outputUsdPerMillion: 8, reasoningEfforts: []}],
    projects: {[id]: {files: [{path: 'source.mjs', writable: true}], testPaths: ['check.test.mjs']}},
    ...(realtimeConnect ? {realtimeVoice: {projects: [id], model: 'gpt-realtime-1.5', voice: 'marin', transcriptionModel: 'gpt-transcribe',
      contextTokens: 32000, maxInputSeconds: 10, maxOutputTokens: 100, rates: {inputTextUsdPerMillion: 4,
        inputAudioUsdPerMillion: 32, cachedTextUsdPerMillion: 0.4, cachedAudioUsdPerMillion: 0.4,
        outputTextUsdPerMillion: 16, outputAudioUsdPerMillion: 64},
      transcription: {type: 'duration', usdPerMinute: 0.0045, billingIncrementSeconds: 60}}} : {}),
  }), {mode: 0o600});
  async function open(enableExecution) {
    await app?.close();
    servers.delete(app);
    app = await startOwnerApp({directory, port: 0, codex, tailnet, apiDevelopment: enableExecution && {
      getKey: () => 'fixture-only', fetchImpl, realtimeConnect, verifyInSandbox,
    }});
    servers.add(app);
    requests = await authenticatedRequests(app);
  }
  await open(true);
  async function openReader() {
    const reader = await startOwnerApp({directory, port: 0, codex: {}});
    servers.add(reader);
    return authenticatedRequests(reader);
  }
  const commitFiles = async changes => {
    for (const change of changes) await writeFile(join(checkout, change.path), change.text);
    git('add', '--', ...changes.map(change => change.path));
    git('commit', '--quiet', '-m', 'Fixture checkout change');
  };
  const commitSource = text => commitFiles([{path: 'source.mjs', text}]);
  return {call: (...args) => requests(...args), source, requirements, portfolio, directory, store, ledgerFile, commitFiles, commitSource, open, openReader,
    get tailnetTarget() { return app.tailnetTarget; }};
}

async function waitFor(call, target, taskId = instruction.id) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const {operation} = await (await call('/api/execution/api', {query: {id: taskId}})).json();
    if (operation?.phase === target) return operation;
    if (['completed', 'failed', 'interrupted', 'unconfirmed'].includes(operation?.phase)) assert.equal(operation.phase, target, JSON.stringify(operation));
    await wait(40);
  }
  assert.fail('Timed out waiting for API job');
}

const dispatchPath = '/api/execution/dispatch';

function dispatchCodex(sends, beforeCatalog = () => {}) {
  return {canWrite: true, subscriptionReady: async () => true,
    async models() {
      beforeCatalog();
      return {accountType: 'chatgpt', data: [{id: 'fixture-codex', isDefault: true, reasoningEfforts: []}]};
    },
    usage: async () => ({observedAt: new Date().toISOString(), ordinaryUsageAllowed: true, windows: [{usedPercent: 20}]}),
    async submit(input) {
      assert.equal(input.beforeThread(), true);
      await input.beforeTurn();
      assert.equal(input.onThread('dispatch-fixture-thread'), true);
      sends.push(input.requestId);
      return {turn: {id: 'dispatch-fixture-turn', status: 'completed'}};
    }};
}

async function waitForDispatch(call, id, expected = 'completed') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const reply = await call(dispatchPath, {query: {id}});
    assert.equal(reply.status, 200);
    const result = await reply.json();
    if (result.operation?.phase === expected) return result;
    if (['completed', 'failed', 'interrupted', 'unconfirmed'].includes(result.operation?.phase)) {
      assert.equal(result.operation.phase, expected);
    }
    await wait(20);
  }
  assert.fail('Project dispatch did not reach the expected phase');
}

test('project-selected dispatch uses only authorized fallback and preserves the subscription receipt', {skip: process.platform !== 'darwin'}, async t => {
  let providerCalls = 0;
  const nativeSends = [];
  const {call, open} = await fixture(t, () => { providerCalls++; return providerAnswer(2); }, {codex:dispatchCodex(nativeSends)});
  const set = (revision, settings) => call('/api/execution/settings', {data: {revision, settings}});
  const send = (data = instruction) => call(dispatchPath, {data});
  const read = () => call(dispatchPath, {query: {id: instruction.id}});
  await open(false);
  assert.equal((await call(dispatchPath, {data: instruction, auth: false})).status, 401);
  assert.equal((await call(dispatchPath, {query: {id: instruction.id}, auth: false})).status, 401);
  assert.equal((await set(0, {mode: 'auto', preference: 'api-first', allowFallback: false})).status, 200);
  assert.equal((await send()).status, 409);
  assert.equal((await set(1, {mode: 'api-only', apiBudgetUsd: 1})).status, 200);
  assert.equal((await send()).status, 409);
  assert.equal((await send({...instruction, route: 'subscription'})).status, 409);
  assert.deepEqual(await (await read()).json(), {route: null, operation: null});
  assert.deepEqual(nativeSends, []);

  assert.equal((await set(2, {mode: 'auto', preference: 'api-first', allowFallback: true, apiBudgetUsd: 1})).status, 200);
  assert.equal((await send({...instruction, route: 'api'})).status, 409);
  const submitted = await send();
  assert.equal(submitted.status, 202);
  assert.equal((await submitted.json()).fallback, true);
  const completed = await waitForDispatch(call, instruction.id);
  assert.equal(completed.route, 'subscription');
  assert.equal(completed.operation.id, instruction.id);
  assert.equal(completed.operation.threadId, 'dispatch-fixture-thread');

  await open(true);
  assert.equal((await set(3, {mode: 'api-only', apiBudgetUsd: 1})).status, 200);
  const replay = await send();
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), completed);
  assert.deepEqual(await (await read()).json(), completed);
  assert.equal((await send({...instruction, route: 'api'})).status, 409);
  assert.equal((await send({...instruction, prompt: 'Changed intent'})).status, 409);
  const separate = {id: 'native-history-next', prompt: 'Follow the previous work'};
  const blocked = await send(separate);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /照合/u);
  assert.deepEqual(await (await call(dispatchPath, {query: {id: separate.id}})).json(), {route: null, operation: null});
  assert.deepEqual(nativeSends, [instruction.id]);
  assert.equal(providerCalls, 0);
});

test('project-selected dispatch uses approved API once and reads it after settings and availability change', {skip: process.platform !== 'darwin'}, async t => {
  let providerCalls = 0;
  const nativeSends = [];
  const {call, open} = await fixture(t, () => { providerCalls++; return providerAnswer(2); }, {codex:dispatchCodex(nativeSends)});
  const set = (revision, settings) => call('/api/execution/settings', {data: {revision, settings}});
  const send = (data = instruction) => call(dispatchPath, {data});
  assert.equal((await set(0, {mode: 'auto', preference: 'api-first', allowFallback: true, apiBudgetUsd: 1})).status, 200);
  const concurrent = await Promise.all([send(), send()]);
  assert.deepEqual(concurrent.map(response => response.status), [202, 202]);
  for (const response of concurrent) {
    const body = await response.json();
    assert.equal(body.route, 'api');
    assert.equal(body.operation.id, instruction.id);
  }
  const completed = await waitForDispatch(call, instruction.id);
  assert.equal(completed.route, 'api');
  assert.equal(completed.operation.artifactCount, 1);
  assert.equal(completed.operation.verification.passed, true);
  assert.equal((await set(1, {mode: 'subscription-only'})).status, 200);
  await open(false);
  const replay = await send();
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), completed);
  assert.equal((await send({...instruction, route: 'subscription'})).status, 409);
  assert.equal((await send({...instruction, prompt: 'Changed intent'})).status, 409);
  const query = {id: instruction.id};
  assert.deepEqual(await (await call(dispatchPath, {query})).json(), completed);
  assert.deepEqual(await (await call(dispatchPath, {query, project: 'other-fixture'})).json(), {route: null, operation: null});
  const blocked = await send({id: 'api-history-next', prompt: 'Follow the previous work'});
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /照合/u);
  assert.equal(providerCalls, 1);
  assert.deepEqual(nativeSends, []);
});

test('project-selected dispatch preserves an unconfirmed API operation without falling back', {skip: process.platform !== 'darwin'}, async t => {
  let providerCalls = 0;
  const nativeSends = [];
  const {call, open, store} = await fixture(t, () => { providerCalls++; throw new Error('Fixture transport broke after send'); },
    {codex:dispatchCodex(nativeSends)});
  const send = (data = instruction) => call(dispatchPath, {data});
  assert.equal((await call('/api/execution/settings', {data: {revision: 0,
    settings: {mode: 'auto', preference: 'api-first', allowFallback: true, apiBudgetUsd: 1}}})).status, 200);
  assert.equal((await send()).status, 202);
  const unconfirmed = await waitForDispatch(call, instruction.id, 'unconfirmed');
  assert.equal(unconfirmed.route, 'api');
  assert.ok(store.getWork(id).busy);
  await open(false);
  const replay = await send();
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), unconfirmed);
  assert.equal((await send({...instruction, route: 'subscription'})).status, 409);
  assert.equal((await send({...instruction, id: 'unknown-effect-next'})).status, 409);
  assert.equal(providerCalls, 1);
  assert.deepEqual(nativeSends, []);
});

test('project-selected dispatch rejects a policy revision changed during capability checking', {skip: process.platform !== 'darwin'}, async t => {
  const nativeSends = [];
  let changeSettings;
  const {call, store, open} = await fixture(t, () => assert.fail('No provider should run'),
    {codex:dispatchCodex(nativeSends, () => changeSettings?.())});
  await open(false);
  changeSettings = () => store.updateSettings(id, 0, {mode: 'subscription-only'});
  const response = await call(dispatchPath, {data: instruction});
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /設定/u);
  assert.deepEqual(nativeSends, []);
  assert.deepEqual(await (await call(dispatchPath, {query: {id: instruction.id}})).json(), {route: null, operation: null});
});

function remoteDispatchRequest(target, tailnet, path, {data, cookie} = {}) {
  assert.equal(new URL(target).hostname, '127.0.0.1');
  const host = new URL(tailnet.origin).host;
  const body = data && JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const outgoing = request(target + path, {method: body ? 'POST' : 'GET', agent: false,
      headers: {Host: host, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': tailnet.login,
        ...(cookie && {Cookie: cookie}), ...(body && {Origin: tailnet.origin, 'Content-Type': 'application/json'})}}, async response => {
      try {
        let text = '';
        for await (const chunk of response) text += chunk;
        resolve({status: response.statusCode, headers: response.headers, data: JSON.parse(text)});
      } catch (error) { reject(error); }
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Local proxy fixture timed out')));
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

test('project-selected dispatch cancels an API reservation revoked through the remote owner session', {skip: process.platform !== 'darwin'}, async t => {
  const tailnet = {origin: 'https://workstation.example.ts.net', login: 'owner@example.invalid', port: 0};
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let providerCalls = 0;
  const env = await fixture(t, () => { providerCalls++; return providerAnswer(2); }, {tailnet,
    async verifyInSandbox() {
      entered.resolve(true);
      await release.promise;
      return {passed: true, exitCode: 0, output: 'Fixture workspace verified'};
    }});
  const {call, store} = env;
  const remote = (path, options) => remoteDispatchRequest(env.tailnetTarget, tailnet, path, options);
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  const pair = await call('/api/access/pair', {data: {}});
  assert.equal(pair.status, 200);
  const {code} = await pair.json();
  const signed = await remote('/api/access/redeem', {data: {code}});
  assert.equal(signed.status, 200);
  const cookie = signed.headers['set-cookie'][0].split(';')[0];
  const route = dispatchPath + '?project=' + id;
  try {
    const accepted = await remote(route, {data: instruction, cookie});
    assert.equal(accepted.status, 202);
    assert.equal(accepted.data.route, 'api');
    assert.ok(await Promise.race([entered.promise, wait(2000, false, {ref: false})]));
    assert.equal(store.getWork(id, instruction.id).operation.status, 'reserved');
    assert.equal((await call('/api/access/revoke', {data: {}})).status, 200);
    assert.equal((await remote(route + '&id=' + instruction.id, {cookie})).status, 401);
  } finally { release.resolve(); }
  const {operation} = await waitForDispatch(call, instruction.id, 'interrupted');
  assert.equal(operation.result, 'SIGN_IN_REQUIRED');
  assert.equal(operation.startedAt, null);
  assert.equal(providerCalls, 0);
  const work = store.getWork(id, instruction.id);
  assert.equal(work.operation.status, 'cancelled');
  assert.equal(work.busy, false);
  assert.equal(work.settledApiMicros, 0);
});

test('project-selected dispatch rechecks workspace scope when a native receipt read finishes', {skip: process.platform !== 'darwin'}, async t => {
  t.mock.timers.enable({apis: ['Date']});
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const nativeSends = [];
  const codex = dispatchCodex(nativeSends);
  const originalSubmit = codex.submit;
  codex.submit = async input => {
    const result = await originalSubmit(input);
    return {turn: {...result.turn, status: 'inProgress'}};
  };
  codex.findSubmission = async (_workspace, thread, clientId, turnId) => {
    assert.deepEqual([thread, clientId, turnId], ['dispatch-fixture-thread', instruction.id, 'dispatch-fixture-turn']);
    entered.resolve(true);
    await release.promise;
    return {id: turnId, status: 'completed'};
  };
  const {call, portfolio} = await fixture(t, () => assert.fail('No API provider should run'), {codex});
  assert.equal((await call(dispatchPath, {data: instruction})).status, 202);
  await waitForDispatch(call, instruction.id, 'running');
  t.mock.timers.tick(16_000);
  const pending = call(dispatchPath, {query: {id: instruction.id}});
  try {
    assert.ok(await Promise.race([entered.promise, wait(2000, false, {ref: false})]));
    const directory = JSON.parse(await readFile(portfolio, 'utf8'));
    delete directory.projects.find(project => project.id === id).cwd;
    await writeFile(portfolio, JSON.stringify(directory));
  } finally { release.resolve(); }
  assert.equal((await pending).status, 404);
  assert.deepEqual(nativeSends, [instruction.id]);
});

test('the checked Codex result anchors a Realtime conversation without changing the existing development checkpoint',
  {skip: process.platform !== 'darwin', timeout: 20000}, async t => {
  const operationId = 'approved-codex-voice-fixture';
  const threadId = 'voice-handoff-thread';
  const turnId = 'v';
  const prompt = '引き継いだ成果を確認して助言を残す';
  const codexAnswer = '  テストは検証済みです。\n';
  const messages = [{id: 'fixture-user', role: 'user', text: prompt},
    {id: 'fixture-answer', role: 'assistant', text: codexAnswer}];
  const model = 'gpt-realtime-1.5';
  const route = '/api/chat/realtime';
  let reads = 0;
  let mismatchedRead;
  let beforeSessionReady;
  let beforeHistoryAck;
  const codex = {canWrite: true, subscriptionReady: async () => true, onEvent: () => () => {},
    models: async () => ({accountType: 'chatgpt', data: [{id: 'fixture-codex', isDefault: true, reasoningEfforts: []}]}),
    usage: async () => ({observedAt: new Date().toISOString(), ordinaryUsageAllowed: true, windows: [{usedPercent: 20}]}),
    async submit(options) {
      assert.equal(options.beforeThread(), true);
      await options.beforeTurn?.();
      assert.equal(options.onThread(threadId), true);
      return {turn: {id: turnId, status: 'completed'}};
    },
    async readHandoverTurn(_checkout, thread, turn, operation) {
      assert.deepEqual([thread, turn, operation], [threadId, turnId, operationId]);
      return {threadId, turnId, messages: ++reads === mismatchedRead ? messages.slice(0, 1) : messages};
    }};
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const wires = [];
  const pcm = Buffer.alloc(4800, 7).toString('base64');
  server.on('connection', socket => {
    const events = [];
    wires.push(events);
    const responseId = 'resp_fixture_' + wires.length;
    const inputId = 'item_input_' + wires.length;
    const outputId = 'item_output_' + wires.length;
    const send = event => socket.send(JSON.stringify(event));
    send({type:'session.created', session:{model}});
    socket.on('message', bytes => {
      const event = JSON.parse(bytes);
      events.push(event);
      if (event.type === 'session.update') {
        beforeSessionReady?.();
        send({type:'session.updated', session:{...event.session, model}});
      }
      if (event.type === 'conversation.item.create') {
        beforeHistoryAck?.();
        send({type:'conversation.item.done', previous_item_id:event.previous_item_id ?? null, item:{...event.item,status:'completed'}});
      }
      if (event.type === 'input_audio_buffer.commit') {
        send({type:'input_audio_buffer.committed', item_id:inputId});
        send({type:'conversation.item.input_audio_transcription.completed', item_id:inputId, content_index:0,
          usage:{type:'duration',seconds:0.1}, transcript:'今回の音声の指示'});
      }
      if (event.type === 'response.create') {
        send({type:'response.created', response:{id:responseId}});
        send({type:'response.output_audio.delta', response_id:responseId,item_id:outputId,output_index:0,content_index:0,delta:pcm});
        send({type:'response.output_audio_transcript.done', response_id:responseId,item_id:outputId,output_index:0,content_index:0,
          transcript:'今回の音声の回答'});
        send({type:'response.done', response:{id:responseId,status:'completed',usage:{total_tokens:22,input_tokens:20,output_tokens:2,
          input_token_details:{text_tokens:15,audio_tokens:5,cached_tokens:0},output_token_details:{text_tokens:0,audio_tokens:2}}}});
      }
    });
  });
  const f = await fixture(t, () => providerAnswer(2), {codex, handover:true,
    realtimeConnect(url, options) {
      assert.equal(url.href, 'wss://api.openai.com/v1/realtime?model=' + model);
      return new WebSocket('ws://127.0.0.1:' + server.address().port, options);
    }});
  const {call, store, source, requirements, portfolio} = f;
  const switchTo = (revision, mode) => call('/api/execution/settings', {data:{revision, settings:{mode, apiBudgetUsd:1.6}}});
  assert.equal((await switchTo(0, 'api-only')).status, 200);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  await waitFor(call, 'completed');
  const before = store.getWork(id);
  const receipt = before.checkpointOperation.executionId;
  const applied = 'export const answer = 2;\n';
  await f.commitSource(applied);
  assert.equal((await switchTo(1, 'subscription-only')).status, 200);
  const subscribed = await (await call('/api/execution/handover', {query:{receipt}})).json();
  assert.equal(subscribed.verified, true);
  const accepted = await call('/api/codex/run', {data:{id:operationId,prompt,stage:'implementation',route:'subscription',
    handover:{receipt,review:subscribed.review}}});
  assert.equal(accepted.status, 202);
  let turn;
  for (let index = 0; index < 40 && turn?.phase !== 'completed'; index++) {
    turn = (await (await call('/api/codex/run', {query:{id:operationId}})).json()).operation;
    if (turn?.phase !== 'completed') await wait(25);
  }
  assert.equal(turn?.phase, 'completed');
  assert.equal(turn.handoverReceipt, receipt);
  assert.equal((await switchTo(2, 'api-only')).status, 200);
  const voiceReady = (turn = turnId) => call(route, {query:{thread:threadId,turn}});
  assert.equal((await (await voiceReady()).json()).reason, 'NATIVE_HANDOVER_CHECKPOINT_REQUIRED');
  assert.equal((await (await call(route)).json()).reason, 'HANDOVER_REQUIRED');
  const git = (...args) => execFileSync('/usr/bin/git', ['-C',dirname(source),...args], {encoding:'utf8'}).trim();
  const verificationText = 'Owner fixture: Git and native transcript verified.\n';
  await f.commitFiles([{path:'verification.md',text:verificationText}]);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const checkpoint = {version:1,operationId,threadId,turnId,checkoutHead:git('rev-parse','HEAD'),
    requirementsSha256:sha(await readFile(requirements)),transcriptSha256:sha(JSON.stringify(messages)),
    artifacts:[{path:'source.mjs',sha256:sha(applied)}],verification:{path:'verification.md',sha256:sha(verificationText)},
    effectsReconciled:true,shareConversation:true};
  const definition = JSON.parse(await readFile(portfolio));
  const setCheckpoint = value => {
    definition.projects[0].nativeHandover = value;
    return writeFile(portfolio, JSON.stringify(definition));
  };
  await setCheckpoint(checkpoint);
  const found = await (await voiceReady()).json();
  assert.deepEqual([found.available,found.nativeContextCount,found.contextCount,found.nativeOrigin.operationId],[true,2,2,operationId]);
  assert.equal(found.nativeTurnId, turnId);
  assert.equal((await call(route, {query:{thread:threadId}})).status, 400);
  const staleTurn = await (await voiceReady('stale-displayed-native-turn')).json();
  assert.deepEqual(staleTurn, {available:false,reason:'HANDOVER_RECEIPT_STALE'});
  assert.equal(JSON.stringify(found).includes(prompt), false);
  assert.equal(JSON.stringify(found).includes(codexAnswer.trim()), false);
  const plainReceipt = await (await call('/api/execution/handover', {query:{thread:threadId}})).json();
  const body = {id:'native-result-voice-turn',revision:found.revision,pcm,nativeOrigin:found.nativeOrigin};
  const post = data => call(route, {data});
  const typedPreview = await (await call(route, {query:{thread:threadId,turn:turnId,input:'text'}})).json();
  assert.equal(typedPreview.inputMode, 'text');
  assert.equal(typedPreview.nativeTurnId, turnId);
  assert.equal(typedPreview.nativeContextCount, found.nativeContextCount);
  assert.notEqual(typedPreview.nativeOrigin.review, found.nativeOrigin.review);
  assert.equal((await post({...body,nativeOrigin:typedPreview.nativeOrigin})).status, 409);
  assert.equal((await post({id:body.id,revision:body.revision,text:'文字で続ける',nativeOrigin:found.nativeOrigin})).status, 409);
  assert.equal((await post({...body,nativeOrigin:{...found.nativeOrigin,review:plainReceipt.review}})).status, 409);
  const authorityPath = join(f.directory, apiAuthorityFile);
  const authority = JSON.parse(await readFile(authorityPath));
  await writeFile(authorityPath, JSON.stringify({...authority,providerProject:'different_provider_project'}));
  const changedProvider = await post(body);
  assert.equal(changedProvider.status, 409);
  assert.match((await changedProvider.json()).error, /引継ぎを照合/);
  await writeFile(authorityPath, JSON.stringify(authority));
  const other = await call(route, {query:{thread:threadId,turn:turnId},project:'other-fixture'});
  assert.equal(other.status, 200);
  assert.equal((await other.json()).available, false);
  assert.equal((await post({...body,nativeOrigin:undefined})).status, 409);
  await setCheckpoint({...checkpoint,shareConversation:false});
  assert.equal((await post(body)).status, 409);
  await setCheckpoint(checkpoint);
  await writeFile(source, 'Unverified checkout content.\n');
  assert.equal((await (await voiceReady()).json()).reason, 'NATIVE_HANDOVER_GIT_CHANGED');
  await writeFile(source, applied);
  assert.equal(wires.length, 0);
  const sse = async response => {
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    return JSON.parse((await response.text()).trim().split('\n\n').at(-1).slice('data: '.length));
  };
  mismatchedRead = reads + 2;
  const changed = (await sse(await post({...body,id:'voice-native-readback-changed'}))).turn;
  assert.equal(changed.phase, 'cancelled');
  assert.equal(changed.reason, 'HANDOVER_CONVERSATION_UNVERIFIED');
  assert.equal(wires.length, 0);
  beforeSessionReady = () => {
    beforeSessionReady = undefined;
    mismatchedRead = reads + 1;
  };
  const changedAfterConnect = (await sse(await post({...body,id:'voice-native-after-connect-changed'}))).turn;
  assert.equal(changedAfterConnect.reason, 'HANDOVER_CONVERSATION_UNVERIFIED');
  assert.equal(changedAfterConnect.accountedMicros, 0);
  assert.deepEqual(wires[0].map(event => event.type), ['session.update']);
  beforeHistoryAck = () => {
    beforeHistoryAck = undefined;
    definition.projects[0].nativeHandover = {...checkpoint,shareConversation:false};
    writeFileSync(portfolio, JSON.stringify(definition));
  };
  const revoked = (await sse(await post({...body,id:'voice-native-revoked'}))).turn;
  assert.equal(revoked.reason, 'NATIVE_HANDOVER_CHECKPOINT_REQUIRED');
  assert.equal(revoked.accountedMicros, 0);
  assert.deepEqual(wires[1].map(event => event.type), ['session.update','conversation.item.create']);
  await setCheckpoint(checkpoint);
  const [first, duplicate] = await Promise.all([post(body).then(sse), post(body).then(sse)]);
  const alternate = [first, duplicate].find(event => event.replayed !== true);
  assert.equal([first,duplicate].filter(event => event.replayed === true).length, 1);
  assert.equal(alternate.turn.phase, 'completed');
  const archive = alternate.turn.conversationId;
  const contextOf = wire => wire.filter(event => event.type === 'conversation.item.create')
    .map(event => [event.item.role,event.item.content[0].text]);
  assert.deepEqual(contextOf(wires[2]), [['user',prompt],['assistant',codexAnswer]]);
  assert.equal(JSON.stringify(wires[2]).includes('verification.md'), false);
  const stored = store.getWork(id);
  assert.deepEqual(stored.checkpoint, before.checkpoint);
  assert.equal(stored.checkpointOperation.executionId, receipt);
  assert.equal(stored.settledApiMicros, before.settledApiMicros + alternate.turn.accountedMicros);
  await f.open(true);
  const continued = await (await call(route, {query:{conversation:archive}})).json();
  assert.deepEqual([continued.available,continued.nativeContextCount,continued.contextCount],[true,2,4]);
  assert.equal(continued.nativeOrigin, undefined);
  const next = {id:'continued-native-voice-turn',revision:continued.revision,pcm,continuation:continued.continuation};
  await setCheckpoint({...checkpoint,shareConversation:false});
  assert.equal((await post(next)).status, 409);
  await setCheckpoint(checkpoint);
  const finished = (await sse(await post(next))).turn;
  assert.equal(finished.conversationId, archive);
  assert.deepEqual(contextOf(wires[3]), [['user',prompt],['assistant',codexAnswer],
    ['user','今回の音声の指示'],['assistant','今回の音声の回答']]);
  assert.equal(wires.length, 4);
  assert.deepEqual(store.getWork(id).checkpoint, before.checkpoint);
});

test('unavailable API isolation releases the reservation before provider dispatch', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, source, store} = await fixture(t, async () => {
    requests++;
    return providerAnswer(2);
  }, {verifyInSandbox: async () => ({passed: false, exitCode: null, output: 'Fixture sandbox failed to start'})});

  const settings = await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}});
  assert.equal(settings.status, 200);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  const operation = await waitFor(call, 'interrupted');
  assert.equal(operation.result, 'API_ISOLATION_UNAVAILABLE');
  assert.equal(operation.startedAt, null);
  assert.equal(requests, 0);
  assert.equal(operation.artifactCount, 0);
  assert.deepEqual(operation.providerReceipts ?? [], []);
  assert.deepEqual((await (await call('/api/artifacts/work')).json()).artifacts, []);
  assert.equal(await readFile(source, 'utf8'), 'export const answer = 1;\n');
  const work = store.getWork(id, instruction.id);
  assert.equal(work.operation.status, 'cancelled');
  assert.equal(work.busy, false);
  assert.equal(work.settledApiMicros, 0);
});

test('owner API-only work repairs actual source in an isolated Mac and returns a verified artifact', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, source, open} = await fixture(t, async (_url, request) => {
    requests++;
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.input[1].content);
    assert.equal(input.candidate.files.length, 1);
    assert.equal(input.candidate.files[0].path, 'source.mjs');
    if (requests === 2) assert.match(input.previousVerification, /1 failed/);
    const answer = requests === 1 ? 3 : 2;
    return Response.json({id: 'resp_test' + requests, model: modelId, service_tier: 'default', status: 'completed', usage: {input_tokens: 100, output_tokens: 25},
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({
        summary: '定数を修正', changes: [{path: 'source.mjs', text: `export const answer = ${answer};\n`}],
      })}]}]});
  });
  assert.equal((await call('/api/execution/api', {auth: false})).status, 401);
  assert.equal((await call('/api/execution/api', {data: instruction, origin: 'https://untrusted.invalid'})).status, 403);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 409);
  assert.equal(requests, 0);
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  const [first, duplicate] = await Promise.all([call('/api/execution/api', {data: instruction}), call('/api/execution/api', {data: instruction})]);
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 202);
  assert.equal((await first.json()).operation.id, (await duplicate.json()).operation.id);
  const operation = await waitFor(call, 'completed');
  assert.equal(requests, 2);
  assert.equal(operation.route, 'api');
  assert.equal(operation.verification.passed, true);
  assert.equal(operation.artifactCount, 1);
  assert.deepEqual(operation.providerReceipts.map(({id, inputTokens, outputTokens, accountedMicros}) =>
    [id, inputTokens, outputTokens, accountedMicros]), [['resp_test1', 100, 25, 400], ['resp_test2', 100, 25, 400]]);
  const query = {id: instruction.id, index: '0'};
  assert.equal((await call('/api/execution/api/artifact', {query, project: 'other-fixture'})).status, 404);
  assert.equal(await (await call('/api/execution/api/artifact', {query})).text(), 'export const answer = 2;\n');
  assert.equal(await readFile(source, 'utf8'), 'export const answer = 1;\n');
  assert.equal((await call('/api/execution/api', {data: {...instruction, prompt: '別の指示'}})).status, 409);
  const {conversations} = await (await call('/api/chat', {query: {q: instruction.prompt}})).json();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].source, 'api-development');
  const timelineId = conversations[0].id;
  const {conversation} = await (await call('/api/chat', {query: {id: timelineId}})).json();
  assert.equal(conversation.outcome, 'completed');
  assert.equal(conversation.model, modelId);
  assert.deepEqual(conversation.providerReceipts, operation.providerReceipts);
  assert.deepEqual(conversation.messages.map(({role, text}) => [role, text]), [
    ['user', instruction.prompt], ['assistant', '定数を修正'],
  ]);
  assert.equal((await call('/api/chat', {query: {id: timelineId}, project: 'other-fixture'})).status, 404);
  const {activity} = await (await call('/api/execution/activity')).json();
  assert.equal(activity.kind, 'api');
  assert.equal(activity.phase, 'completed');
  assert.equal(activity.model, modelId);
  await open(false);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 409);
  assert.equal((await call('/api/artifacts/work', {auth: false})).status, 401);
  assert.deepEqual((await (await call('/api/artifacts/work', {project: 'other-fixture'})).json()).artifacts, []);
  const published = (await (await call('/api/artifacts/work')).json()).artifacts;
  assert.equal(published.length, 1);
  assert.equal(published[0].title, 'source.mjs');
  assert.equal(published[0].sha256, operation.changes[0].sha256);
  const fileQuery = Object.fromEntries(new URLSearchParams(published[0].href.split('?')[1]));
  assert.equal((await call('/api/artifacts/work/file', {query: {...fileQuery, project: 'other-fixture'}})).status, 404);
  assert.equal(await (await call('/api/artifacts/work/file', {query: fileQuery})).text(), 'export const answer = 2;\n');
  const restarted = await (await call('/api/chat', {query: {id: timelineId}})).json();
  assert.deepEqual(restarted.conversation, conversation);
  assert.deepEqual((await (await call('/api/execution/activity')).json()).activity, activity);
  assert.equal(requests, 2);
});

test('portfolio reads settled API work after restart without dispatch or reporting revoked workspaces', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, directory, ledgerFile, open, portfolio, store} = await fixture(t, async () => {
    requests++;
    const output = requests !== 2
      ? [{type:'message', role:'assistant', content:[{type:'output_text', text: JSON.stringify({answer:'PRIVATE_ADVICE'})}]}]
      : [];
    return Response.json({...(requests < 3 && {id:'resp_history' + requests}), model:modelId, service_tier:'default', status:'completed',
      usage:{input_tokens:100, output_tokens:25}, output});
  });
  assert.equal((await call('/api/execution/settings', {data:{revision:0, settings:{mode:'api-only', apiBudgetUsd:1}}})).status, 200);
  for (const [taskId, phase] of [['history-advice-success', 'completed'], ['history-advice-failure', 'failed'], ['history-unverified', 'completed']]) {
    assert.equal((await call('/api/execution/api', {data:{id:taskId, stage:'consultation', prompt:'相談の保存'}})).status, 202);
    await waitFor(call, phase, taskId);
  }
  const failure = store.getWork(id, 'history-advice-failure').operation;
  const success = store.getWork(id, 'history-advice-success').operation;
  const before = await readFile(ledgerFile);
  const expected = [failure, success].map(work => ({projectId:id, id:work.taskId, kind:'api',
    phase:work.status, observedAt:work.completedAt, measurement:{
      model:modelId, ...(work.reasoningEffort && {reasoningEffort:work.reasoningEffort}),
      startedAt:work.dispatchedAt, completedAt:work.completedAt,
      durationMs:Date.parse(work.completedAt) - Date.parse(work.dispatchedAt),
      tokens:{scope:'api-responses',inputTokens:100,outputTokens:25,totalTokens:125},
    }}));
  await open(false);
  assert.equal((await call('/api/portfolio', {auth:false})).status, 401);
  const response = await (await call('/api/portfolio')).text();
  assert.deepEqual(JSON.parse(response).recentWorkOutcomes, expected);
  assert.ok(!response.includes('PRIVATE_ADVICE') && !response.includes('resp_history') && !response.includes(directory));
  const resultPath = join(directory, 'api-work', failure.executionId, 'result.json');
  await writeFile(resultPath, '{}');
  assert.deepEqual((await (await call('/api/portfolio')).json()).recentWorkOutcomes, [expected[1]]);
  const definition = JSON.parse(await readFile(portfolio));
  delete definition.projects[0].cwd;
  await writeFile(portfolio, JSON.stringify(definition), {mode:0o600});
  assert.deepEqual((await (await call('/api/portfolio')).json()).recentWorkOutcomes, []);
  assert.deepEqual(await readFile(ledgerFile), before);
  assert.equal(requests, 3);
});

function providerAnswer(answer, changes = [{path: 'source.mjs', text: `export const answer = ${answer};\n`}]) {
  return Response.json({model: modelId, service_tier: 'default', status: 'completed', usage: {input_tokens: 100, output_tokens: 25},
    output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({
      summary: '実行確認', changes,
    })}]}]});
}

test('API consultation reserves one response, archives the full advice, and hands off without file edits', {skip: process.platform !== 'darwin'}, async t => {
  const answers = [];
  const advice = ` 照合用の相談を保存する。${'設計上の決定と根拠。'.repeat(260)}\n`;
  const {call, store, source, directory} = await fixture(t, async (_url, request) => {
    answers.push(JSON.parse(request.body));
    return Response.json({model: modelId, service_tier: 'default', status: 'completed', usage: {input_tokens: 100, output_tokens: 25},
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({answer: advice})}]}]});
  }, {handover: true});
  const query = {id: 'api-advice-fixture'};
  const request = {...query, prompt: 'この案件の設計を相談する', stage: 'consultation'};
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 0.06}}})).status, 200);
  assert.equal((await call('/api/execution/api', {data: request})).status, 202);
  const completed = await waitFor(call, 'completed', request.id);
  assert.equal(completed.advice, advice);
  assert.equal(completed.artifactCount, 0);
  assert.equal(completed.verification, null);
  const work = store.getWork(id, request.id).operation;
  assert.equal(work.reservedMicros, 48000);
  assert.equal(work.costMicros, 400);
  const archived = createChatStore(directory);
  try {
    assert.equal(archived.read(id, `api/${work.executionId}`, 0).conversation.messages[1].text, advice);
  } finally { archived.close(); }
  assert.equal(await readFile(source, 'utf8'), 'export const answer = 1;\n');
  assert.equal(answers.length, 1);
  assert.ok(JSON.parse(answers[0].input[1].content).context.files.every(file => file.writable === false));
  assert.equal((await call('/api/execution/api', {data: request})).status, 202);
  assert.equal(answers.length, 1);
  await call('/api/execution/settings', {data: {revision: 1, settings: {mode: 'subscription-only'}}});
  const receipt = work.executionId;
  const proof = await call('/api/execution/handover', {query: {receipt}});
  assert.equal(proof.status, 200);
  assert.deepEqual((await proof.json()).artifacts, []);
});

test('API-to-Codex rehearsal checks a committed requirement, conversation and applied artifact without enabling execution', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, store, open, commitSource, requirements, portfolio, ledgerFile} = await fixture(t, async () => {
    requests++;
    return providerAnswer(2);
  }, {handover: true});
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  const result = await waitFor(call, 'completed');
  const query = {receipt: store.getWork(id, instruction.id).operation.executionId};
  assert.equal((await call('/api/execution/handover', {query})).status, 409);
  assert.equal((await call('/api/execution/settings', {data: {revision: 1, settings: {mode: 'subscription-only'}}})).status, 200);
  await open(false);
  assert.equal((await call('/api/execution/handover', {query, auth: false})).status, 401);
  const cleanBase = await call('/api/execution/handover', {query});
  assert.equal(cleanBase.status, 409);
  assert.match((await cleanBase.json()).error, /検証済み成果物/);
  await commitSource('export const answer = 2;\n');
  const before = await readFile(ledgerFile, 'utf8');
  const readback = await call('/api/execution/handover', {query});
  assert.equal(readback.status, 200);
  const proof = await readback.json();
  assert.equal(proof.kind, 'rehearsal');
  assert.equal(proof.verified, true);
  assert.equal(proof.requirements.path, 'GOAL.md');
  assert.equal(proof.archiveId, `api/${query.receipt}`);
  assert.equal(proof.checkoutHead.length, 40);
  assert.equal(proof.artifacts[0].sha256, result.changes[0].sha256);
  assert.equal(proof.settledApiMicros, 400);
  assert.equal(await readFile(ledgerFile, 'utf8'), before);
  assert.equal((await call('/api/execution/handover', {query: {receipt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}})).status, 409);
  assert.equal((await call('/api/execution/handover', {query, project: 'other-fixture'})).status, 409);
  const original = await readFile(requirements);
  await writeFile(requirements, '正本を別の指示に変更');
  assert.match((await (await call('/api/execution/handover', {query})).json()).error, /要求の正本/);
  await writeFile(requirements, original);
  const definition = JSON.parse(await readFile(portfolio, 'utf8'));
  definition.projects[0].state = 'paused';
  await writeFile(portfolio, JSON.stringify(definition));
  assert.equal((await call('/api/execution/handover', {query})).status, 409);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 409);
  assert.equal(requests, 1);
});

test('a verified API receipt starts one linked Codex thread and fences stale evidence before its turn', {skip: process.platform !== 'darwin'}, async t => {
  const model = {id: 'fixture-codex', isDefault: true, reasoningEfforts: []};
  let release;
  let allowedUsage = true;
  let mutateAtUsage;
  let event;
  let steerCalls = 0;
  const firstThread = new Promise(resolve => { release = resolve; });
  const attempted = [];
  const submitted = [];
  const codex = {canWrite: true, subscriptionReady: async () => true,
    models: async () => ({accountType: 'chatgpt', data: [model]}),
    async usage() {
      const change = mutateAtUsage;
      mutateAtUsage = undefined;
      await change?.();
      return {observedAt: new Date().toISOString(), ordinaryUsageAllowed: allowedUsage, windows: [{usedPercent: 20}]};
    },
    onEvent(listener) { event = listener; return () => { event = null; }; },
    async steer({turnId, beforeSteer, beforeSend}) {
      await beforeSteer?.();
      beforeSend();
      steerCalls++;
      return turnId;
    },
    async submit(options) {
      assert.equal(options.beforeThread(), true);
      attempted.push(options.requestId);
      if (attempted.length === 1) await firstThread;
      const failAtSend = options.requestId === 'handoff-usage-stopped';
      if (failAtSend) allowedUsage = false;
      if (options.requestId === 'handoff-last-moment') mutateAtUsage = () => writeFile(requirements, '利用枠照合中に変わった要求');
      try { await options.beforeTurn?.(); }
      finally { if (failAtSend) allowedUsage = true; }
      assert.equal(options.onThread(options.knownId ?? 'linked-native-thread'), true);
      submitted.push(options);
      return {turn: {id: `turn-${submitted.length}`, status: options.requestId === 'handoff-same-thread' ? 'inProgress' : 'completed'}};
    }};
  let providerCalls = 0;
  const {call, store, open, commitSource, requirements} = await fixture(t, async () => {
    providerCalls++;
    return providerAnswer(2);
  }, {handover: true, codex});
  const ran = async (operationId, phase) => {
    for (let index = 0; index < 80; index++) {
      const row = (await (await call('/api/codex/run', {query: {id: operationId}})).json()).operation;
      if (row?.phase === phase) return row;
      if (['failed', 'completed', 'unconfirmed'].includes(row?.phase)) assert.equal(row.phase, phase);
      await wait(50);
    }
    assert.fail(`Codex operation did not become ${phase}`);
  };
  try {
    assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
    assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
    await waitFor(call, 'completed');
    await commitSource('export const answer = 2;\n');
    const receipt = store.getWork(id, instruction.id).operation.executionId;
    assert.equal((await call('/api/execution/settings', {data: {revision: 1, settings: {mode: 'subscription-only'}}})).status, 200);
    await open(false);
    const {review} = await (await call('/api/execution/handover', {query: {receipt}})).json();
    assert.match(review, /^[a-f0-9]{64}$/);
    const payload = {id: 'handoff-stale-turn', prompt: '現在の成果を引き継いで次の検証を行う', stage: 'implementation', route: 'subscription',
      handover: {receipt, review}};
    assert.equal((await call('/api/codex/run', {data: {...payload, handover: undefined}})).status, 409);
    assert.equal((await call('/api/codex/run', {data: {...payload, handover: {receipt, review: 'f'.repeat(64)}}})).status, 409);
    allowedUsage = false;
    assert.equal((await call('/api/codex/run', {data: payload})).status, 409);
    allowedUsage = true;
    const original = await readFile(requirements);
    assert.equal((await call('/api/codex/run', {data: payload})).status, 202);
    await writeFile(requirements, '送信直前の未承認の変更');
    release();
    await ran(payload.id, 'failed');
    assert.equal(submitted.length, 0);
    await writeFile(requirements, original);
    const later = {...payload, id: 'handoff-last-moment'};
    assert.equal((await call('/api/codex/run', {data: later})).status, 202);
    await ran(later.id, 'failed');
    assert.equal(submitted.length, 0);
    await writeFile(requirements, original);
    const accepted = {...payload, id: 'handoff-valid-turn'};
    const simultaneous = await Promise.all([call('/api/codex/run', {data: accepted}), call('/api/codex/run', {data: accepted})]);
    assert.deepEqual(simultaneous.map(response => response.status), [202, 202]);
    assert.equal((await simultaneous[0].json()).operation.id, (await simultaneous[1].json()).operation.id);
    const row = await ran(accepted.id, 'completed');
    assert.equal(row.handoverReceipt, receipt);
    assert.equal(row.threadId, 'linked-native-thread');
    assert.equal((await (await call('/api/codex/run', {data: accepted})).json()).operation.id, row.id);
    assert.equal((await call('/api/codex/run', {data: {...accepted, id: 'handoff-duplicate-origin'}})).status, 409);
    assert.equal(submitted.length, 1);
    assert.match(submitted[0].prompt, /GOAL\.md/);
    assert.match(submitted[0].prompt, /答えを2にする/);
    assert.match(submitted[0].prompt, /実行確認/);
    assert.match(submitted[0].prompt, /現在の成果を引き継いで次の検証を行う/);
    await open(false);
    const latest = await (await call('/api/codex/run', {query: {handoverReceipt: receipt}})).json();
    assert.equal(latest.operation.id, row.id);
    const continuation = {id: 'handoff-same-thread', resume: row.id, prompt: '次の確認を続ける'};
    assert.equal((await call('/api/codex/run', {data: continuation})).status, 202);
    const resumed = await ran(continuation.id, 'running');
    assert.equal(resumed.handoverReceipt, receipt);
    assert.equal(submitted[1].knownId, row.threadId);
    assert.equal(submitted[1].prompt, continuation.prompt);
    allowedUsage = false;
    const steering = {id: 'handoff-blocked-steering', operationId: resumed.id, prompt: '追加確認'};
    assert.equal((await call('/api/codex/steer', {data: steering})).status, 409);
    assert.equal(steerCalls, 0);
    allowedUsage = true;
    event('turn/completed', {threadId: resumed.threadId, turn: {id: resumed.turnId, status: 'completed'}});
    await ran(resumed.id, 'completed');
    const denied = {...continuation, id: 'handoff-usage-stopped', resume: resumed.id};
    assert.equal((await call('/api/codex/run', {data: denied})).status, 202);
    await ran(denied.id, 'failed');
    assert.equal((await call('/api/execution/settings', {data: {revision: 2, settings: {mode: 'api-only'}}})).status, 200);
    await open(true);
    assert.equal((await call('/api/execution/api', {data: {...instruction, id: 'reverse-without-handoff'}})).status, 409);
    assert.equal(providerCalls, 1);
  } finally { release(); }
});

test('Codex-to-API handover verifies an approved checkpoint, then sends exact context once', {skip: process.platform !== 'darwin'}, async t => {
  const request = {id: 'reverse-proof-operation', prompt: '元の指示を渡し、変更の検証を保存する'};
  const threadId = 'reverse-proof-thread', turnId = 'native-completed-turn';
  const messages = [{id: 'native-input', role: 'user', text: request.prompt},
    {id: 'native-output', role: 'assistant', text: '  検証した候補。\n'}];
  let returnedMessages = messages;
  let nativeReads = 0;
  let lateMismatch = -1;
  const providerInputs = [];
  const codex = {canWrite: true, subscriptionReady: async () => true, onEvent: () => () => {},
    models: async () => ({accountType: 'chatgpt', data: [{id: 'fixture-native', isDefault: true, reasoningEfforts: []}]}),
    usage: async () => ({observedAt: new Date().toISOString(), ordinaryUsageAllowed: true, windows: [{usedPercent: 20}]}),
    async submit(options) {
      assert.equal(options.beforeThread(), true);
      await options.beforeTurn?.();
      assert.equal(options.onThread(threadId), true);
      return {turn: {id: turnId, status: 'completed'}};
    },
    async readHandoverTurn(_worktree, thread, turn, operation) {
      assert.deepEqual([thread, turn, operation], [threadId, turnId, request.id]);
      if (++nativeReads === lateMismatch) return {threadId, turnId: 'different-latest-turn', messages};
      return {threadId, turnId, messages: returnedMessages};
    }};
  const {call, directory, source, requirements, portfolio, ledgerFile, commitFiles, open, openReader, store} = await fixture(t, async (_url, request) => {
    const payload = JSON.parse(request.body);
    assert.equal(payload.text.format.name, 'project_advice');
    providerInputs.push(JSON.parse(payload.input[1].content));
    return Response.json({model: modelId, service_tier: 'default', status: 'completed', usage: {input_tokens: 100, output_tokens: 25},
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: '{"answer":"次の設計確認を保存する。"}'}]}]});
  }, {handover: true, codex});
  const checkout = dirname(source);
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'subscription-only'}}})).status, 200);
  assert.equal((await call('/api/codex/run', {data: request})).status, 202);
  let row;
  for (let index = 0; index < 40 && row?.phase !== 'completed'; index++) {
    row = (await (await call('/api/codex/run', {query: {id: request.id}})).json()).operation;
    if (row?.phase !== 'completed') await wait(25);
  }
  assert.equal(row?.phase, 'completed');
  assert.equal((await call('/api/execution/settings', {data: {revision: 1, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  const proof = (project = id) => call('/api/execution/handover', {query: {thread: threadId}, project});
  assert.equal((await proof()).status, 409);
  const commit = [{path: 'source.mjs', text: 'export const answer = 2;\n'},
    {path: 'verification.md', text: 'Independent fixture observation: 1 test completed.\n'}];
  await commitFiles(commit);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const head = execFileSync('/usr/bin/git', ['-C', checkout, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const checkpoint = {version: 1, operationId: request.id, threadId, turnId, checkoutHead: head,
    requirementsSha256: sha(await readFile(requirements)), transcriptSha256: sha(JSON.stringify(messages)),
    artifacts: [{path: commit[0].path, sha256: sha(commit[0].text)}],
    verification: {path: commit[1].path, sha256: sha(commit[1].text)}, effectsReconciled: true, shareConversation: true};
  const definition = JSON.parse(await readFile(portfolio, 'utf8'));
  const useCheckpoint = async value => {
    definition.projects[0].nativeHandover = value;
    await writeFile(portfolio, JSON.stringify(definition));
  };
  await useCheckpoint(checkpoint);
  const ledger = await readFile(ledgerFile);
  await t.test('approved completed Codex artifact and evidence are available without API or conversation access', async () => {
    const reader = await openReader();
    const list = options => reader('/api/artifacts/work', {query: {source: 'codex'}, ...options});
    const download = (href, options = {}) => {
      const link = new URL(href, 'https://fixture.invalid');
      assert.equal(link.origin, 'https://fixture.invalid');
      return reader(link.pathname, {query: {...Object.fromEntries(link.searchParams), ...options}});
    };
    try {
      assert.equal((await list({auth: false})).status, 401);
      assert.deepEqual((await (await list()).json()).artifacts, []);
      await useCheckpoint({...checkpoint, shareArtifacts: true, shareConversation: false});
      const response = await list();
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.equal(page.artifacts.length, 1);
      assert.equal(page.nextOffset, null);
      const [artifact] = page.artifacts;
      assert.deepEqual([artifact.project, artifact.title, artifact.sha256], [id, 'source.mjs', checkpoint.artifacts[0].sha256]);
      assert.equal(artifact.observedAt, row.updatedAt);
      const artifactResponse = await download(artifact.href);
      assert.equal(artifactResponse.status, 200);
      assert.match(artifactResponse.headers.get('content-disposition'), /^attachment/);
      assert.equal(await artifactResponse.text(), commit[0].text);
      assert.equal(await (await download(artifact.evidence.requirements.href)).text(), await readFile(requirements, 'utf8'));
      assert.equal(await (await download(artifact.evidence.verification.href)).text(), commit[1].text);
      assert.deepEqual((await (await list({project: 'other-fixture'})).json()).artifacts, []);
      assert.equal((await download(artifact.href, {project: 'other-fixture'})).status, 404);
      assert.equal((await download(artifact.href, {id: 'unknown-other-operation'})).status, 404);
      assert.equal((await download(artifact.href, {part: 'arbitrary'})).status, 404);
      assert.equal((await download(artifact.href, {review: '0'.repeat(64)})).status, 404);
      assert.deepEqual((await (await reader('/api/artifacts/work')).json()).artifacts, []);
      assert.equal((await download(artifact.href, {index: '2'})).status, 404);

      await writeFile(source, 'export const answer = 99;\n');
      assert.equal((await download(artifact.href)).status, 404);
      assert.deepEqual((await (await list()).json()).artifacts, []);
      await writeFile(source, commit[0].text);
      await useCheckpoint({...checkpoint, shareArtifacts: true, effectsReconciled: false});
      assert.deepEqual((await (await list()).json()).artifacts, []);
      assert.equal((await download(artifact.href)).status, 404);
      await useCheckpoint({...checkpoint, shareArtifacts: true, requirementsSha256: {toString: null}});
      assert.deepEqual((await (await list()).json()).artifacts, []);
      assert.equal(providerInputs.length, 0);
      assert.equal(nativeReads, 0);
      assert.deepEqual(await readFile(ledgerFile), ledger);
    } finally {
      await writeFile(source, commit[0].text);
      await useCheckpoint(checkpoint);
    }
  });
  const approved = await proof();
  const result = await approved.json();
  assert.equal(approved.status, 200, JSON.stringify(result));
  assert.deepEqual(result, {verified: true, source: 'subscription', destination: 'api',
    receipt: request.id, review: result.review, checkoutHead: head,
    requirements: {path: 'GOAL.md', sha256: checkpoint.requirementsSha256}, artifacts: checkpoint.artifacts,
    verification: checkpoint.verification, transcript: {sha256: checkpoint.transcriptSha256, messages: 2}});
  assert.match(result.review, /^[a-f0-9]{64}$/);
  assert.deepEqual(await (await proof()).json(), result);
  assert.notEqual((await proof('other-fixture')).status, 200);
  returnedMessages = [messages[0], {...messages[1], text: messages[1].text.trim()}];
  assert.equal((await proof()).status, 409);
  returnedMessages = messages;
  await writeFile(source, 'export const answer = 99;\n');
  assert.equal((await proof()).status, 409);
  await writeFile(source, commit[0].text);
  const indexFlag = (...args) => execFileSync('/usr/bin/git', ['-C', checkout, 'update-index', ...args, 'check.test.mjs']);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    indexFlag('--' + flag);
    assert.equal((await proof()).status, 409);
    indexFlag('--no-' + flag);
  }
  await useCheckpoint({...checkpoint, shareConversation: false});
  assert.equal((await proof()).status, 409);
  assert.deepEqual(await readFile(ledgerFile), ledger);
  assert.equal(providerInputs.length, 0);
  const nativeOrigin = {threadId, operationId: request.id, review: result.review};
  const advice = {id: 'review-then-advise', stage: 'consultation', prompt: '検証結果を踏まえて次の設計を相談する', nativeOrigin};
  assert.equal((await call('/api/execution/api', {data: advice})).status, 409);
  await useCheckpoint(checkpoint);
  assert.equal((await call('/api/execution/api', {data: {...advice, stage: 'implementation'}})).status, 400);
  assert.equal((await call('/api/execution/api', {data: {...advice, nativeOrigin: undefined}})).status, 409);
  const unenrolled = {...advice, id: 'unenrolled-reverse-proof'};
  assert.equal((await call('/api/execution/api', {data: unenrolled})).status, 202);
  assert.equal((await waitFor(call, 'interrupted', unenrolled.id)).result, 'NATIVE_HANDOVER_ENROLLMENT_REQUIRED');
  assert.equal(providerInputs.length, 0);
  const authorityPath = join(directory, apiAuthorityFile);
  const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
  authority.projects[id].files.push({path: 'GOAL.md', writable: false}, {path: 'verification.md', writable: false});
  await writeFile(authorityPath, JSON.stringify(authority));
  lateMismatch = nativeReads + 2;
  const stale = {...advice, id: 'late-stale-native-source'};
  assert.equal((await call('/api/execution/api', {data: stale})).status, 202);
  assert.equal((await waitFor(call, 'interrupted', stale.id)).result, 'HANDOVER_CONVERSATION_UNVERIFIED');
  assert.equal(providerInputs.length, 0);
  const submitted = await Promise.all([call('/api/execution/api', {data: advice}), call('/api/execution/api', {data: advice})]);
  assert.deepEqual(submitted.map(response => response.status), [202, 202]);
  const completed = await waitFor(call, 'completed', advice.id);
  assert.deepEqual(completed.nativeOrigin, nativeOrigin);
  assert.equal(completed.advice, '次の設計確認を保存する。');
  assert.equal(providerInputs.length, 1);
  const {work, context} = providerInputs[0];
  assert.equal(work, advice.prompt);
  assert.deepEqual(context.handover.messages, messages);
  assert.equal(context.handover.checkoutHead, head);
  assert.equal(context.handover.settingsRevision, 2);
  assert.equal(context.handover.apiBudgetUsd, 1);
  assert.ok(context.files.every(file => !file.writable));
  assert.ok(context.files.some(file => file.path === 'GOAL.md' && /既存機能を維持/.test(file.text)));
  assert.equal(await readFile(source, 'utf8'), commit[0].text);
  assert.equal((await call('/api/execution/api', {data: {...advice, prompt: '無関係な変更'}})).status, 409);
  const refreshed = await (await proof()).json();
  assert.notEqual(refreshed.review, result.review);
  assert.equal((await call('/api/execution/api', {data: {...advice, id: 'advice-duplicate-id',
    nativeOrigin: {...nativeOrigin, review: refreshed.review}}})).status, 409);
  await open(false);
  const saved = store.getWork(id, advice.id).operation;
  assert.deepEqual(saved.nativeOrigin, nativeOrigin);
  const history = await (await call('/api/chat', {query: {id: 'api/' + saved.executionId}})).json();
  assert.deepEqual(history.conversation.messages.map(message => message.text), [advice.prompt, completed.advice]);
  assert.equal((await call('/api/execution/settings', {data: {revision: 2, settings: {mode: 'subscription-only'}}})).status, 200);
  const forwardsAgain = await call('/api/execution/handover', {query: {receipt: saved.executionId}});
  assert.equal(forwardsAgain.status, 200);
  assert.deepEqual((await forwardsAgain.json()).artifacts, checkpoint.artifacts);
  assert.equal(providerInputs.length, 1);
});

test('readback preserves more retained files than a single API enrollment', {skip: process.platform !== 'darwin'}, async t => {
  const auxiliary = Array.from({length: 25}, (_, index) => `support-${index}.mjs`);
  const changes = paths => paths.map(path => ({path, text: 'export const testFlag = true;\n'}));
  const first = [{path: 'source.mjs', text: 'export const answer = 2;\n'}, ...changes(auxiliary.slice(0, 22))];
  const second = changes(auxiliary.slice(22));
  let requests = 0;
  const {call, store, directory, commitFiles} = await fixture(t, async () => providerAnswer(2, requests++ === 0 ? first : second),
    {handover: true, auxiliary});
  const authorityPath = join(directory, apiAuthorityFile);
  const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
  async function enroll(files) {
    authority.projects[id].files = files;
    await writeFile(authorityPath, JSON.stringify(authority));
  }
  await enroll(first.map(item => ({path: item.path, writable: true})));
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  assert.equal((await waitFor(call, 'completed')).artifactCount, first.length);
  await commitFiles(first);
  await enroll([{path: 'source.mjs', writable: false}, ...second.map(item => ({path: item.path, writable: true}))]);
  const latest = {...instruction, id: 'more-retained-files'};
  assert.equal((await call('/api/execution/api', {data: latest})).status, 202);
  assert.equal((await waitFor(call, 'completed', latest.id)).artifactCount, second.length);
  await commitFiles(second);
  assert.equal((await call('/api/execution/settings', {data: {revision: 1, settings: {mode: 'subscription-only'}}})).status, 200);
  const receipt = store.getWork(id, latest.id).operation.executionId;
  const response = await call('/api/execution/handover', {query: {receipt}});
  const report = await response.json();
  assert.equal(response.status, 200, JSON.stringify(report));
  assert.deepEqual(report.artifacts.map(item => item.path), [...first, ...second].map(item => item.path));
  assert.equal(requests, 2);
});

test('a second gateway cannot finalize a still-running archived conversation', {skip: process.platform !== 'darwin'}, async t => {
  let release, reportArrival;
  const awaitingRelease = new Promise(resolve => { release = resolve; });
  const providerCalled = new Promise(resolve => { reportArrival = resolve; });
  const {call, openReader} = await fixture(t, async () => {
    reportArrival();
    await awaitingRelease;
    return providerAnswer(2);
  });
  try {
    assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
    assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
    await Promise.race([providerCalled, wait(4000, null, {ref: false}).then(() => assert.fail('Provider did not receive the fixture'))]);
    const reader = await openReader();
    const {conversations} = await (await reader('/api/chat')).json();
    const query = {id: conversations[0].id};
    assert.equal((await (await call('/api/chat', {query})).json()).conversation.outcome, 'in_progress');
    assert.equal((await (await reader('/api/chat', {query})).json()).conversation.outcome, 'unconfirmed');
    release();
    await waitFor(call, 'completed');
    const {conversation} = await (await reader('/api/chat', {query})).json();
    assert.equal(conversation.outcome, 'completed');
    assert.deepEqual(conversation.messages.map(message => message.role), ['user', 'assistant']);
  } finally { release(); }
});

test('an unstarted receipt reads as reserved, and a broken ledger cannot hide imported ChatGPT history', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, store, directory, ledgerFile} = await fixture(t, async () => { requests++; return providerAnswer(2); });
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  const now = Date.now();
  const receipt = store.prepareDispatch({projectId: id, taskId: instruction.id, instructionDigest: 'a'.repeat(64), expectedRevision: 1,
    task: {route: 'api', stage: 'implementation'}}, {now, capabilities: {api: {available: true, executorId: 'owner-mac-responses',
      defaultModel: modelId, models: [{id: modelId, reasoningEfforts: []}]}}, safety: {authorized: true, status: 'ready',
      allowedRoutes: ['api'], api: {organizationId: 'org-fixture', creditOrganizationId: 'org-fixture',
        reservationAuthorityId: store.authorityId, ledgerBinding: store.reservationBinding(), availableCreditUsd: 2,
        observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString(),
        zeroAdditionalCostGuaranteed: true, maxRequestCostUsd: 0.1}}});
  assert.equal(receipt.dispatchable, true);
  const chats = createChatStore(directory);
  const {executionId, createdAt} = receipt.operation;
  try { chats.beginDevelopment(id, {id: executionId, createdAt, model: modelId, prompt: instruction.prompt}); }
  finally { chats.close(); }
  const query = {id: `api/${executionId}`};
  assert.equal((await (await call('/api/chat', {query})).json()).conversation.outcome, 'reserved');
  const archive = {id: 'export-fixture', title: '既存の相談', current_node: 'message', mapping: {message: {parent: null,
    message: {author: {role: 'user'}, content: {parts: ['保存しておいた事実']}}}}};
  assert.equal((await call('/api/chat/import', {data: [archive]})).status, 200);
  await writeFile(ledgerFile, '{}');
  const {conversation} = await (await call('/api/chat', {query: {id: archive.id}})).json();
  assert.equal(conversation.messages[0].text, '保存しておいた事実');
  assert.equal((await (await call('/api/chat', {query})).json()).conversation.outcome, 'unconfirmed');
  assert.equal(requests, 0);
});

test('copying a credit observation and ledger to another runtime does not create another reservation authority', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return providerAnswer(2); };
  const original = await fixture(t, fetchImpl);
  const copy = await fixture(t, fetchImpl);
  assert.equal((await original.call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  await copyFile(original.ledgerFile, copy.ledgerFile);
  await copyFile(join(original.directory, apiAuthorityFile), join(copy.directory, apiAuthorityFile));
  const capability = await (await copy.call('/api/execution/api/capabilities')).json();
  assert.equal(capability.available, false);
  assert.equal(capability.reason, 'API_AUTHORITY_UNBOUND');
  assert.equal((await copy.call('/api/execution/api', {data: instruction})).status, 409);
  assert.equal(requests, 0);
});

test('a settled failure cannot erase the earlier verified artifact handover', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, store, commitSource} = await fixture(t, async () => providerAnswer(++requests === 1 ? 2 : 3));
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  await waitFor(call, 'completed');
  await commitSource('export const answer = 2;\n');
  const fails = {...instruction, id: 'fails-after-pass'};
  assert.equal((await call('/api/execution/api', {data: fails})).status, 202);
  assert.equal((await waitFor(call, 'failed', fails.id)).result, 'API_VERIFICATION_FAILED');
  assert.equal(store.getWork(id).checkpointOperation.taskId, fails.id);
  assert.deepEqual(store.getWork(id).verifiedApiOperations.map(item => item.taskId), [instruction.id]);
  await commitSource('export const answer = 1;\n');
  const resume = {...instruction, id: 'handover-check'};
  assert.equal((await call('/api/execution/api', {data: resume})).status, 202);
  assert.equal((await waitFor(call, 'interrupted', resume.id)).result, 'API_CANDIDATE_HANDOVER_REQUIRED');
  assert.equal(requests, 3);
});

test('revocation during the provider response records known usage and withholds the verified candidate', {skip: process.platform !== 'darwin'}, async t => {
  let path, requests = 0;
  const {call, directory, store} = await fixture(t, async () => {
    requests++;
    await rm(path);
    return providerAnswer(2);
  });
  path = join(directory, apiAuthorityFile);
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  const operation = await waitFor(call, 'failed');
  assert.equal(operation.result, 'API_AUTHORITY_MISSING');
  assert.equal(operation.artifactCount, 0);
  assert.equal(store.getWork(id, instruction.id).operation.costMicros, 400);
  assert.equal(store.getWork(id).busy, false);
  assert.equal((await call('/api/execution/api/artifact', {query: {id: instruction.id, index: '0'}})).status, 404);
  assert.equal(requests, 1);
});

test('the first received API receipt survives loss of the second response and a gateway restart', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, open, store} = await fixture(t, async () => {
    if (++requests === 2) throw new Error('connection lost after dispatch');
    const response = await providerAnswer(3).json();
    return Response.json({...response, id: 'resp_receiptfirst'});
  });
  assert.equal((await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}})).status, 200);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  const operation = await waitFor(call, 'unconfirmed');
  assert.equal(requests, 2);
  assert.equal(operation.providerReceipts.length, 1);
  const receipt = operation.providerReceipts[0];
  assert.deepEqual([receipt.id, receipt.inputTokens, receipt.outputTokens, receipt.accountedMicros], ['resp_receiptfirst', 100, 25, 400]);
  assert.ok(Number.isFinite(Date.parse(receipt.observedAt)));
  const work = store.getWork(id, instruction.id).operation;
  assert.equal(work.status, 'uncertain');
  assert.equal(work.costMicros, 0);
  assert.ok(work.reservedMicros > receipt.accountedMicros);
  assert.ok(store.getWork(id).busy);
  await open(false);
  const {conversation} = await (await call('/api/chat', {query: {id: 'api/' + work.executionId}})).json();
  assert.equal(conversation.outcome, 'unconfirmed');
  assert.deepEqual(conversation.providerReceipts, [receipt]);
  assert.deepEqual((await (await call('/api/portfolio')).json()).recentWorkOutcomes, []);
  assert.equal(requests, 2);
});

test('lost API settlement holds the project across repeated requests', {skip: process.platform !== 'darwin'}, async t => {
  let requests = 0;
  const {call, open} = await fixture(t, async () => { requests++; throw new Error('fixture transport break'); });
  await call('/api/execution/settings', {data: {revision: 0, settings: {mode: 'api-only', apiBudgetUsd: 1}}});
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  const result = await waitFor(call, 'unconfirmed');
  assert.equal(result.result, 'API_SETTLEMENT_UNKNOWN');
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  assert.equal((await call('/api/execution/api', {data: {...instruction, id: 'another-task'}})).status, 409);
  await open(true);
  const {conversations} = await (await call('/api/chat')).json();
  const {conversation} = await (await call('/api/chat', {query: {id: conversations[0].id}})).json();
  assert.equal(conversation.outcome, 'unconfirmed');
  assert.deepEqual(conversation.messages.map(item => item.role), ['user']);
  assert.equal((await call('/api/execution/api', {data: instruction})).status, 202);
  assert.equal((await call('/api/execution/api', {data: {...instruction, id: 'another-task'}})).status, 409);
  assert.equal(requests, 1);
});
