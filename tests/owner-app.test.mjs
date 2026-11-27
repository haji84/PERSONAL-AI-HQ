import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {startOwnerApp} from '../app/server.mjs';
import {ensurePrivateDirectory} from '../app/private-directory.mjs';

const seed = {
  observedAt: '2026-11-27T06:25:00.000Z',
  projects: [{id: 'example', name: '検証用プロジェクト', state: 'unknown', goal: '帰属範囲の確認', cwd: '/fixture-scope'}],
  artifacts: [],
};

async function fixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hq-owner-test-'));
  const directory = join(fixtureRoot, 'runtime');
  await ensurePrivateDirectory(directory);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify(seed), {mode: 0o600});
  let nativeReads = 0;
  const app = await startOwnerApp({directory, port: 0, codex: {
    async listThreads(paths) {
      nativeReads++;
      assert.deepEqual(paths, ['/fixture-scope']);
      return {data: [], nextCursor: null};
    },
    async findSubmission() { nativeReads++; return null; },
  }});
  t.after(async () => {
    await app.close();
    const target = resolve(fixtureRoot);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    assert.ok(target.includes('hq-owner-test-'));
    await rm(target, {recursive: true, force: true});
  });
  return {app, directory, reads: () => nativeReads};
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
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=other`, {headers: {cookie}})).status, 404);
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=example`, {headers: {cookie}})).status, 200);
  assert.equal(reads(), 1);
});

test('execution activity is owner-scoped and returns only status metadata', async t => {
  const {app, directory, reads} = await fixture(t);
  const observedAt = '2026-01-01T00:00:00.000Z';
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  const insert = db.prepare(`INSERT INTO codex_operations
    (id,project,workspace,fingerprint,phase,threadId,turnId,createdAt,updatedAt,startedAt,output)
    VALUES (?,?,?,'private-digest',?,'private-thread','private-turn',?,?,?,'private-output')`);
  insert.run('fixture-operation', 'example', '/fixture-scope', 'interrupted', observedAt, observedAt, observedAt);
  insert.run('out-of-scope-operation', 'example', '/different-workspace', 'running', '2026-02-01T00:00:00.000Z', observedAt, observedAt);
  insert.run('different-project-operation', 'another', '/fixture-scope', 'running', '2026-02-01T00:00:00.000Z', observedAt, observedAt);
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

test('an imported conversation survives restart and rejected cross-origin requests never write it', async t => {
  const {app, directory} = await fixture(t);
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
  const reopened = await startOwnerApp({directory, port: 0, codex: {}});
  t.after(() => reopened.close());
  const reopenedCookie = await login(reopened);
  const response = await fetch(`${reopened.url}/api/chat?project=example`, {headers: {cookie: reopenedCookie}});
  const {conversations} = await response.json();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].messages, undefined);
  const detail = await fetch(`${reopened.url}/api/chat?project=example&id=conversation-1`, {headers: {cookie: reopenedCookie}});
  const {conversation} = await detail.json();
  assert.deepEqual(conversation.messages.map(message => message.text), ['選択した会話', '保存した回答']);
  await reopened.close();
});

test('project execution settings block native dispatch in API-only mode and stay fixed while running', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hq-policy-test-')));
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
  const app = await startOwnerApp({directory, port: 0, codex: native});
  t.after(async () => { await app.close(); await rm(directory, {recursive: true, force: true}); });
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
  assert.equal(submits, 0);
  assert.equal((await call(settings, {revision: 1, settings: {mode: 'subscription-only'}})).status, 200);
  assert.equal((await call('/api/codex/run', task)).status, 202);
  assert.equal(submits, 1);
  assert.equal((await call(settings, {revision: 2, settings: {mode: 'api-only'}})).status, 409);
  project.state = 'paused';
  await writeProject();
  assert.equal((await call('/api/codex/steer', {id: 'fixture-steering', operationId: task.id, prompt: 'A change'})).status, 409);
  assert.equal(steers, 0);
});

test('a scoped ChatGPT plan stream preserves text and never repeats the provider call on replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-chat-route-'));
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
  const app = await startOwnerApp({directory, port: 0, codex: {}, plan});
  t.after(async () => { await app.close(); await rm(directory, {recursive: true, force: true}); });
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
