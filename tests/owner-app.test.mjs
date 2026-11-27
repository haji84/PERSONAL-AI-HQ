import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {startOwnerApp} from '../app/server.mjs';
import {ensurePrivateDirectory} from '../app/private-directory.mjs';

const seed = {
  observedAt: '2026-11-27T06:25:00.000Z',
  projects: [{id: 'example', name: '検証用プロジェクト', state: 'unknown', goal: '帰属範囲の確認', cwd: resolve(tmpdir(), 'fixture-scope')}],
  apiCreditObservation: {observedFrom: '2026-11-27T06:20:00.000Z', observedUntil: '2026-11-27T06:25:00.000Z',
    expiresOn: '2026-12-19', balanceUsd: 10, internalReference: 'private-fixture'},
  artifacts: [],
};

async function runtimeFixture(t) {
  const temp = await realpath(tmpdir());
  const fixtureRoot = await mkdtemp(join(temp, 'hq-owner-test-'));
  const directory = join(fixtureRoot, 'runtime');
  const apps = [];
  t.after(async () => {
    for (const app of apps.reverse()) await app.close();
    const target = await realpath(fixtureRoot);
    assert.equal(dirname(target), temp);
    assert.ok(basename(target).startsWith('hq-owner-test-'));
    await rm(target, {recursive: true, force: true});
  });
  await ensurePrivateDirectory(directory);
  return {
    directory,
    async start(options) {
      const app = await startOwnerApp({directory, port: 0, ...options});
      apps.push(app);
      return app;
    },
  };
}

async function fixture(t) {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify(seed), {mode: 0o600});
  let nativeReads = 0;
  const app = await start({codex: {
    async listThreads(paths) {
      nativeReads++;
      assert.deepEqual(paths, [resolve(tmpdir(), 'fixture-scope')]);
      return {data: [], nextCursor: null};
    },
    async findSubmission() { nativeReads++; return null; },
  }});
  return {app, directory, start, reads: () => nativeReads};
}

async function login(app) {
  const page = await readFile(app.signInFile, 'utf8');
  const key = /name="key" value="([a-f0-9]{64})"/.exec(page)?.[1];
  assert.ok(key);
  const exchange = () => fetch(`${app.url}/api/session`, {
    method: 'POST', redirect: 'manual', headers: {Origin: 'null'}, body: new URLSearchParams({key}),
  });
  const response = await exchange();
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await exchange()).status, 403);
  return cookie.split(';')[0];
}

test('owner credentials are one-use and private API calls never expose the workspace path', async t => {
  const {app, reads} = await fixture(t);
  assert.equal((await fetch(`${app.url}/api/portfolio`)).status, 401);
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=example`)).status, 401);
  assert.equal(reads(), 0);
  const cookie = await login(app);
  const response = await fetch(`${app.url}/api/portfolio`, {headers: {cookie}});
  assert.equal(response.status, 200);
  const portfolio = await response.json();
  assert.equal(portfolio.projects[0].name, '検証用プロジェクト');
  assert.equal(portfolio.projects[0].cwd, undefined);
  assert.equal(portfolio.apiCreditObservation.balanceUsd, 10);
  assert.equal(portfolio.apiCreditObservation.internalReference, undefined);
  assert.equal((await fetch(`${app.url}/api/usage`)).status, 401);
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=other`, {headers: {cookie}})).status, 404);
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=example`, {headers: {cookie}})).status, 200);
  assert.equal(reads(), 1);
});

test('Codex turn evidence requires an exact authenticated project and rechecks scope after native reading', async t => {
  const {directory, start} = await runtimeFixture(t);
  const portfolioPath = join(directory, 'portfolio.json');
  await writeFile(portfolioPath, JSON.stringify(seed), {mode: 0o600});
  let admit;
  let release;
  const reading = new Promise(resolve => { admit = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  t.after(release);
  const calls = [];
  const app = await start({codex: {async readTurnEvidence(scope, id, turn, options) {
    calls.push({scope, id, turn, options});
    if (turn === 'held') { admit(); await released; }
    return {threadId: id, turnId: turn, entries: [], nextCursor: null};
  }}});
  const url = app.url + '/api/codex/evidence';
  const query = '?project=example&id=thread&turn=turn';
  assert.equal((await fetch(url + query)).status, 401);
  const cookie = await login(app);
  const get = params => fetch(url + params, {headers: {cookie}});
  assert.equal((await get('?project=unknown&id=thread&turn=turn')).status, 404);
  assert.equal((await get(query + '&project=unknown')).status, 404);
  for (const bad of ['&id=other', '&turn=other', '&item=x&cursor=y', '&cursor=%0A', '&item=']) {
    assert.equal((await get(query + bad)).status, 400);
  }
  assert.equal(calls.length, 0);
  const page = await get(query + '&cursor=native%2Bcursor');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await page.json(), {threadId: 'thread', turnId: 'turn', entries: [], nextCursor: null});
  assert.deepEqual(calls[0], {scope: [seed.projects[0].cwd], id: 'thread', turn: 'turn',
    options: {cursor: 'native+cursor', item: null}});
  const held = get('?project=example&id=thread&turn=held');
  await reading;
  try {
    await writeFile(portfolioPath, JSON.stringify({...seed,
      projects: [{...seed.projects[0], cwd: resolve(tmpdir(), 'new-workspace')}]}));
  } finally {
    release();
  }
  const rejected = await held;
  assert.equal(rejected.status, 404);
  assert.equal((await rejected.json()).entries, undefined);
});

test('Codex loopback configuration refuses missing credentials, remote URLs and mixed transports', async t => {
  const {directory, start} = await runtimeFixture(t);
  const realDirectory = await realpath(directory);
  const tokenFile = join(realDirectory, 'codex-local.token');
  await writeFile(tokenFile, 'not_a_real_credential_'.repeat(3), {mode: 0o600});
  await assert.rejects(start({directory: realDirectory, loopbackUrl: 'ws://127.0.0.1:3456'}), /ローカル接続先/);
  await assert.rejects(start({directory: realDirectory, loopbackUrl: 'ws://127.0.0.1:3456',
    loopbackTokenFile: tokenFile, socket: join(realDirectory, 'unused.sock')}), /ローカル接続先/);
  await assert.rejects(start({directory: realDirectory, loopbackUrl: 'ws://192.0.2.1:3456', loopbackTokenFile: tokenFile}), error =>
    error instanceof TypeError && !String(error).includes('not_a_real_credential'));
});

test('local speech runs only after an authenticated explicit request and returns uncached audio', {timeout: 15000}, async t => {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify(seed), {mode: 0o600});
  const requested = [];
  let release;
  let reached;
  const starting = new Promise(resolve => { reached = resolve; });
  const wav = Buffer.from('524946462400000057415645666d74201000000001000100803e0000007d0000020010006461746100000000', 'hex');
  const app = await start({codex: {}, speech: {available: async () => true, async synthesize(text, {signal}) {
    requested.push(text);
    reached();
    await new Promise(resolve => { release = resolve; });
    assert.equal(signal.aborted, false);
    return wav;
  }}});
  const path = '/api/chat/speech?project=example';
  const request = (text, {cookie, origin = app.url, suffix = ''} = {}) => fetch(app.url + path + suffix, {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', ...(cookie ? {cookie} : {})},
    body: JSON.stringify({text}),
  });
  assert.equal((await request('認証なし')).status, 401);
  const cookie = await login(app);
  const {capabilities} = await (await fetch(app.url + '/api/session', {headers: {cookie}})).json();
  assert.equal(capabilities.localSpeech, true);
  assert.equal((await fetch(app.url + path, {headers: {cookie}})).status, 404);
  assert.equal((await request('別のサイト', {cookie, origin: 'https://example.invalid'})).status, 403);
  assert.equal((await request('対象が曖昧', {cookie, suffix: '&project=example'})).status, 404);
  assert.equal((await request(' ', {cookie})).status, 400);
  assert.equal((await request('音'.repeat(2001), {cookie})).status, 400);
  assert.equal(requested.length, 0);
  const phrase = '保存した回答を読み上げます。';
  const speaking = request(phrase, {cookie});
  await starting;
  try {
    assert.equal((await request('重複読み上げ', {cookie})).status, 409);
  } finally { release(); }
  const response = await speaking;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  assert.deepEqual(requested, [phrase]);
});

test('a new speech request waits for an aborted request to release its workspace', {timeout: 15000}, async t => {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify(seed), {mode: 0o600});
  let began;
  let closed;
  let checked;
  let release;
  let checks = 0;
  const oldStarted = new Promise(resolve => { began = resolve; });
  const oldAborted = new Promise(resolve => { closed = resolve; });
  const nextChecked = new Promise(resolve => { checked = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const heard = [];
  const app = await start({codex: {}, speech: {
    async available() { if (++checks === 2) checked(); return true; },
    async synthesize(text, {signal}) {
      heard.push(text);
      if (heard.length === 1) {
        signal.addEventListener('abort', closed, {once: true});
        began();
        await cleanup;
        signal.throwIfAborted();
      }
      return Buffer.from('fixture audio');
    },
  }});
  const cookie = await login(app);
  const url = app.url + '/api/chat/speech?project=example';
  const request = (text, signal) => fetch(url, {method: 'POST', headers: {cookie, Origin: app.url, 'Content-Type': 'application/json'},
    body: JSON.stringify({text}), signal});
  const controller = new AbortController();
  const canceled = assert.rejects(request('最初の回答', controller.signal), {name: 'AbortError'});
  try {
    await oldStarted;
    controller.abort();
    await oldAborted;
    const later = request('次の回答');
    await nextChecked;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(heard, ['最初の回答']);
    release();
    const result = await later;
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'fixture audio');
  } finally {
    controller.abort();
    release();
    await canceled;
  }
  assert.deepEqual(heard, ['最初の回答', '次の回答']);
});

test('execution activity is owner-scoped and returns only status metadata', async t => {
  const {app, directory, reads} = await fixture(t);
  const observedAt = '2026-01-01T00:00:00.000Z';
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  const insert = db.prepare(`INSERT INTO codex_operations
    (id,project,workspace,fingerprint,phase,threadId,turnId,createdAt,updatedAt,startedAt,output)
    VALUES (?,?,?,'private-digest',?,'private-thread','private-turn',?,?,?,'private-output')`);
  const fixtureScope = seed.projects[0].cwd;
  insert.run('fixture-operation', 'example', fixtureScope, 'interrupted', observedAt, observedAt, observedAt);
  insert.run('out-of-scope-operation', 'example', resolve(tmpdir(), 'different-workspace'), 'running', '2026-02-01T00:00:00.000Z', observedAt, observedAt);
  insert.run('different-project-operation', 'another', fixtureScope, 'running', '2026-02-01T00:00:00.000Z', observedAt, observedAt);
  db.close();
  const url = `${app.url}/api/execution/activity`;
  assert.equal((await fetch(`${url}?project=example`)).status, 401);
  const cookie = await login(app);
  const call = path => fetch(app.url + path, {headers: {cookie}});
  assert.equal((await (await call('/api/session')).json()).capabilities.executionActivity, true);
  assert.equal((await call('/api/execution/activity?project=EXAMPLE')).status, 404);
  assert.equal((await call('/api/execution/activity?project=another')).status, 404);
  assert.equal((await call('/api/execution/activity?project=example&project=another')).status, 404);
  const result = await call('/api/execution/activity?project=example');
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {activity: {id: 'fixture-operation', kind: 'codex',
    phase: 'interrupted', observedAt, createdAt: observedAt, startedAt: observedAt, terminal: true}});
  assert.equal(reads(), 0);
});

test('native activity is opt-in and scoped and cannot hide ordinary activity on native failure', async t => {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({...seed, projects: [
    ...seed.projects, {id: 'no-workspace', name: 'No workspace'},
  ]}), {mode: 0o600});
  let calls = 0;
  const witnessed = {status: 'observed', observedAt: '2026-11-27T06:30:00.000Z', unconfirmed: 0,
    truncated: false, live: [], transitions: []};
  const app = await start({codex: {async readActivity(scope, watches, {isManaged}) {
    calls++;
    assert.deepEqual(scope, [seed.projects[0].cwd]);
    assert.deepEqual(watches, [{threadId: 'activity-thread', turnId: 'activity-turn'}]);
    assert.equal(isManaged('managed-thread'), true);
    assert.equal(isManaged('other-thread'), true);
    assert.equal(isManaged('foreign-thread'), false);
    if (calls > 1) throw new Error('private fixture error');
    return witnessed;
  }}});
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  const insert = db.prepare(`INSERT INTO codex_operations
    (id,project,workspace,fingerprint,phase,threadId,turnId,createdAt,updatedAt)
    VALUES (?,?,?,'digest','completed',?,'turn','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
  insert.run('managed-operation', 'example', seed.projects[0].cwd, 'managed-thread');
  insert.run('other-operation', 'no-workspace', seed.projects[0].cwd, 'other-thread');
  insert.run('foreign-operation', 'no-workspace', resolve(tmpdir(), 'foreign-activity-scope'), 'foreign-thread');
  db.close();
  const url = app.url + '/api/execution/activity';
  const query = '?project=example&native=1&watch=activity-thread:activity-turn';
  assert.equal((await fetch(url + query)).status, 401);
  const cookie = await login(app);
  const get = params => fetch(url + params, {headers: {cookie}});
  assert.equal((await get('?project=foreign&native=1')).status, 404);
  for (const invalid of ['&watch=one:two:three', '&watch=one:two%0A', '&watch=one:two&watch=one:two',
    '&watch=one:two&watch=two:three&watch=three:four&watch=four:five', '&native=1']) {
    assert.equal((await get('?project=example&native=1' + invalid)).status, 400);
  }
  assert.equal((await (await get('?project=no-workspace&native=1')).json()).nativeActivity.status, 'unconfigured');
  const ordinary = await (await get('?project=example')).json();
  assert.equal(ordinary.activity.id, 'managed-operation');
  assert.deepEqual(Object.keys(ordinary), ['activity']);
  assert.equal(calls, 0);
  assert.deepEqual(await (await get(query)).json(), {...ordinary, nativeActivity: witnessed});
  const failure = await (await get(query)).json();
  assert.deepEqual(failure.activity, ordinary.activity);
  assert.deepEqual(failure.nativeActivity, {...witnessed, status: 'unavailable', observedAt: null});
  assert.equal(calls, 2);
});

test('opt-in native activity times out while preserving reconciliation of a saved Codex operation', async t => {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify(seed), {mode: 0o600});
  let aborted = false;
  let reconciliations = 0;
  const app = await start({codex: {
    async findSubmission() { reconciliations++; return {id: 'turn', status: 'completed'}; },
    async readActivity(_scope, _watch, {signal}) {
      signal.addEventListener('abort', () => { aborted = true; }, {once: true});
      return new Promise(() => {});
    },
  }});
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  db.prepare(`INSERT INTO codex_operations
    (id,project,workspace,fingerprint,phase,threadId,turnId,createdAt,updatedAt)
    VALUES ('saved','example',?,'digest','unconfirmed','thread','turn','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`)
    .run(seed.projects[0].cwd);
  db.close();
  const cookie = await login(app);
  const response = await fetch(app.url + '/api/execution/activity?project=example&native=1',
    {headers: {cookie}, signal: AbortSignal.timeout(10000)});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activity.id, 'saved');
  assert.equal(body.activity.phase, 'completed');
  assert.equal(body.nativeActivity.status, 'unavailable');
  assert.equal(reconciliations, 1);
  assert.equal(aborted, true);
});

test('an imported conversation survives restart and rejected cross-origin requests never write it', async t => {
  const {app, start} = await fixture(t);
  const cookie = await login(app);
  const payload = {conversations: [{id: 'conversation-1', title: '公式書き出しの試験', current_node: 'reply', mapping: {
    input: {parent: null, message: {author: {role: 'user'}, content: {parts: ['選択した会話']}}},
    reply: {parent: 'input', message: {author: {role: 'assistant'}, content: {parts: ['保存した回答']}}},
    other: {parent: 'input', message: {author: {role: 'assistant'}, content: {parts: ['選択されなかった枝']}}},
  }}]};
  const upload = origin => fetch(`${app.url}/api/chat/import?project=example`, {
    method: 'POST', headers: {cookie, Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(payload),
  });
  assert.equal((await upload('https://other.example')).status, 403);
  assert.equal((await upload(app.url)).status, 200);
  assert.equal((await upload(app.url)).status, 200);
  await app.close();
  const reopened = await start({codex: {}});
  const reopenedCookie = await login(reopened);
  const response = await fetch(`${reopened.url}/api/chat?project=example`, {headers: {cookie: reopenedCookie}});
  const {conversations} = await response.json();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].messages, undefined);
  const detail = await fetch(`${reopened.url}/api/chat?project=example&id=conversation-1`, {headers: {cookie: reopenedCookie}});
  const {conversation} = await detail.json();
  assert.deepEqual(conversation.messages.map(message => message.text), ['選択した会話', '保存した回答']);
});

test('project execution settings block native dispatch in API-only mode and stay fixed while running', async t => {
  const {directory, start} = await runtimeFixture(t);
  const work = join(directory, 'workspaces', 'example');
  await mkdir(work, {recursive: true, mode: 0o700});
  await writeFile(join(work, '.hq-owned-workspace'), 'example\n');
  const project = {id: 'example', name: 'Fixture', cwd: work, enableCodexWrite: true};
  const writeProject = () => writeFile(join(directory, 'portfolio.json'), JSON.stringify({projects: [project]}), {mode: 0o600});
  await writeProject();
  let submits = 0;
  let steers = 0;
  const native = {
    canWrite: true, subscriptionReady: async () => true,
    models: async () => ({accountType: 'chatgpt', data: [{id: 'current', isDefault: true,
      defaultReasoningEffort: 'low', reasoningEfforts: [{reasoningEffort: 'low'}]}]}),
    async submit(input) {
      submits++;
      assert.equal(input.model, 'current');
      assert.equal(input.effort, 'low');
      assert.equal(input.onThread('fixture-thread'), true);
      return {turn: {id: 'fixture-turn', status: 'inProgress'}};
    },
    async steer() { steers++; return 'fixture-turn'; },
  };
  const app = await start({codex: native});
  const cookie = await login(app);
  const call = (path, body) => fetch(app.url + path + '?project=example', {method: body ? 'POST' : 'GET',
    headers: {cookie, ...(body ? {Origin: app.url, 'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {})});
  const settings = '/api/execution/settings';
  assert.equal((await (await call(settings)).json()).settings.mode, 'subscription-only');
  const apiOnly = await call(settings, {revision: 0, settings: {mode: 'api-only'}});
  assert.equal(apiOnly.status, 200);
  const task = {id: 'task-policy-check', prompt: 'A fixture'};
  assert.equal((await call('/api/codex/run', task)).status, 409);
  assert.equal((await call('/api/codex/run', {...task, route: 'subscription'})).status, 409);
  assert.equal(submits, 0);
  assert.equal((await call(settings, {revision: 1, settings: {mode: 'hybrid', stageRoutes: {design: 'api'}}})).status, 200);
  assert.equal((await call('/api/codex/run', {...task, stage: 'design'})).status, 409);
  const override = await call('/api/codex/run', {...task, stage: 'design', route: 'subscription'});
  assert.equal(override.status, 202);
  assert.equal((await override.json()).operation.stage, 'design');
  assert.equal(submits, 1);
  assert.equal((await call(settings, {revision: 2, settings: {mode: 'api-only'}})).status, 409);
  project.state = 'paused';
  await writeProject();
  assert.equal((await call('/api/codex/steer', {id: 'fixture-steering', operationId: task.id, prompt: 'A change'})).status, 409);
  assert.equal(steers, 0);
});

test('Codex cancellation is owner-scoped and closes the exact pre-send receipt without dispatch', async t => {
  const {directory, start} = await runtimeFixture(t);
  const cwd = join(directory, 'workspaces', 'example');
  await mkdir(cwd, {recursive: true, mode: 0o700});
  await writeFile(join(cwd, '.hq-owned-workspace'), 'example\n');
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({projects: [
    {id: 'example', name: 'Fixture', cwd, enableCodexWrite: true},
    {id: 'foreign', name: 'Foreign fixture'},
  ]}), {mode: 0o600});
  let canSubmit;
  const app = await start({codex: {
    canWrite: true, subscriptionReady: async () => true,
    models: async () => ({accountType: 'chatgpt', data: [{id: 'current', isDefault: true,
      defaultReasoningEffort: 'low', reasoningEfforts: [{reasoningEffort: 'low'}]}]}),
    async submit(input) { canSubmit = input.onThread; return new Promise(() => {}); },
    async interrupt() { assert.fail('A pre-send cancellation cannot interrupt a native turn'); },
  }});
  const cookie = await login(app);
  const id = 'fixture-cancelled-operation';
  const request = (path, body, {authenticated = true, origin = app.url} = {}) => fetch(app.url + path, {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', ...(authenticated ? {cookie} : {})},
    body: JSON.stringify(body),
  });
  const cancelPath = '/api/codex/cancel?project=example';
  assert.equal((await request('/api/codex/run?project=example', {id, prompt: 'Fixture'})).status, 202);
  assert.equal((await request(cancelPath, {id}, {authenticated: false})).status, 401);
  assert.equal((await request(cancelPath, {id}, {origin: 'https://other.example'})).status, 403);
  assert.equal((await request(cancelPath + '&project=foreign', {id})).status, 404);
  const response = await request(cancelPath, {id});
  assert.equal(response.status, 202);
  assert.equal((await response.json()).operation.phase, 'cancelled');
  assert.equal(canSubmit('late-thread'), false);
  const activity = await fetch(app.url + '/api/execution/activity?project=example', {headers: {cookie}});
  assert.equal((await activity.json()).activity.phase, 'cancelled');
});

test('a scoped ChatGPT plan stream preserves text and never repeats the provider call on replay', async t => {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify(seed), {mode: 0o600});
  let runs = 0;
  let pauseDuringCatalog = false;
  const plan = {auth: {async status() { return {configured: true, status: 'connected'}; }}, responses: {
    async models() {
      if (pauseDuringCatalog) await writeFile(join(directory, 'portfolio.json'), JSON.stringify({...seed,
        projects: [{...seed.projects[0], state: 'paused'}]}), {mode: 0o600});
      return [{slug: 'fixture-model', displayName: 'Fixture model'}];
    },
    async *stream({model, messages}) {
      runs++;
      assert.equal(model, 'fixture-model');
      assert.deepEqual(messages, [{role: 'user', content: '質問'}]);
      yield '回答';
      yield 'です。';
    },
  }};
  const app = await start({codex: {}, plan});
  const cookie = await login(app);
  const data = {id: 'turn-integration', prompt: '質問', model: 'fixture-model'};
  const send = (origin, payload = data) => fetch(`${app.url}/api/chat/live?project=example`, {method: 'POST',
    headers: {cookie, Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  assert.equal((await send('https://another.example')).status, 403);
  const first = await send(app.url);
  assert.match(first.headers.get('content-type'), /text\/event-stream/);
  const events = (await first.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['回答', 'です。']);
  assert.equal(events.at(-1).turn.status, 'completed');
  const id = events.at(-1).turn.conversationId;
  const replay = await send(app.url);
  assert.match(await replay.text(), /"status":"completed"/);
  assert.equal(runs, 1);
  const history = await fetch(`${app.url}/api/chat?project=example&id=${encodeURIComponent(id)}`, {headers: {cookie}});
  const {conversation} = await history.json();
  assert.equal(conversation.source, 'chatgpt-live');
  assert.deepEqual(conversation.messages.map(item => item.text), ['質問', '回答です。']);
  pauseDuringCatalog = true;
  assert.equal((await send(app.url, {...data, id: 'turn-after-pause'})).status, 409);
  assert.equal(runs, 1);
});
