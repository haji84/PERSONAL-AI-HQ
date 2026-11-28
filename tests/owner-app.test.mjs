import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareArtifactEvidenceReadback} from '../app/api-workspace.mjs';
import {startOwnerApp} from '../app/server.mjs';
import {createChatStore} from '../app/chat-store.mjs';
import {ExecutionStore} from '../app/execution-store.mjs';
import {ensurePrivateDirectory} from '../app/private-directory.mjs';

const seed = {
  observedAt: '2026-11-27T06:25:00.000Z',
  projects: [{id: 'example', name: '検証用プロジェクト', state: 'unknown', goal: '帰属範囲の確認', cwd: resolve(tmpdir(), 'fixture-scope')}],
  apiCreditObservation: {observedFrom: '2026-11-27T06:20:00.000Z', observedUntil: '2026-11-27T06:25:00.000Z',
    expiresOn: '2026-12-19', balanceUsd: 10, internalReference: 'private-fixture'},
  artifacts: [],
};

const ordinaryUsage = (overrides = {}) => ({observedAt: new Date().toISOString(),
  ordinaryUsageAllowed: true, windows: [{usedPercent: 20}], ...overrides});

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
  const anonymous = await fetch(`${app.url}/api/portfolio`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).appHostPlatform, undefined);
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=example`)).status, 401);
  assert.equal(reads(), 0);
  const cookie = await login(app);
  const response = await fetch(`${app.url}/api/portfolio`, {headers: {cookie}});
  assert.equal(response.status, 200);
  const portfolio = await response.json();
  assert.equal(portfolio.appHostPlatform, process.platform);
  assert.equal(portfolio.projects[0].name, '検証用プロジェクト');
  assert.equal(portfolio.projects[0].cwd, undefined);
  assert.equal(portfolio.apiCreditObservation.balanceUsd, 10);
  assert.equal(portfolio.apiCreditObservation.internalReference, undefined);
  assert.equal((await fetch(`${app.url}/api/usage`)).status, 401);
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=other`, {headers: {cookie}})).status, 404);
  assert.equal((await fetch(`${app.url}/api/codex/threads?project=example`, {headers: {cookie}})).status, 200);
  assert.equal(reads(), 1);
});

test('recent work outcomes survive sign-in and restart within the current authorized workspaces', async t => {
  let receiptDatabase;
  // Close the direct handle before the fixture removes the database on Windows.
  t.after(() => receiptDatabase?.close());
  const {directory, start} = await runtimeFixture(t);
  const native = {
    async findSubmission() { assert.fail('The portfolio must never reconcile native submissions'); },
    async readThread() { assert.fail('The portfolio must only read saved native outcomes'); },
  };
  const first = await start({codex: native});
  const other = {id: 'other', name: 'Other', cwd: resolve(tmpdir(), 'other-scope')};
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({...seed, projects: [...seed.projects, other]}), {mode: 0o600});
  const epoch = Date.now() - 60000;
  const at = value => new Date(epoch + value).toISOString();
  receiptDatabase = new DatabaseSync(join(directory, 'conversations.sqlite'));
  const add = receiptDatabase.prepare(`INSERT INTO codex_operations
    (project,id,workspace,fingerprint,phase,threadId,turnId,createdAt,updatedAt,startedAt,output)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const fingerprint = 'a'.repeat(64);
  const paths = {example:seed.projects[0].cwd, other:other.cwd};
  const put = (project, id, phase, sequence, {workspace = paths[project], thread = 'thread-' + id,
    turn = 'turn-' + id, started = at(1), observed = at(sequence)} = {}) =>
    add.run(project, id, workspace, fingerprint, phase, thread, turn, at(0), observed, started, 'PRIVATE_OUTCOME_OUTPUT');
  const expected = [];
  for (let n = 0; n < 10; n++) {
    const projectId = n % 3 ? 'example' : 'other';
    const id = 'verified-' + n;
    const phase = n % 2 ? 'completed' : 'failed';
    put(projectId, id, phase, n + 10);
    expected.unshift({projectId, id, kind:'codex', phase, observedAt:at(n + 10), threadId:'thread-' + id});
  }
  put('example', 'unsent-failure', 'failed', 30, {thread:null, turn:null, started:null});
  expected.unshift({projectId:'example', id:'unsent-failure', kind:'codex', phase:'failed', observedAt:at(30)});
  put('example', 'uncertain-result', 'unconfirmed', 110);
  put('example', 'cancelled-result', 'cancelled', 111);
  put('example', 'wrong-workspace', 'completed', 112, {workspace:other.cwd});
  put('missing', 'foreign-project', 'completed', 113, {workspace:other.cwd});
  put('example', 'synthetic-result', 'completed', 114, {thread:null, turn:null, started:null});
  put('example', 'malformed-time', 'failed', 115, {observed:'z-invalid'});
  put('example', 'future-result', 'completed', 116, {observed:at(120000)});
  put('example', 'invalid-sequence', 'failed', 117, {started:at(118)});
  const allRows = () => receiptDatabase.prepare('SELECT * FROM codex_operations ORDER BY rowid').all();
  const baseline = allRows();
  const read = (app, cookie) => fetch(app.url + '/api/portfolio', {headers: cookie ? {cookie} : {}});
  assert.equal((await read(first)).status, 401);
  const signIn = await login(first);
  const response = await read(first, signIn);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body).recentWorkOutcomes, expected.slice(0, 8));
  assert.ok(!body.includes('PRIVATE_OUTCOME_OUTPUT') && !body.includes(other.cwd));
  assert.deepEqual(allRows(), baseline);

  await first.close();
  const restarted = await start({codex:native});
  assert.equal((await read(restarted, signIn)).status, 401);
  const renewed = await login(restarted);
  assert.deepEqual((await (await read(restarted, renewed)).json()).recentWorkOutcomes, expected.slice(0, 8));
  assert.deepEqual(allRows(), baseline);
  const changed = {...other, cwd: resolve(tmpdir(), 'replacement-scope')};
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({...seed, projects: [...seed.projects, changed]}), {mode: 0o600});
  assert.deepEqual((await (await read(restarted, renewed)).json()).recentWorkOutcomes,
    expected.filter(item => item.projectId === 'example').slice(0, 8));
});

test('owned GitHub projects register in the dashboard without overwriting manual projects or granting execution', async t => {
  const {directory, start} = await runtimeFixture(t);
  const portfolioPath = join(directory, 'portfolio.json');
  const bytes = JSON.stringify({...seed, projects: [{...seed.projects[0], state: 'paused',
    repository: 'https://github.com/Fixture-Owner/Existing.git'}]});
  await writeFile(portfolioPath, bytes, {mode: 0o600});
  const owner = {login: 'fixture-owner', id: 41};
  const repo = (id, name, account = owner) => ({id, name, owner: account, fork: false, archived: false, disabled: false});
  let repositories = [repo(10, 'existing'), repo(11, 'new-work'), repo(12, 'foreign', {login: 'someone-else', id: 7})];
  let mode = 'ready', reads = 0, codexCalls = 0;
  let now = Date.parse('2026-11-27T14:00:00Z');
  const githubProjects = {owner: owner.login, now: () => now, async read() {
    reads++;
    if (mode === 'offline') throw new Error('internal fixture diagnostics');
    if (mode === 'reused-login') return {account:{login:owner.login, id:42}, repositories:[]};
    return {account: mode === 'wrong-owner' ? {login: 'different-account', id: 42} : owner, repositories};
  }};
  const options = {githubProjects, codex: {canWrite:true, async submit() { codexCalls++; },
    async listThreads() { return {data:[], nextCursor:null}; }}};
  let app = await start(options);
  const request = (route, options = {}) => fetch(app.url + route, options);
  assert.equal((await request('/api/portfolio')).status, 401);
  assert.equal(reads, 0);
  let cookie = await login(app);
  const get = async () => (await request('/api/portfolio', {headers: {cookie}})).json();
  async function until(check) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const state = await get();
      if (check(state)) return state;
      await delay(15);
    }
    assert.fail('Automatic registration did not reach the expected state');
  }

  let state = await until(value => value.githubRegistration?.status === 'ready');
  assert.deepEqual(state.projects.map(project => [project.id, project.state]), [['example', 'paused'], ['github-11', 'unknown']]);
  assert.equal(state.projects[1].codexScopes, 0);
  assert.equal(state.projects[1].codexWrite, false);
  assert.equal(state.projects[1].repository, 'https://github.com/fixture-owner/new-work');
  assert.equal(state.projects[1].registration, 'github');
  assert.equal(reads, 1);
  assert.equal((await request('/api/codex/run?project=github-11', {method: 'POST',
    headers: {cookie, Origin: app.url, 'Content-Type': 'application/json'}, body: JSON.stringify({id: 'accepted-id', prompt: 'do not run'})})).status, 409);
  assert.equal(codexCalls, 0);

  repositories = [repo(10, 'renamed-existing'), repo(11, 'renamed-new'), repo(13, 'existing')];
  now += 61_000;
  state = await until(value => value.projects.some(row => row.id === 'github-13'));
  assert.deepEqual(state.projects.map(row => row.id), ['example', 'github-13', 'github-11']);
  assert.equal(state.projects.find(row => row.id === 'github-11').name, 'renamed-new');
  assert.equal(state.projects[0].state, 'paused');
  assert.equal(await readFile(portfolioPath, 'utf8'), bytes);

  await app.close();
  mode = 'offline';
  app = await start(options);
  cookie = await login(app);
  state = await until(value => value.githubRegistration?.status === 'stale');
  assert.deepEqual(state.projects.map(row => row.id), ['example', 'github-13', 'github-11']);
  assert.ok(!JSON.stringify(state).includes('internal fixture diagnostics'));

  mode = 'wrong-owner';
  now += 61_000;
  state = await until(value => value.githubRegistration?.status === 'account-mismatch');
  assert.deepEqual(state.projects.map(row => row.id), ['example']);
  assert.equal(state.projects[0].state, 'paused');

  await app.close();
  mode = 'offline';
  app = await start(options);
  cookie = await login(app);
  state = await until(value => value.githubRegistration?.status === 'account-mismatch');
  assert.deepEqual(state.projects.map(row => row.id), ['example']);
  await app.close();
  const database = join(directory, 'conversations.sqlite');
  const damaged = new DatabaseSync(database);
  damaged.prepare('UPDATE github_project_snapshot SET blocked=0,repositories=?').run('[null]');
  damaged.close();
  app = await start(options);
  cookie = await login(app);
  state = await until(value => value.githubRegistration?.status === 'unavailable');
  assert.deepEqual(state.projects.map(row => row.id), ['example']);
  assert.equal((await request('/api/codex/threads?project=example', {headers: {cookie}})).status, 200);
  await app.close();

  mode = 'reused-login';
  now += 61_000;
  app = await start(options);
  cookie = await login(app);
  state = await until(value => value.githubRegistration?.status === 'account-mismatch');
  assert.deepEqual(state.projects.map(row => row.id), ['example']);
  await app.close();
  const retained = new DatabaseSync(database);
  try {
    const saved = retained.prepare('SELECT account_id,blocked,links FROM github_project_snapshot').get();
    assert.equal(saved.account_id, 41);
    assert.equal(saved.blocked, 1);
    assert.equal(JSON.parse(saved.links)[0].id, 10);
  } finally {
    retained.close();
  }
  mode = 'ready';
  now += 61_000;
  app = await start(options);
  cookie = await login(app);
  state = await until(value => value.githubRegistration?.status === 'ready');
  assert.deepEqual(state.projects.map(row => row.id), ['example', 'github-13', 'github-11']);
  await app.close();

  const manual = JSON.parse(bytes);
  manual.projects.push({...manual.projects[0], id:'same-repository'});
  await writeFile(portfolioPath, JSON.stringify(manual));
  const isolated = new DatabaseSync(database);
  isolated.exec('DELETE FROM github_project_snapshot');
  isolated.close();
  mode = 'ready';
  repositories = [repo(15, 'existing')];
  now += 61_000;
  app = await start(options);
  cookie = await login(app);
  state = await until(value => value.githubRegistration?.status === 'ready');
  assert.deepEqual(state.projects.map(row => row.id), ['example', 'same-repository']);
  const snapshot = new DatabaseSync(database, {readOnly:true});
  try {
    assert.deepEqual(JSON.parse(snapshot.prepare('SELECT links FROM github_project_snapshot').get().links), []);
  } finally {
    snapshot.close();
  }
});

test('registration saves the initial execution policy before any work and preserves it across restart', async t => {
  const {directory, start} = await runtimeFixture(t);
  const portfolioPath = join(directory, 'portfolio.json');
  const oldProject = {...seed.projects[0], state:'approval', enableCodexWrite:false, retained:{value:'existing-data'}};
  await writeFile(portfolioPath, JSON.stringify({...seed, projects:[oldProject]}), {mode:0o600});
  let nativeStarts = 0, modelReads = 0;
  const codex = {
    canWrite:true, subscriptionReady:async () => true,
    usage: async () => ordinaryUsage(),
    models:async () => {
      modelReads++;
      return {accountType:'chatgpt', data:[{id:'current', isDefault:true, defaultReasoningEffort:'low',
        reasoningEfforts:[{reasoningEffort:'low'}]}]};
    },
    async submit(input) {
      nativeStarts++;
      await input.beforeTurn?.();
      assert.ok(input.onThread('registration-thread'));
      return {turn:{id:'registration-turn', status:'inProgress'}};
    },
  };
  let app = await start({codex});
  let cookie;
  const get = route => fetch(app.url + route, {headers:{cookie}});
  const post = (route, body, origin = app.url) => fetch(app.url + route, {method:'POST',
    headers:{...(cookie && {cookie}), Origin:origin, 'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const path = '/api/portfolio/projects';
  const first = {requestId:randomUUID(), name:'API fixture', goal:'Verify routing before dispatch',
    settings:{mode:'api-only', apiBudgetUsd:0.25, model:'current', reasoningEffort:'low'}};
  const second = {requestId:randomUUID(), name:'Subscription fixture'};
  assert.equal((await post(path, first)).status, 401);
  cookie = await login(app);
  assert.equal((await post(path, first, 'https://untrusted.invalid')).status, 403);
  assert.equal((await post(path, {...first, cwd:'/outside', enableCodexWrite:true})).status, 400);
  const strandedChat = {requestId:randomUUID(), name:'Unassigned history'};
  const strandedCodex = {requestId:randomUUID(), name:'Unassigned operation'};
  const strandedPolicy = {requestId:randomUUID(), name:'Unassigned policy'};
  const existingStore = new ExecutionStore(join(directory,'execution-policy.json'), {authorityId:'personal-ai-hq-local'});
  existingStore.updateSettings(('project-' + strandedPolicy.requestId).toUpperCase(), 0, {mode:'api-only', apiBudgetUsd:0.75});
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  try {
    db.prepare('INSERT INTO conversations(project,id,title,imported_at,modified,messages) VALUES (?,?,?,?,?,?)')
      .run(('project-' + strandedChat.requestId).toUpperCase(), 'old-chat', 'Old chat', '2026-11-27T00:00:00Z', 0, '[]');
    db.prepare('INSERT INTO codex_operations(project,id,workspace,fingerprint,phase,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run('project-' + strandedCodex.requestId, 'old-operation', directory, '0'.repeat(64), 'completed',
        '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z');
  } finally { db.close(); }
  assert.equal((await post(path, strandedChat)).status, 409);
  assert.equal((await post(path, strandedCodex)).status, 409);
  assert.equal((await post(path, strandedPolicy)).status, 409);
  assert.equal((await post(path, {...first, name:'Unusable\u0000name'})).status, 400);
  assert.equal((await post(path, {...first, settings:{mode:'api-only', allowedRoutes:['subscription']}})).status, 400);
  assert.deepEqual(JSON.parse(await readFile(portfolioPath, 'utf8')).projects, [oldProject]);
  assert.equal((await (await get('/api/session')).json()).capabilities.projectRegistration, true);
  assert.equal((await (await get('/api/portfolio')).json()).newProjectExecutionSettings.mode, 'subscription-only');

  const [apiReg, subReg] = await Promise.all([post(path, first), post(path, second)]);
  assert.equal(apiReg.status, 201);
  assert.equal(subReg.status, 201);
  const api = await apiReg.json();
  const sub = await subReg.json();
  assert.notEqual(api.id, sub.id);
  assert.equal(api.revision, 0);
  assert.ok(Number.isFinite(Date.parse(api.updatedAt)));
  assert.equal(api.settings.mode, 'api-only');
  assert.equal(api.settings.apiBudgetUsd, 0.25);
  assert.equal(sub.settings.mode, 'subscription-only');
  const replay = await post(path, first);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), api);
  assert.equal((await post(path, {...first, name:'Different'})).status, 409);

  const auto = await post(path, {requestId:randomUUID(), name:'Automatic', settings:{mode:'auto', preference:'api-first',
    allowedRoutes:['api','subscription'], allowFallback:true}});
  const hybrid = await post(path, {requestId:randomUUID(), name:'Hybrid', settings:{mode:'hybrid',
    stageRoutes:{design:'api', implementation:'subscription'}}});
  assert.equal(auto.status, 201);
  assert.equal(hybrid.status, 201);
  assert.equal((await auto.json()).settings.allowFallback, true);
  const hybridResult = await hybrid.json();
  assert.equal(hybridResult.settings.stageRoutes.design, 'api');
  const original = await readFile(portfolioPath, 'utf8');
  const changed = JSON.parse(original);
  const changedHybrid = changed.projects.find(row => row.id === hybridResult.id);
  changedHybrid.initialExecution.settings.model = 'outside-policy-revision';
  await writeFile(portfolioPath, JSON.stringify(changed));
  assert.equal((await get('/api/execution/settings?project=' + hybridResult.id)).status, 409);
  delete changedHybrid.registrationRequestId;
  delete changedHybrid.initialExecution;
  await writeFile(portfolioPath, JSON.stringify(changed));
  assert.equal((await get('/api/execution/settings?project=' + hybridResult.id)).status, 409);
  await writeFile(portfolioPath, original);

  const view = await (await get('/api/portfolio')).json();
  assert.equal(view.projects.length, 5);
  assert.equal(view.projects.find(row => row.id === oldProject.id).state, 'approval');
  for (const id of [api.id, sub.id]) {
    const row = view.projects.find(project => project.id === id);
    assert.equal(row.state, 'waiting');
    assert.equal(row.codexScopes, 0);
    assert.equal(row.codexWrite, false);
    assert.equal(row.cwd, undefined);
    assert.equal(row.initialExecution, undefined);
    assert.equal(row.registrationRequestId, undefined);
  }
  assert.equal((await post('/api/codex/run?project=' + sub.id, {id:'fixture-run', prompt:'Do not start'})).status, 403);
  assert.equal(nativeStarts, 0);
  assert.equal(modelReads, 0);

  await app.close();
  const definition = JSON.parse(await readFile(portfolioPath, 'utf8'));
  assert.deepEqual(definition.projects[0], oldProject);
  for (const id of [api.id, sub.id]) {
    const row = definition.projects.find(project => project.id === id);
    const work = join(directory, 'workspaces', id);
    await mkdir(work, {recursive:true, mode:0o700});
    await writeFile(join(work, '.hq-owned-workspace'), id + '\n');
    Object.assign(row, {cwd:work, enableCodexWrite:true, state:'unknown'});
    if (id === api.id) Object.assign(row, {name:'Host-renamed API fixture', goal:'Host-updated goal'});
  }
  await writeFile(portfolioPath, JSON.stringify(definition));
  app = await start({codex});
  cookie = await login(app);
  const apiSettings = '/api/execution/settings?project=' + api.id;
  const persisted = await (await get(apiSettings)).json();
  assert.equal(persisted.settings.mode, 'api-only');
  assert.equal(persisted.settings.model, 'current');
  assert.equal(persisted.settings.reasoningEffort, 'low');
  assert.equal(persisted.updatedAt, api.updatedAt);
  const request = {id:'fixture-run', prompt:'Controlled fixture'};
  assert.equal((await post('/api/codex/run?project=' + api.id, request)).status, 409);
  assert.equal((await post('/api/codex/run?project=' + api.id, {...request, route:'subscription'})).status, 409);
  assert.equal(modelReads, 0);
  assert.equal(nativeStarts, 0);
  assert.equal((await post('/api/codex/run?project=' + sub.id, request)).status, 202);
  assert.equal(nativeStarts, 1);
  const revised = await post(apiSettings, {revision:0, settings:{apiBudgetUsd:0.15}});
  assert.equal(revised.status, 200);
  const revision = await revised.json();
  assert.equal(revision.revision, 1);
  assert.equal(revision.settings.mode, 'api-only');
  assert.equal(revision.settings.model, 'current');
  assert.equal((await post(apiSettings, {revision:0, settings:{mode:'subscription-only'}})).status, 409);
  const replayAfterUpdate = await post(path, first);
  assert.equal(replayAfterUpdate.status, 200);
  assert.equal((await replayAfterUpdate.json()).revision, 1);
  assert.equal((await (await get('/api/execution/settings?project=' + sub.id)).json()).settings.mode, 'subscription-only');
});

test('GitHub registration promotes only a fresh eligible candidate and preserves known projects', async t => {
  const {directory, start} = await runtimeFixture(t);
  const file = join(directory, 'portfolio.json');
  const oldProject = {...seed.projects[0], state:'paused', repository:'https://github.com/fixture-owner/known'};
  await writeFile(file, JSON.stringify({...seed, projects:[oldProject]}), {mode:0o600});
  const owner = {login:'fixture-owner', id:41};
  const repo = (id, name, archived = false) => ({id, name, owner, archived, fork:false, disabled:false});
  let now = Date.parse('2026-11-27T14:00:00Z');
  const app = await start({codex:{}, githubProjects:{owner:owner.login, now:() => now,
    async read() { return {account:owner, repositories:[repo(11,'known'), repo(12,'discovered'), repo(13,'archived',true),repo(14,'stale')]}; }}});
  const cookie = await login(app);
  const post = (githubProject, requestId = randomUUID()) => fetch(app.url + '/api/portfolio/projects', {method:'POST',
    headers:{cookie, Origin:app.url, 'Content-Type':'application/json'}, body:JSON.stringify({requestId, githubProject,
      settings:{mode:'api-only', apiBudgetUsd:0}})});
  assert.equal((await post('github-12')).status, 409);
  let portfolio;
  for (let attempt = 0; attempt < 25; attempt++) {
    portfolio = await (await fetch(app.url + '/api/portfolio', {headers:{cookie}})).json();
    if (portfolio.githubRegistration.status === 'ready') break;
    await delay(15);
  }
  assert.equal(portfolio.githubRegistration.status, 'ready');
  assert.equal(portfolio.projects.find(row => row.id === 'github-12').registrationAvailable, true);
  assert.equal(portfolio.projects.find(row => row.id === 'github-12').executionSummary,undefined);
  assert.equal(portfolio.projects.find(row => row.id === 'github-13').registrationAvailable, false);
  assert.equal((await post('github-11')).status, 409);
  assert.equal((await post('github-13')).status, 409);
  const requestId = randomUUID();
  const registered = await post('github-12', requestId);
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).id, 'github-12');
  assert.equal((await post('github-12')).status, 409);
  now += 121_000;
  assert.equal((await post('github-14')).status, 409);
  assert.equal((await post('github-12', requestId)).status, 200);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.projects.length, 2);
  assert.deepEqual(saved.projects[0], oldProject);
  assert.equal(saved.projects[1].name, 'discovered');
  assert.equal(saved.projects[1].repository, 'https://github.com/fixture-owner/discovered');
  assert.equal(saved.projects[1].state, 'waiting');
  assert.equal(saved.projects[1].enableCodexWrite, undefined);
});

test('portfolio separates saved modes, accepted route evidence and authoritative stop reasons', async t => {
  const {directory,start} = await runtimeFixture(t);
  const checkout = id => join(directory,'workspaces',id);
  const fixed = {observedAt:new Date().toISOString(), projects:[
    {id:'managed',name:'Managed',state:'unknown',cwd:checkout('managed'),enableCodexWrite:true},
    {id:'uncertain-status',name:'Unrecognized response',cwd:checkout('uncertain-status'),enableCodexWrite:true},
    {id:'stale',name:'Stale',cwd:checkout('stale')},
    {id:'paused',name:'Paused',state:'paused',cwd:checkout('paused')},
    {id:'api-approved',name:'API receipt',cwd:checkout('api-approved')},
    {id:'api-pending',name:'API intent',cwd:checkout('api-pending')},
    {id:'removed-scope',name:'Changed workspace',cwd:checkout('different')},
  ]};
  for (const id of ['managed','uncertain-status']) {
    await mkdir(checkout(id),{recursive:true,mode:0o700});
    await writeFile(join(checkout(id),'.hq-owned-workspace'),id+'\n');
  }
  await writeFile(join(directory,'portfolio.json'),JSON.stringify(fixed),{mode:0o600});
  let providerCalls = 0, observerCalls = 0, listener;
  const app = await start({codex:{
    canWrite:true, subscriptionReady:async()=>true,
    usage: async () => ordinaryUsage(),
    models:async()=>({accountType:'chatgpt',data:[{id:'current',isDefault:true,reasoningEfforts:[]}]}),
    onEvent(fn) { listener=fn; return ()=>{}; },
    async submit(input) {
      providerCalls++;
      if (input.workspace === checkout('uncertain-status')) {
        await input.beforeTurn?.();
        assert.ok(input.onThread('unknown-thread'));
        return {turn:{id:'unknown-turn',status:'unrecognized'}};
      }
      await input.beforeTurn?.();
      assert.ok(input.onThread('managed-thread'));
      return {turn:{id:'managed-turn',status:'inProgress'}};
    },
    async findSubmission() { observerCalls++; return null; },
    async readActivity() { observerCalls++; return null; },
  }});
  const date = new Date(Date.now()-2_000).toISOString();
  const past = new Date(Date.now()-20*60_000).toISOString();
  const operationFields = ['stale','paused','removed-scope'];
  const db = new DatabaseSync(join(directory,'conversations.sqlite'));
  try {
    const insert=db.prepare('INSERT INTO codex_operations(project,id,workspace,fingerprint,phase,threadId,turnId,createdAt,updatedAt,startedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const id of operationFields) {
      const seen=id==='stale' ? past : date;
      insert.run(id,'saved-job',checkout(id),'0'.repeat(64),'running','old-thread','old-turn',seen,seen,seen);
    }
  } finally { db.close(); }
  const storePath=join(directory,'execution-policy.json');
  const store=new ExecutionStore(storePath,{authorityId:'personal-ai-hq-local'});
  for (const id of ['paused','api-approved','api-pending']) store.updateSettings(id,0,{mode:'api-only'});
  const state=JSON.parse(await readFile(storePath,'utf8'));
  for (const id of ['api-approved','api-pending']) {
    state.projects[id].operations['route-work']={route:'api',status:'running',reservedMicros:500_000,costMicros:0,
      model:'stored-model',executorId:'owner-mac-responses',executionId:'private-execution-id',taskId:'route-work',
      settingsRevision:1,organizationId:'private-test-org',instructionDigest:'a'.repeat(64),fingerprint:'b'.repeat(64),
      createdAt:date,dispatchedAt:date,
      ...(id==='api-approved' && {providerReceipts:[{id:'resp_PrivateReceipt',observedAt:date,inputTokens:22,outputTokens:10,accountedMicros:5}]}),
    };
  }
  await writeFile(storePath,JSON.stringify(state),{mode:0o600});
  assert.equal((await fetch(app.url+'/api/portfolio')).status,401);
  const cookie=await login(app);
  const snapshot=async()=> {
    const response=await fetch(app.url+'/api/portfolio',{headers:{cookie}});
    assert.equal(response.status,200);
    return response.json();
  };
  const byId=(view,id)=>view.projects.find(project=>project.id===id).executionSummary;
  const post=(route,body)=>fetch(app.url+route,{method:'POST',headers:{cookie, Origin:app.url,'Content-Type':'application/json'},
    body:JSON.stringify(body)});
  const fileBefore=await readFile(storePath,'utf8');
  let view=await snapshot();
  assert.equal(byId(view,'managed').mode,'subscription-only');
  assert.equal(byId(view,'managed').modeSource,'default');
  assert.equal(byId(view,'managed').routeState,'unknown');
  assert.equal(byId(view,'stale').routeState,'unknown');
  assert.equal(byId(view,'stale').stopReason,'unconfirmed');
  assert.equal(byId(view,'paused').mode,'api-only');
  assert.equal(byId(view,'paused').modeSource,'saved');
  assert.equal(byId(view,'paused').route,'subscription');
  assert.equal(byId(view,'paused').routeState,'observed');
  assert.equal(byId(view,'paused').stopReason,'paused');
  assert.equal(byId(view,'api-approved').route,'api');
  assert.equal(byId(view,'api-approved').routeState,'observed');
  assert.equal(byId(view,'api-approved').stopReason,'unconfirmed');
  assert.equal(byId(view,'api-pending').routeState,'unknown');
  assert.equal(byId(view,'removed-scope').routeState,'unknown');
  assert.equal(JSON.stringify(view).includes('PrivateReceipt'),false);
  assert.equal(JSON.stringify(view).includes('private-test-org'),false);
  assert.equal(JSON.stringify(view).includes(checkout('managed')),false);
  assert.equal(await readFile(storePath,'utf8'),fileBefore);
  assert.equal(providerCalls,0);
  assert.equal(observerCalls,0);

  const cancellation = new DatabaseSync(join(directory,'conversations.sqlite'));
  try { cancellation.prepare("UPDATE codex_operations SET phase='cancelled',updatedAt=? WHERE project='stale'").run(date); }
  finally { cancellation.close(); }
  const changedLocally=byId(await snapshot(),'stale');
  assert.equal(changedLocally.routeState,'unknown');
  assert.equal(changedLocally.observedAt,null);
  assert.equal(changedLocally.stopReason,'cancelled');

  const started=await post('/api/codex/run?project=managed',{id:'managed-fixture',prompt:'Isolated accepted route test'});
  assert.equal(started.status,202);
  for(let attempt=0;attempt<20;attempt++){
    view=await snapshot();
    if (byId(view,'managed').routeState==='active') break;
    await delay(10);
  }
  assert.equal(byId(view,'managed').route,'subscription');
  assert.equal(byId(view,'managed').routeState,'active');
  assert.ok(Number.isFinite(Date.parse(byId(view,'managed').observedAt)));
  const live=byId(view,'managed');
  assert.equal(Date.parse(live.activeUntil)-Date.parse(live.observedAt),15000);
  assert.equal(Date.parse(live.observedUntil)-Date.parse(live.observedAt),15*60*1000);
  listener('turn/completed',{threadId:'managed-thread',turn:{id:'managed-turn',status:'completed'}});
  view=await snapshot();
  assert.equal(byId(view,'managed').routeState,'observed');
  const update=await post('/api/execution/settings?project=managed',{revision:0,settings:{mode:'api-only'}});
  assert.equal(update.status,200);
  const summary=(await update.json()).executionSummary;
  assert.equal(summary.mode,'api-only');
  assert.equal(summary.modeSource,'saved');
  assert.equal(summary.route,'subscription');
  assert.equal(summary.routeState,'observed');
  assert.equal(summary.stopReason,'api-disabled');
  assert.equal((await post('/api/codex/run?project=uncertain-status',{id:'unknown-fixture',prompt:'Controlled unknown status'})).status,202);
  for(let attempt=0;attempt<20;attempt++){
    view=await snapshot();
    if (byId(view,'uncertain-status').route) break;
    await delay(10);
  }
  assert.equal(byId(view,'uncertain-status').route,'subscription');
  assert.equal(byId(view,'uncertain-status').routeState,'observed');
  assert.equal(byId(view,'uncertain-status').stopReason,'unconfirmed');
  assert.equal(providerCalls,2);
  assert.equal(observerCalls,0);
});

test('route estimates use the matching saved settings while preserving the original timeline and unknown costs', async t => {
  const {directory, start} = await runtimeFixture(t);
  const time = new Date(Date.now() - 60_000).toISOString();
  const beforeTime = new Date(Date.parse(time) - 60_000).toISOString();
  const dueAt = new Date(Date.parse(time) + 3600_000).toISOString();
  const horizon = (optimistic, standard, cautious) => ({optimistic, standard, cautious});
  const tasks = [{id:'inspect',remainingMinutes:horizon(2,3,5)},
    {id:'implement',dependencies:['inspect'],remainingMinutes:horizon(5,9,15)},
    {id:'review',dependencies:['inspect'],remainingMinutes:horizon(4,8,14)}];
  const common = {recordedAt:time, target:'project', scope:'Verified fixture project requirements',
    firstUsableMinutes:horizon(4,8,13),basis:'Based on fixture evidence',
    assumptions:['Uses the current repository scope'],
    links:[{label:'Evidence',url:'https://github.com/fixture-owner/source/blob/revision/evidence.md'}]};
  const subscription = {...common, execution:{mode:'subscription-only'}, tasks, apiCostUsd:0, subscriptionTurns:3};
  const api = {...common, execution:{mode:'api-only',apiBudgetUsd:8}, tasks:[...tasks,{id:'device',externalWait:'unknown'}],
    firstUsableMinutes:horizon(5,10,20), apiCostUsd:0.423};
  const competing = {...common, target:'milestone', scope:'Unrelated scope',
    execution:{mode:'auto',preference:'balanced'},firstUsableMinutes:horizon(1,2,3)};
  const definition = {...seed, projects:[
    {...seed.projects[0], delivery:{estimates:[{dueAt},
      {...subscription,recordedAt:beforeTime,firstUsableMinutes:horizon(2,3,4)},
      subscription,api,competing]}},
    {id:'held',name:'Held fixture',state:'approval',delivery:{estimates:[subscription]}},
    {id:'unknown',name:'No estimates'},
    {id:'old',name:'Elapsed forecast',delivery:{estimates:[{...subscription,
      recordedAt:new Date(Date.now()-7200_000).toISOString()}]}},
    {id:'forbidden',name:'Forbidden-route forecast',delivery:{estimates:[{...common,
      execution:{mode:'auto',allowedRoutes:['subscription']}, apiCostUsd:1}]}},
    {id:'auto-case',name:'Fallback forecast',delivery:{estimates:[{...common,
      execution:{mode:'auto',preference:'api-first',allowFallback:true}, apiCostUsd:0.125,tasks}]}},


  ]};
  const file = join(directory,'portfolio.json');
  await writeFile(file,JSON.stringify(definition),{mode:0o600});
  let modelReads = 0;
  const app = await start({codex:{models() { modelReads++; throw new Error('No model is needed'); }}});
  const path = '/api/execution/estimates';
  assert.equal((await fetch(app.url+path+'?project=example')).status,401);
  const cookie = await login(app);
  const get = (route = path+'?project=example') => fetch(app.url+route,{headers:{cookie}});
  const update = async (revision, settings, project = 'example') => fetch(app.url+'/api/execution/settings?project='+project,{method:'POST',
    headers:{cookie, Origin:app.url, 'Content-Type':'application/json'},body:JSON.stringify({revision,settings})});
  assert.equal((await get(path+'?project=example&project=held')).status,404);
  assert.equal((await get(path+'?project=unrelated')).status,404);
  let result = await get();
  assert.equal(result.status,200);
  let view = await result.json();
  assert.equal(view.mode,'subscription-only');
  assert.equal(view.settingsRevision,0);
  assert.equal(view.status,'available');
  assert.equal(view.selected.recordedAt,time);
  assert.deepEqual(view.selected.firstUsableMinutes,horizon(4,8,13));
  assert.deepEqual(view.selected.remainingMinutes,horizon(7,12,20));
  assert.equal(view.selected.estimatedFinish,new Date(Date.parse(time)+720_000).toISOString());
  assert.equal(view.selected.apiCostUsd,0);
  assert.equal(view.selected.subscriptionTurns,3);
  assert.deepEqual(view.alternatives.map(row=>row.mode),['api-only']);
  assert.equal(view.alternatives[0].apiCostUsd,0.423);
  assert.equal(view.alternatives[0].estimatedFinish,null);
  const held = await (await get(path+'?project=held')).json();
  assert.equal(held.held,true);
  assert.equal(held.selected.estimatedFinish,null);
  assert.equal(held.selected.firstUsableAt,null);
  assert.deepEqual(held.selected.remainingMinutes,horizon(7,12,20));
  const missing = await (await get(path+'?project=unknown')).json();
  assert.equal(missing.status,'missing');
  assert.equal(missing.selected,null);
  assert.deepEqual(missing.alternatives,[]);
  const expired = await (await get(path+'?project=old')).json();
  assert.equal(expired.selected.firstUsableAt,null);
  assert.equal(expired.selected.estimatedFinish,null);
  assert.equal(expired.selected.stale,true);
  const forbidden = await (await get(path+'?project=forbidden')).json();
  assert.equal(forbidden.status,'unavailable');
  assert.equal(forbidden.selected,null);
  assert.equal((await update(0,{mode:'auto',preference:'api-first',allowFallback:true},'auto-case')).status,200);
  const auto = await (await get(path+'?project=auto-case')).json();
  assert.equal(auto.status,'available');
  assert.equal(auto.held,true);
  assert.equal(auto.holdReason,'api');
  assert.equal(auto.selected.firstUsableAt,null);
  assert.equal(auto.selected.estimatedFinish,null);



  result = await update(0,{mode:'api-only',apiBudgetUsd:8});
  assert.equal(result.status,200);
  view = await (await get()).json();
  assert.equal(view.mode,'api-only');
  assert.equal(view.settingsRevision,1);
  assert.equal(view.selected.apiCostUsd,0.423);
  assert.equal(view.selected.subscriptionTurns,null);
  assert.deepEqual(view.selected.firstUsableMinutes,horizon(5,10,20));
  assert.equal(view.selected.firstUsableAt,null);
  assert.equal(view.selected.remainingMinutes,null);
  assert.equal(view.held,true);
  assert.equal(view.holdReason,'api');
  result = await update(1,{model:'unmeasured-model'});
  assert.equal(result.status,200);
  view = await (await get()).json();
  assert.equal(view.status,'missing');
  assert.equal(view.selected,null);
  assert.deepEqual(view.alternatives,[]);

  const original = await (await get('/api/portfolio')).json();
  assert.equal(original.projects.find(project=>project.id==='example').schedule.originalDueAt,dueAt);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),definition);
  assert.equal(modelReads,0);
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
    usage: async () => ordinaryUsage(),
    models: async () => ({accountType: 'chatgpt', data: [{id: 'current', isDefault: true,
      defaultReasoningEffort: 'low', reasoningEfforts: [{reasoningEffort: 'low'}]}]}),
    async submit(input) {
      submits++;
      assert.equal(input.model, 'current');
      assert.equal(input.effort, 'low');
      await input.beforeTurn?.();
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
    usage: async () => ordinaryUsage(),
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

test('ChatGPT image send keeps the actual bytes behind the owner and conversation scope', async t => {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({...seed,
    projects:[...seed.projects,{id:'other', name:'Other'}]}), {mode:0o600});
  let runs = 0;
  let held = false;
  const app = await start({codex:{}, plan:{responses:{
    async models() {
      return [{slug:'vision', displayName:'Vision', ...(!held && {acceptsImages:true})},
        {slug:'text-only', displayName:'Text'}];
    },
    async *stream({model,messages}) {
      runs++;
      assert.equal(model,'vision');
      assert.equal(messages[0].content[1].image_url, 'data:' + image.mime + ';base64,' + image.data);
      yield '保存しました';
    },
  }}});
  const cookie = await login(app);
  const image = {mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF0kAAAAASUVORK5CYII='};
  const request = {id:'image-request', prompt:'確認', model:'vision', image};
  const post = (payload, authentication = cookie) => fetch(app.url + '/api/chat/live?project=example', {method:'POST',
    headers:{cookie:authentication, Origin:app.url, 'Content-Type':'application/json'}, body:JSON.stringify(payload)});
  assert.equal((await post(request,'')).status,401);
  assert.equal((await post({...request, model:'text-only'})).status,400);
  assert.equal((await post({...request, document:{name:'text.txt',text:'同時に送らない'}})).status,400);
  assert.equal((await post({...request, image:{...image, mime:'image/jpeg'}})).status,400);
  assert.equal(runs,0);
  const first = await post(request);
  assert.equal(first.status,200);
  const wire = await first.text();
  assert.ok(!wire.includes(image.data));
  const {turn} = wire.trim().split('\n\n').map(event=>JSON.parse(event.slice(6))).at(-1);
  assert.equal(turn.status,'completed');
  assert.equal(turn.image.mime,'image/png');
  held = true;
  assert.match(await (await post(request)).text(), /"status":"completed"/);
  assert.equal((await post({...request, id:'image-during-hold'})).status,400);
  assert.equal(runs,1);
  const id = encodeURIComponent(turn.conversationId);
  const path = '/api/chat/live/image?project=example&id=' + id + '&turn=' + turn.id;
  assert.equal((await fetch(app.url + path)).status,401);
  for (const other of [path.replace('project=example','project=other'),path + '&id=' + id,
    path.replace(id,encodeURIComponent('live/wrong'))]) {
    assert.equal((await fetch(app.url+other, {headers:{cookie}})).status,404);
  }
  const stored = await fetch(app.url + path,{headers:{cookie}});
  assert.equal(stored.headers.get('content-type'),'image/png');
  assert.equal(stored.headers.get('cache-control'),'no-store');
  assert.deepEqual(Buffer.from(await stored.arrayBuffer()),Buffer.from(image.data,'base64'));
  const history = await fetch(app.url + '/api/chat?project=example&id=' + id,{headers:{cookie}});
  const saved = await history.json();
  assert.deepEqual(saved.conversation.messages[0].image,turn.image);
  assert.ok(!JSON.stringify(saved).includes(image.data));
});

test('chat handoff preserves a bounded, displayed message range of a same-project export', async t => {
  const {directory, start} = await runtimeFixture(t);
  const projects = [{...seed.projects[0], repository: 'https://github.com/fixture-owner/known'}, {id:'other', name:'Other'}];
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({...seed, projects}), {mode: 0o600});
  const app = await start({codex: {async models() { assert.fail('must not start or inspect Codex'); }}});
  const cookie = await login(app);
  const records = Array.from({length: 44}, (_, index) => index === 41 ? '幅'.repeat(7000) : '原文-' + index);
  const id = 'export-handoff';
  const exportRecord = {id, title:'引き継ぎ対象', update_time:1795799000, current_node:'43',
    mapping: Object.fromEntries(records.map((text, index) => [String(index), {
      parent:index === 0 ? null : String(index - 1),
      message:{author:{role:index % 2 ? 'assistant' : 'user'}, content:{parts:[text]}, create_time:1795799000 + index},
    }]))};
  assert.equal((await fetch(app.url + '/api/chat/import?project=example', {method:'POST',
    headers:{cookie, Origin:app.url, 'Content-Type':'application/json'}, body:JSON.stringify([exportRecord])})).status, 200);
  const storedReply = await fetch(app.url + '/api/chat?project=example&id=' + id, {headers:{cookie}});
  const {conversation} = await storedReply.json();
  const later = await (await fetch(app.url + '/api/chat?project=example&id=' + id + '&offset=40', {headers:{cookie}})).json();
  const displayed = [...conversation.messages, ...later.conversation.messages];
  const viewHash = through => createHash('sha256').update(JSON.stringify(displayed.slice(
    Math.max(0, Number(through) - 40), Number(through)))).digest('hex');
  const params = {project:'example', id, through:'2', observedAt:conversation.importedAt, viewSha256:viewHash(2)};
  const read = (query={}, authentication=cookie) => fetch(app.url + '/api/chat/handoff?' +
    new URLSearchParams({...params, viewSha256:viewHash(query.through ?? params.through), ...query}), {headers:{cookie:authentication}});
  assert.equal((await read({}, '')).status, 401);
  assert.equal((await read({project:'other'})).status, 404);
  assert.equal((await read({observedAt:'2026-11-01T00:00:00.000Z'})).status, 409);
  assert.equal((await read({viewSha256:'0'.repeat(64)})).status, 409);
  for (const through of ['0','45','2.5','01','50000']) assert.equal((await read({through})).status, 400);
  assert.equal((await fetch(app.url + '/api/chat/handoff?' + new URLSearchParams(params) + '&project=other',
    {headers:{cookie}})).status, 400);
  const full = await read();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('cache-control'), 'no-store');
  const handoff = await full.json();
  assert.equal(handoff.document.name, 'chatgpt-handoff.json');
  assert.equal(handoff.sha256, createHash('sha256').update(handoff.document.text).digest('hex'));
  assert.deepEqual(handoff.range, {start:0, end:2, hasEarlier:false, hasLater:true});
  assert.equal(handoff.imageCount, 0);
  const packet = JSON.parse(handoff.document.text);
  assert.equal(packet.schemaVersion, 1);
  assert.deepEqual(packet.project, {id:'example', goal:projects[0].goal, repository:projects[0].repository});
  assert.deepEqual(packet.source, {id, kind:'chatgpt-export', title:conversation.title, observedAt:conversation.importedAt, viewSha256:params.viewSha256});
  assert.deepEqual(packet.range, handoff.range);
  assert.deepEqual(packet.messages, conversation.messages.slice(0,2));
  const suffixReply = await read({through:'44'});
  assert.equal(suffixReply.status, 200);
  const suffix = await suffixReply.json();
  assert.deepEqual(suffix.range, {start:42, end:44, hasEarlier:true, hasLater:false});
  assert.deepEqual(JSON.parse(suffix.document.text).messages.map(message => message.text), records.slice(-2));
  assert.equal((await read({through:'42'})).status, 413);
});

test('direct ChatGPT handoff binds exactly one Codex receipt to the approved conversation', async t => {
  const {directory, start} = await runtimeFixture(t);
  const checkout = join(directory, 'workspaces', 'example');
  await mkdir(checkout, {recursive: true, mode: 0o700});
  await writeFile(join(checkout, '.hq-owned-workspace'), 'example\n');
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({...seed, projects: [
    {...seed.projects[0], cwd: checkout, enableCodexWrite: true},
    {id: 'other', name: 'Different project'},
  ]}), {mode: 0o600});
  const sends = [];
  let beforeWire;
  const app = await start({codex: {
    canWrite: true, subscriptionReady: async () => true, usage: async () => ordinaryUsage(),
    models: async () => ({accountType: 'chatgpt', data: [{id: 'controlled', isDefault: true, reasoningEfforts: []}]}),
    async submit(options) {
      assert.equal(options.beforeThread(), true);
      await options.beforeTurn();
      await beforeWire?.();
      const thread = 'wire-' + options.requestId;
      if (options.onThread(thread) !== true) throw new Error('Fixture send gate denied');
      sends.push({id: options.requestId, document: options.document, prompt: options.prompt});
      return {turn: {id: 'turn-' + options.requestId, status: 'completed'}};
    },
  }});
  const cookie = await login(app);
  const call = (route, params = {}, data, authenticated = true) => fetch(app.url + route + '?' +
    new URLSearchParams({project: 'example', ...params}), {
      method: data ? 'POST' : 'GET',
      headers: {...(authenticated && {cookie}), ...(data && {Origin: app.url, 'Content-Type': 'application/json'})},
      ...(data && {body: JSON.stringify(data)}),
    });
  const selected = {id: 'direct-conversation'};
  const archive = (id, modified = 1, message = '確認済みの作業条件') => ({id, title: id, update_time: modified, current_node: 'm',
    mapping: {m: {parent: null, message: {author: {role: 'user'}, content: {parts: [message]}}}}});
  const other = {id: 'other-conversation'};
  assert.equal((await call('/api/chat/import', {}, [archive(selected.id), archive(other.id)])).status, 200);
  assert.equal((await call('/api/chat/import', {project: 'other'}, [archive(selected.id)])).status, 200);
  const {conversation} = await (await call('/api/chat', selected)).json();
  const scope = {through: 1, observedAt: conversation.importedAt,
    viewSha256: createHash('sha256').update(JSON.stringify(conversation.messages)).digest('hex')};
  const preview = await call('/api/chat/handoff', {...selected, ...scope});
  assert.equal(preview.status, 200);
  const {document, sha256} = await preview.json();
  const input = {id: 'direct-chat-receipt', prompt: 'この手順を確かめる', ...scope, sha256};
  assert.equal((await call('/api/chat/handoff', selected, input, false)).status, 401);
  assert.equal((await call('/api/chat/handoff', {...selected, project: 'unknown-project'}, input)).status, 404);
  assert.equal((await call('/api/chat/handoff', selected, {...input, viewSha256: '0'.repeat(64)})).status, 409);
  assert.equal((await call('/api/chat/handoff', selected, {...input, sha256: 'f'.repeat(64)})).status, 409);
  assert.equal((await call('/api/chat/handoff', selected, {...input, document})).status, 400);
  assert.equal((await call('/api/chat/handoff', other, input)).status, 409);
  assert.equal((await call('/api/chat/handoff', {...selected, project: 'other'}, input)).status, 409);

  const settings = (revision, mode) => call('/api/execution/settings', {},
    {revision, settings: {mode, ...(mode === 'api-only' && {apiBudgetUsd: 1})}});
  assert.equal((await settings(0, 'api-only')).status, 200);
  assert.equal((await call('/api/chat/handoff', selected, input)).status, 409);
  assert.deepEqual(sends, []);
  assert.equal((await settings(1, 'subscription-only')).status, 200);

  const startFromChat = (data = input) => call('/api/chat/handoff', selected, data);
  const accepted = await Promise.all([startFromChat(), startFromChat()]);
  for (const reply of accepted) {
    assert.equal(reply.status, 202, await reply.clone().text());
    assert.equal((await reply.json()).operation.id, input.id);
  }
  const readOperation = async (id, phase) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const reply = await call('/api/codex/run', {id});
      assert.equal(reply.status, 200);
      const {operation} = await reply.json();
      if (operation?.phase === phase) return operation;
      await delay(20);
    }
    assert.fail('The fixture did not reach the expected Codex receipt phase');
  };
  const completed = await readOperation(input.id, 'completed');
  assert.equal(completed.explicitRoute, 'subscription');
  assert.deepEqual(sends, [{id: input.id, document, prompt: input.prompt}]);
  assert.equal((await startFromChat()).status, 202);
  assert.equal((await startFromChat({...input, prompt: 'Changed request'})).status, 409);
  const getWork = (params, authenticated = true) => call('/api/chat/codex-work', params, undefined, authenticated);
  const exact = {...selected, receipt: input.id};
  assert.equal((await getWork(exact, false)).status, 401);
  const found = await getWork(exact);
  assert.equal(found.status, 200);
  const {works: [receipt]} = await found.json();
  assert.deepEqual(receipt, {id: input.id, phase: 'completed', threadId: completed.threadId,
    turnId: completed.turnId, observedAt: completed.updatedAt});
  assert.deepEqual(await (await getWork(selected)).json(), {works: [receipt]});
  for (const otherScope of [{...other, receipt: input.id}, {...exact, project: 'other'}, {...exact, receipt: 'missing-receipt'}]) {
    const hidden = await getWork(otherScope);
    assert.equal(hidden.status, 200);
    assert.deepEqual(await hidden.json(), {works: []});
  }

  beforeWire = async () => {
    const updated = await call('/api/chat/import', {}, [archive(selected.id, 2, '送信前に変わった作業条件')]);
    assert.equal(updated.status, 200);
  };
  const stale = {...input, id: 'direct-chat-stale'};
  const reserved = await startFromChat(stale);
  assert.equal(reserved.status, 202);
  const unsuccessful = await readOperation(stale.id, 'failed');
  assert.equal(unsuccessful.threadId, null);
  assert.equal(unsuccessful.turnId, null);
  const {conversation: refreshed} = await (await call('/api/chat', selected)).json();
  assert.equal(refreshed.messages[0].text, '送信前に変わった作業条件');
  assert.deepEqual(await (await getWork({...selected, receipt: stale.id})).json(), {works: [
    {id: stale.id, phase: 'failed', threadId: null, turnId: null, observedAt: unsuccessful.updatedAt},
  ]});
  assert.deepEqual(sends, [{id: input.id, document, prompt: input.prompt}]);
});

test('chat handoff preserves complete live text attachments and only includes image references', async t => {
  const {directory, start} = await runtimeFixture(t);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify(seed), {mode: 0o600});
  const store = createChatStore(directory);
  const document = {name:'要件.json', text:'原文\r\n資料'};
  const image = {mime:'image/png', data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF0kAAAAASUVORK5CYII='};
  const model = 'fixture-model';
  const project = 'example';
  const {turn} = store.beginLive(project, {id:'document-turn', model, prompt:'指示', document});
  const conversationId = turn.conversationId;
  store.finishLive(project, turn.id, {status:'completed', text:'検証済み'});
  const {turn: withImage} = store.beginLive(project, {id:'image-turn', conversationId, model, prompt:'画像の説明', image});
  store.finishLive(project, withImage.id, {status:'completed', text:'確認済み'});
  store.beginLive(project, {id:'active-turn', conversationId, model, prompt:'まだ応答中'});
  const {conversation: displayed} = store.read(project, conversationId, 0);
  store.close();
  const app = await start({codex:{}});
  const cookie = await login(app);
  const call = through => fetch(app.url + '/api/chat/handoff?' +
    new URLSearchParams({project, id:conversationId, through, observedAt:displayed.importedAt,
      viewSha256:createHash('sha256').update(JSON.stringify(displayed.messages.slice(0, Number(through)))).digest('hex')}),
    {headers:{cookie}});
  assert.equal((await call('5')).status, 409);
  const reply = await call('4');
  assert.equal(reply.status, 200);
  const handoff = await reply.json();
  assert.deepEqual(handoff.range, {start:0, end:4, hasEarlier:false, hasLater:true});
  assert.equal(handoff.imageCount, 1);
  assert.equal(handoff.document.text.includes(image.data), false);
  const packet = JSON.parse(handoff.document.text);
  assert.equal(packet.source.kind, 'chatgpt-live');
  assert.deepEqual(packet.messages[0].document, document);
  assert.deepEqual(packet.messages[2].image, withImage.image);
  assert.equal(packet.messages[2].turnId, withImage.id);
  assert.equal(packet.messages[3].text, '確認済み');
});

test('one canonical forecast survives every execution mode and a new owner-app process', async t => {
  const {start} = await runtimeFixture(t);
  let runtime=await start({codex:{}});
  let cookie=await login(runtime);
  const post=(url,body)=>fetch(runtime.url+url,{method:'POST',
    headers:{cookie,Origin:runtime.url,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const registration=await post('/api/portfolio/projects',{requestId:randomUUID(),name:'Forecast persistence',goal:'Scope the first deliverable'});
  assert.equal(registration.status,201);
  const {id}=await registration.json();
  const read=async ()=>{
    const response=await fetch(runtime.url+'/api/portfolio',{headers:{cookie}});
    assert.equal(response.status,200);
    return (await response.json()).projects.find(row=>row.id===id).forecast;
  };
  const before=await read();
  assert.ok(before.tasks[0].remainingMinutes.standard>0);
  const path='/api/execution/settings?project='+id;
  const switches=[
    {mode:'api-only',allowedRoutes:['api']},
    {mode:'auto',allowedRoutes:['api','subscription'],preference:'subscription-first'},
    {mode:'hybrid',allowedRoutes:['api','subscription'],stageRoutes:{design:'subscription',implementation:'api'}},
    {mode:'subscription-only',allowedRoutes:['subscription'],stageRoutes:{}},
  ];
  for (const [revision,settings] of switches.entries()) {
    const result=await post(path,{revision,settings});
    assert.equal(result.status,200,await result.clone().text());
    assert.equal((await result.json()).settings.mode,settings.mode);
    assert.deepEqual(await read(),before);
  }
  await runtime.close();
  runtime=await start({codex:{}});
  cookie=await login(runtime);
  assert.deepEqual(await read(),before);
});

test('Codex chat context reads confirmed same-scope turns and exports only result metadata', async t => {
  const {directory, start} = await runtimeFixture(t);
  const scope = seed.projects[0].cwd;
  const definition = {...seed, projects: [...seed.projects, {id:'other', name:'Other', cwd:scope+'-other'}]};
  const portfolioPath = join(directory,'portfolio.json');
  await writeFile(portfolioPath,JSON.stringify(definition),{mode:0o600});
  let readThreadCalls = 0;
  let evidenceReads = 0;
  const app = await start({codex:{
    async readThread(paths, id, cursor) {
      readThreadCalls++;
      if (!paths.includes(scope)) throw Object.assign(new Error('Not found'),{status:404});
      return {thread:{id,title:'PRIVATE_THREAD_TITLE'},nextCursor:cursor===null?'older':null,
        turns:[{id:cursor===null?'active':'done',status:cursor===null?'inProgress':'completed',
          messages:[{text:'PRIVATE_CODEX_MESSAGE'}]}]};
    },
    async readTurnEvidence(paths,id,turn,{cursor}) {
      evidenceReads++;
      assert.deepEqual(paths,[scope]);
      if (id==='bounded') {
        const page = Number(cursor ?? 0);
        return {threadId:id,turnId:turn,nextCursor:String(page+1),entries:[
          {type:'files',id:'files-'+page,status:'completed',changes:Array.from({length:20},(_,index)=>({
            path:'src/'+page+'/'+index+'-'+'a'.repeat(1024)+'.txt',kind:'update',
          }))},
        ]};
      }
      if (id==='revoked') {
        const revoked = {...definition, projects:[{...definition.projects[0], cwd:scope+'-new'},definition.projects[1]]};
        await writeFile(portfolioPath,JSON.stringify(revoked),{mode:0o600});
      }
      const entries = cursor===null ? [
        {type:'command',id:'cmd',status:'completed',exitCode:0,command:'PRIVATE_COMMAND',output:'PRIVATE_RAW_OUTPUT'},
        {type:'files',id:'chg',status:'completed',changes:[{path:'src/check.txt',kind:'update',diff:'PRIVATE_DIFF'},
          {path:'/outside/PRIVATE_PATH',kind:'update'},{path:'../PRIVATE_PATH',kind:'add'}]},
      ] : [];
      return {threadId:id,turnId:turn,entries,nextCursor:cursor===null?'next':null};
    },
  }});
  const cookie = await login(app);
  const chatExport = {id:'chat-candidate', title:'選択した同じ案件の会話', update_time:1,current_node:'message',
    mapping:{message:{parent:null,message:{author:{role:'user'},content:{parts:['PRIVATE_CHAT_MESSAGE']}}}}};
  const imported = await fetch(app.url+'/api/chat/import?project=example',{method:'POST',
    headers:{cookie,Origin:app.url,'Content-Type':'application/json'},body:JSON.stringify([chatExport])});
  assert.equal(imported.status,200);
  const path = app.url+'/api/codex/chat-context?';
  const query = {project:'example',id:'thread',turn:'done',conversation:'chat-candidate'};
  const get = (params={}, authentication=cookie) => fetch(path+new URLSearchParams({...query,...params}),
    {headers:{cookie:authentication}});
  assert.equal((await get({},'')).status,401);
  assert.equal((await get({project:'unregistered'})).status,404);
  assert.equal((await fetch(path+new URLSearchParams(query)+'&id=other',{headers:{cookie}})).status,400);
  assert.equal(readThreadCalls,0);
  assert.equal((await get({project:'other'})).status,404);
  assert.equal((await get({turn:'active'})).status,409);
  assert.equal(evidenceReads,0);
  const accepted = await get();
  assert.equal(accepted.status,200);
  assert.equal(accepted.headers.get('cache-control'),'no-store');
  const result = await accepted.json();
  assert.equal(result.threadId,'thread');
  assert.equal(result.turnId,'done');
  assert.deepEqual(result.conversation,{id:'chat-candidate',title:'選択した同じ案件の会話',linked:false});
  assert.deepEqual(result.summary,{commands:1,files:1,artifacts:0});
  assert.equal(result.document.name,'codex-result.json');
  assert.equal(result.sha256,createHash('sha256').update(result.document.text).digest('hex'));
  const context = JSON.parse(result.document.text);
  assert.deepEqual(context.commands,[{status:'completed',exitCode:0}]);
  assert.deepEqual(context.files,[{path:'src/check.txt',kind:'update',status:'completed'}]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  assert.equal((await (await get({conversation:'unknown'})).json()).conversation,null);
  const bounded = await (await get({id:'bounded'})).json();
  const limited = JSON.parse(bounded.document.text);
  assert.ok(Buffer.byteLength(bounded.document.text,'utf8')<=16*1024);
  assert.equal(limited.coverage.evidencePages,4);
  assert.equal(limited.coverage.moreEvidence,true);
  assert.ok(limited.coverage.omitted.files>0);
  assert.equal(bounded.summary.files+limited.coverage.omitted.files,80);
  assert.equal((await get({id:'revoked'})).status,404);
});

test('Codex chat context pins only exact existing conversation handoffs and preserves legacy receipts', async t => {
  const {directory, start} = await runtimeFixture(t);
  const checkout = join(directory,'workspaces','example');
  await mkdir(checkout,{recursive:true,mode:0o700});
  await writeFile(join(checkout,'.hq-owned-workspace'),'example\n');
  await writeFile(join(directory,'portfolio.json'),JSON.stringify({...seed,
    projects:[{...seed.projects[0],cwd:checkout,enableCodexWrite:true}]}),{mode:0o600});
  let submits = 0;
  const app = await start({codex:{
    canWrite:true, subscriptionReady:async()=>true,
    usage: async () => ordinaryUsage(),
    models:async()=>({accountType:'chatgpt',data:[{id:'current',isDefault:true,
      defaultReasoningEffort:'low',reasoningEfforts:[{reasoningEffort:'low'}]}]}),
    async submit(input) {
      submits++;
      await input.beforeTurn?.();
      assert.equal(input.onThread('thread-'+input.requestId),true);
      return {turn:{id:'turn-'+input.requestId,status:'completed'}};
    },
    async readThread(_scope,id) {
      return {thread:{id},turns:[{id:id.replace('thread-','turn-'),status:'completed'}],nextCursor:null};
    },
    async readTurnEvidence(_scope,id,turn) { return {threadId:id,turnId:turn,entries:[],nextCursor:null}; },
  }});
  const cookie = await login(app);
  const call = (route, params={}, body) => fetch(app.url+route+'?'+new URLSearchParams({project:'example',...params}), {
    method:body?'POST':'GET',headers:{cookie,...(body&&{Origin:app.url,'Content-Type':'application/json'})},
    ...(body&&{body:JSON.stringify(body)}),
  });
  const archive = (id, title) => ({id,title,update_time:1,current_node:'m',mapping:{m:{parent:null,
    message:{author:{role:'user'},content:{parts:['会話内の作業要件']}}}}});
  assert.equal((await call('/api/chat/import',{},[archive('correct-chat','Origin'),archive('other-chat','Candidate')])).status,200);
  const {conversation} = await (await call('/api/chat',{id:'correct-chat'})).json();
  const linkRequest = {id:conversation.id,through:'1',observedAt:conversation.importedAt,
    viewSha256:createHash('sha256').update(JSON.stringify(conversation.messages)).digest('hex')};
  const {document} = await (await call('/api/chat/handoff',linkRequest)).json();
  async function submit(id, attachment) {
    const payload = {id,prompt:'引継ぎ資料の確認',...(attachment&&{document:attachment})};
    assert.equal((await call('/api/codex/run',{},payload)).status,202);
    assert.equal((await call('/api/codex/run',{},payload)).status,202);
  }
  const getContext = id => call('/api/codex/chat-context',
    {id:'thread-'+id,turn:'turn-'+id,conversation:'other-chat'});
  await submit('actual-link',document);
  const linked = await (await getContext('actual-link')).json();
  assert.deepEqual(linked.conversation,{id:'correct-chat',title:'Origin',linked:true});
  const operations = new DatabaseSync(join(directory,'conversations.sqlite'));
  try {
    const {updatedAt} = operations.prepare("SELECT updatedAt FROM codex_operations WHERE project='example' AND id='actual-link'").get();
    assert.deepEqual(await (await call('/api/chat/codex-work',{id:'correct-chat'})).json(),{works:[
      {id:'actual-link',phase:'completed',observedAt:updatedAt,threadId:'thread-actual-link',turnId:'turn-actual-link'},
    ]});
    assert.deepEqual((await (await call('/api/portfolio')).json()).recentWorkOutcomes,
      [{projectId:'example', id:'actual-link', kind:'codex', phase:'completed', observedAt:updatedAt, threadId:'thread-actual-link'}]);
    const setPhase = operations.prepare("UPDATE codex_operations SET phase=? WHERE project='example' AND id='actual-link'");
    const currentPhase = operations.prepare("SELECT phase FROM codex_operations WHERE project='example' AND id='actual-link'");
    for (const pending of ['running','unconfirmed']) {
      setPhase.run(pending);
      const preview = await getContext('actual-link');
      assert.equal(preview.status,200);
      assert.deepEqual((await preview.json()).conversation,linked.conversation);
      assert.equal(currentPhase.get().phase,pending);
    }
    for (const conflict of ['cancelled','failed','interrupted']) {
      setPhase.run(conflict);
      assert.equal((await getContext('actual-link')).status,409);
      assert.equal(currentPhase.get().phase,conflict);
    }
    setPhase.run('completed');
  } finally { operations.close(); }
  const changed = {...document,text:document.text+' '};
  await submit('modified-link',changed);
  const unlinked = await (await getContext('modified-link')).json();
  assert.deepEqual(unlinked.conversation,{id:'other-chat',title:'Candidate',linked:false});
  await submit('historic-turn');
  assert.deepEqual((await (await getContext('historic-turn')).json()).conversation,
    {id:'other-chat',title:'Candidate',linked:false});
  assert.equal(submits,3);
});

test('linked Codex work reads only the current conversation and workspace without reconciling or dispatching', async t => {
  const {directory, start} = await runtimeFixture(t);
  const checkout = join(directory,'workspaces','example');
  const registry = join(directory,'portfolio.json');
  const definition = {...seed,projects:[{...seed.projects[0],cwd:checkout},
    {id:'other',name:'別案件',cwd:checkout}]};
  const save = () => writeFile(registry,JSON.stringify(definition),{mode:0o600});
  await save();
  let nativeRequests=0;
  const unexpected = () => { nativeRequests++; throw new Error('Native call during linked work read'); };
  const app = await start({codex:{models:unexpected,readThread:unexpected,findSubmission:unexpected,submit:unexpected}});
  const cookie = await login(app);
  const call = (route, params, body) => fetch(app.url+route+'?'+new URLSearchParams(params),{
    method:body?'POST':'GET',headers:{cookie,...(body&&{Origin:app.url,'Content-Type':'application/json'})},
    ...(body&&{body:JSON.stringify(body)}),
  });
  const archive = id => ({id,title:'検証用の会話',update_time:1,current_node:'m',mapping:{m:{parent:null,
    message:{author:{role:'user'},content:{parts:['会話本文は作業一覧へ含めない']}}}}});
  assert.equal((await call('/api/chat/import',{project:'example'},[archive('origin-chat'),archive('other-chat')])).status,200);
  assert.equal((await call('/api/chat/import',{project:'other'},[archive('origin-chat')])).status,200);
  const store = createChatStore(directory,{now:()=>Date.parse('2026-11-27T00:00:00.000Z')});
  const wrongSource = 'api/10000000-0000-4000-a000-100000000000';
  let liveId;
  try {
    store.beginDevelopment('example',{id:wrongSource.slice(4),prompt:'API only',model:'fixture-model',
      createdAt:'2026-11-27T00:00:00.000Z'});
    const {turn}=store.beginLive('example',{id:'live-history-fixture',prompt:'会話',model:'fixture-model'});
    liveId=turn.conversationId;
  }
  finally { store.close(); }

  const db = new DatabaseSync(join(directory,'conversations.sqlite'));
  try {
    const insert = db.prepare(`INSERT INTO codex_operations(project,id,workspace,fingerprint,phase,threadId,turnId,createdAt,
      updatedAt,output,chatConversationId,cancellationRequestedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const bit = '2026-11-27T00:00:00.000Z';
    const pendingAt = '2026-11-27T00:00:02.000Z';
    const put = ({id,project='example',workspace=checkout,phase='completed',thread='shared-thread',turn=id,at=bit,
      updatedAt=at,chat='origin-chat',cancel=null}) =>
      insert.run(project,id,workspace,'a'.repeat(64),phase,thread,turn,at,updatedAt,'PRIVATE_OUTPUT',chat,cancel);
    put({id:'successful-work'});
    put({id:'sending-work',phase:'sending',turn:null,at:pendingAt,cancel:pendingAt});
    put({id:'legacy-work',chat:null});
    put({id:'another-chat-work',chat:'other-chat'});
    put({id:'live-chat-work',chat:liveId});
    put({id:'other-project-work',project:'other'});
    put({id:'detached-work',workspace:checkout+'-old'});
    put({id:'invalid-date-work',updatedAt:'2026-11-27'});
    put({id:'invalid-thread-work',thread:'invalid/id'});
    put({id:'duplicate-work'});
    put({id:'duplicate-from-other-chat',turn:'duplicate-work',chat:'other-chat'});
    const path = '/api/chat/codex-work';
    const scope = {project:'example',id:'origin-chat'};
    assert.equal((await fetch(app.url+path+'?'+new URLSearchParams(scope))).status,401);
    const response = await call(path,scope);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{works:[
      {id:'sending-work',phase:'cancelling',observedAt:pendingAt,threadId:null,turnId:null},
      {id:'successful-work',phase:'completed',observedAt:bit,threadId:'shared-thread',turnId:'successful-work'},
    ]});
    assert.deepEqual(await (await call(path,{project:'other',id:'origin-chat'})).json(),{works:[
      {id:'other-project-work',phase:'completed',observedAt:bit,threadId:'shared-thread',turnId:'other-project-work'},
    ]});
    assert.deepEqual(await (await call(path,{project:'example',id:'other-chat'})).json(),{works:[
      {id:'another-chat-work',phase:'completed',observedAt:bit,threadId:'shared-thread',turnId:'another-chat-work'},
    ]});
    assert.deepEqual(await (await call(path,{project:'example',id:liveId})).json(),{works:[
      {id:'live-chat-work',phase:'completed',observedAt:bit,threadId:'shared-thread',turnId:'live-chat-work'},
    ]});
    assert.equal(db.prepare("SELECT status FROM live_turns WHERE id='live-history-fixture'").get().status,'in_progress');
    for (const id of ['missing-chat',wrongSource]) assert.equal((await call(path,{...scope,id})).status,404);
    assert.equal((await call(path,[['project','example'],['project','other'],['id','origin-chat']])).status,404);
    assert.equal((await call(path,[['project','example'],['id','origin-chat'],['id','other-chat']])).status,404);
    assert.equal((await call(path,scope,{})).status,404);
    assert.deepEqual({...db.prepare("SELECT phase,updatedAt FROM codex_operations WHERE id='sending-work'").get()},
      {phase:'sending',updatedAt:pendingAt});
    for(let index=10;index<19;index++) put({id:'newer-work-'+index,phase:'failed',thread:null,turn:null,
      at:'2026-11-27T00:00:'+index+'.000Z'});
    const newest=(await (await call(path,scope)).json()).works;
    assert.deepEqual(newest.map(row=>row.id),Array.from({length:8},(_,index)=>'newer-work-'+(18-index)));
    definition.projects[0].cwd=checkout+'-new';
    await save();
    assert.deepEqual(await (await call(path,scope)).json(),{works:[]});
    assert.equal(nativeRequests,0);
  } finally {db.close();}
});

test('linked Codex result confirms an exact older receipt outside recent native history', async t => {
  const {directory,start} = await runtimeFixture(t);
  const checkout = join(directory,'workspaces','example');
  const registry = join(directory,'portfolio.json');
  const definition = {...seed,projects:[{...seed.projects[0],cwd:checkout},
    {id:'other',name:'別案件',cwd:checkout}]};
  const save = () => writeFile(registry,JSON.stringify(definition),{mode:0o600});
  await save();
  const ids={receipt:'exact-old-receipt',thread:'native-long-thread',turn:'old-native-turn',chat:'origin-chat'};
  let historyReads=0, confirmations=0, evidenceReads=0;
  let mode;
  const app = await start({codex:{
    async readThread(scope,thread,cursor) {
      historyReads++;
      assert.deepEqual(scope,[checkout]);
      assert.equal(thread,ids.thread);
      const page=Number(cursor ?? 0);
      return {thread:{id:thread},turns:Array.from({length:4},(_,index)=>({id:'recent-'+(page*4+index),
        status:'completed'})),nextCursor:String(page+1)};
    },
    async confirmLinkedTurn(workspace,thread,turn,receipt) {
      confirmations++;
      assert.deepEqual([workspace,thread,turn,receipt],[checkout,ids.thread,ids.turn,ids.receipt]);
      return mode!=='wrong-first-user';
    },
    async readTurnEvidence(scope,thread,turn) {
      evidenceReads++;
      assert.deepEqual(scope,[checkout]);
      assert.deepEqual([thread,turn],[ids.thread,ids.turn]);
      if(mode==='revoke-receipt') db.prepare('UPDATE codex_operations SET chatConversationId=? WHERE id=?')
        .run('other-chat',ids.receipt);
      if(mode==='replace-checkpoint') db.prepare('UPDATE codex_operations SET fingerprint=? WHERE id=?')
        .run('b'.repeat(64),ids.receipt);
      if(mode==='revoke-workspace') {
        definition.projects[0].cwd=checkout+'-new';
        await save();
      }
      return {threadId:thread,turnId:turn,entries:[{type:'command',id:'verified-command',status:'completed',exitCode:0,
        output:'PRIVATE_NATIVE_OUTPUT'}],nextCursor:null};
    },
  }});
  const db=new DatabaseSync(join(directory,'conversations.sqlite'));
  t.after(()=>db.close());
  const cookie=await login(app);
  const archive=id=>({id,title:'元の会話',update_time:1,current_node:'m',mapping:{m:{parent:null,
    message:{author:{role:'user'},content:{parts:['PRIVATE_CHAT']}}}}});
  const post=project=>fetch(app.url+'/api/chat/import?project='+project,{method:'POST',
    headers:{cookie,Origin:app.url,'Content-Type':'application/json'},body:JSON.stringify([archive(ids.chat),archive('other-chat')])});
  assert.equal((await post('example')).status,200);
  assert.equal((await post('other')).status,200);
  const at='2026-11-27T00:00:00.000Z';
  const insert=db.prepare(`INSERT INTO codex_operations(project,id,workspace,fingerprint,phase,threadId,turnId,createdAt,
    updatedAt,chatConversationId) VALUES ('example',?,? ,?,'completed',?,?,?, ?,?)`);
  const createReceipt=(id,chat=ids.chat)=>insert.run(id,checkout,'a'.repeat(64),ids.thread,ids.turn,at,at,chat);
  createReceipt(ids.receipt);
  const route=app.url+'/api/codex/chat-context?';
  const scope={project:'example',id:ids.thread,turn:ids.turn,conversation:ids.chat,receipt:ids.receipt};
  const linked=(params={},authentication=cookie)=>fetch(route+new URLSearchParams({...scope,...params}),{headers:{cookie:authentication}});
  const legacy=new URLSearchParams(scope);
  legacy.delete('receipt');
  assert.equal((await fetch(route+legacy,{headers:{cookie}})).status,404);
  assert.equal(historyReads,4);

  const response=await linked();
  assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual(result.conversation,{id:ids.chat,title:'元の会話',linked:true});
  const packet=JSON.parse(result.document.text);
  assert.equal(packet.status,'completed');
  assert.equal(packet.completedAt,undefined);
  assert.equal(packet.coverage.turnPages,0);
  assert.deepEqual(packet.commands,[{status:'completed',exitCode:0}]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  assert.deepEqual([historyReads,confirmations,evidenceReads],[4,1,1]);

  assert.equal((await linked({},'')).status,401);
  const noConversation=new URLSearchParams(scope);
  noConversation.delete('conversation');
  assert.equal((await fetch(route+noConversation,{headers:{cookie}})).status,400);
  assert.equal((await linked({historyCursor:'wrong-cursor'})).status,400);
  assert.equal((await fetch(route+new URLSearchParams(scope)+'&receipt=another-receipt',{headers:{cookie}})).status,400);
  for (const params of [{project:'other'},{conversation:'other-chat'},{receipt:'another-receipt'},
    {id:'wrong-thread'},{turn:'wrong-turn'}]) assert.equal((await linked(params)).status,404);
  createReceipt('conflicting-receipt','other-chat');
  assert.equal((await linked()).status,404);
  db.prepare('DELETE FROM codex_operations WHERE id=?').run('conflicting-receipt');
  db.prepare("UPDATE codex_operations SET phase='failed' WHERE id=?").run(ids.receipt);
  assert.equal((await linked()).status,404);
  db.prepare("UPDATE codex_operations SET phase='completed' WHERE id=?").run(ids.receipt);
  assert.deepEqual([historyReads,confirmations,evidenceReads],[4,1,1]);
  mode='wrong-first-user';
  assert.equal((await linked()).status,404);
  assert.equal(evidenceReads,1);

  mode='revoke-receipt';
  assert.equal((await linked()).status,404);
  db.prepare('UPDATE codex_operations SET chatConversationId=? WHERE id=?').run(ids.chat,ids.receipt);
  mode='replace-checkpoint';
  assert.equal((await linked()).status,404);
  mode='revoke-workspace';
  assert.equal((await linked()).status,404);
  assert.equal(historyReads,4);
});

test('Codex chat context includes only committed artifacts attested for the exact turn',
  {skip:!process.getuid && process.platform!=='win32'}, async t => {
  const {directory, start} = await runtimeFixture(t);
  const checkout = join(directory,'workspaces','example');
  await mkdir(checkout,{recursive:true,mode:0o700});
  const fixture = {'.hq-owned-workspace':'example\n','requirements.txt':'PRIVATE_REQUIREMENTS\n',
    'verification.txt':'PRIVATE_PROOF\n','artifact.txt':'PRIVATE_RESULT\n'};
  await Promise.all(Object.entries(fixture).map(([name,value])=>writeFile(join(checkout,name),value,{mode:0o600})));
  const git = args => execFileSync('git',['-C',checkout,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git(['init','-q']);
  git(['config','core.autocrlf','false']);
  git(['add','--','requirements.txt','verification.txt','artifact.txt']);
  const identity = ['-c','user.name=Test','-c','user.email=test@example.test','-c','commit.gpgsign=false',
    '-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null')];
  git([...identity,'commit','-qm','isolated fixture']);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const operationId = 'recorded-operation';
  const now = '2026-11-28T00:00:00.000Z';
  const project = {...seed.projects[0],cwd:checkout,handoverRequirements:'requirements.txt',nativeHandover:{
    version:1,shareArtifacts:true,effectsReconciled:true,operationId,threadId:'thread',turnId:'verified-turn',
    checkoutHead:git(['rev-parse','HEAD']),requirementsSha256:digest(fixture['requirements.txt']),
    verification:{path:'verification.txt',sha256:digest(fixture['verification.txt'])},
    artifacts:[{path:'artifact.txt',sha256:digest(fixture['artifact.txt'])}],
  }};
  await writeFile(join(directory,'portfolio.json'),JSON.stringify({...seed,projects:[project]}),{mode:0o600});
  const app = await start({codex:{
    async readThread(_scope,id) { return {thread:{id},nextCursor:null,turns:[
      {id:'verified-turn',status:'completed'}, {id:'other-turn',status:'completed'},
    ]}; },
    async readTurnEvidence(_scope,id,turn) { return {threadId:id,turnId:turn,entries:[],nextCursor:null}; },
  }});
  const db = new DatabaseSync(join(directory,'conversations.sqlite'));
  try {
    db.prepare(`INSERT INTO codex_operations(project,id,workspace,fingerprint,phase,threadId,turnId,createdAt,updatedAt)
      VALUES (?,?,?,?,'completed','thread','verified-turn',?,?)`).run('example',operationId,checkout,'fixture',now,now);
  } finally {db.close();}
  const cookie = await login(app);
  const read = async turn => {
    const reply = await fetch(app.url+'/api/codex/chat-context?project=example&id=thread&turn='+turn,{headers:{cookie}});
    assert.equal(reply.status,200);
    const result = await reply.json();
    assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
    assert.doesNotMatch(result.document.text,/\/api\/artifacts\/work\/file|artifactDownloads|"href"/);
    return {result,context:JSON.parse(result.document.text)};
  };
  const {result:published,context:correct} = await read('verified-turn');
  assert.equal(correct.coverage.artifactEvidence,'verified');
  assert.deepEqual(correct.artifacts,[{path:'artifact.txt',sha256:digest(fixture['artifact.txt']),observedAt:now}]);
  assert.equal(published.artifactDownloads?.length,1);
  const [downloadItem] = published.artifactDownloads;
  const {evidence,...artifactFile} = downloadItem;
  assert.deepEqual(Object.keys(evidence).sort(),['requirements','verification']);
  const files = [[artifactFile,'artifact.txt'],[evidence.requirements,'requirements.txt'],
    [evidence.verification,'verification.txt']];
  for (const [item,name] of files) {
    assert.deepEqual(item,{path:name,sha256:digest(fixture[name]),href:item.href});
    assert.match(item.href,/^\/api\/artifacts\/work\/file\?/);
    const fileUrl = app.url+item.href;
    assert.equal((await fetch(fileUrl)).status,401);
    const response = await fetch(fileUrl,{headers:{cookie}});
    assert.equal(response.status,200);
    assert.equal(await response.text(),fixture[name]);
  }
  const listPath=app.url+'/api/artifacts/work?source=codex&project=example';
  assert.equal((await fetch(listPath)).status,401);
  const list=await fetch(listPath,{headers:{cookie}});
  assert.equal(list.status,200);
  const {artifacts}=await list.json();
  assert.equal(artifacts.length,1);
  assert.equal(artifacts[0].href,downloadItem.href);
  const artifactUrl=app.url+downloadItem.href;
  await writeFile(join(checkout,'.hq-owned-workspace'),'other-project\n');
  assert.equal((await fetch(artifactUrl,{headers:{cookie}})).status,404);
  await writeFile(join(checkout,'.hq-owned-workspace'),fixture['.hq-owned-workspace']);
  const {result:otherResult,context:other} = await read('other-turn');
  assert.equal(other.coverage.artifactEvidence,'unpublished');
  assert.deepEqual(other.artifacts,[]);
  assert.equal(Object.hasOwn(otherResult,'artifactDownloads'),false);
  const readback = await prepareArtifactEvidenceReadback({checkout,head:project.nativeHandover.checkoutHead,
    files:project.nativeHandover.artifacts,workspaceProject:'example',signal:AbortSignal.timeout(12000)});
  assert.equal(readback?.(),true);
  await writeFile(join(checkout,'artifact.txt'),'Changed without attestation');
  assert.equal(readback(),false);
  assert.equal((await fetch(artifactUrl,{headers:{cookie}})).status,404);
  const {result:changedResult,context:changed} = await read('verified-turn');
  assert.equal(changed.coverage.artifactEvidence,'unverified');
  assert.deepEqual(changed.artifacts,[]);
  assert.equal(Object.hasOwn(changedResult,'artifactDownloads'),false);

  git(['rm','--','verification.txt']);
  git(['add','--','artifact.txt']);
  git([...identity,'commit','-qm','continue with a different artifact']);
  const next = git(['rev-parse','HEAD']);
  assert.notEqual(next,project.nativeHandover.checkoutHead);
  const after = await (await fetch(listPath,{headers:{cookie}})).json();
  assert.equal(after.artifacts.length,1);
  assert.equal(after.artifacts[0].href,artifacts[0].href);
  assert.match(after.artifacts[0].description,/保存時の版/);
  for (const [item,name] of files) {
    const original = await fetch(app.url+item.href,{headers:{cookie}});
    assert.equal(original.status,200);
    assert.equal(await original.text(),fixture[name]);
  }
  const retained = await read('verified-turn');
  assert.equal(retained.context.coverage.artifactEvidence,'verified');
  assert.deepEqual(retained.result.artifactDownloads,published.artifactDownloads);
  assert.equal(await readFile(join(checkout,'artifact.txt'),'utf8'),'Changed without attestation');
  assert.equal(git(['rev-parse','HEAD']),next);
  assert.equal(git(['status','--porcelain']),'?? .hq-owned-workspace');
  const retainedReadback = await prepareArtifactEvidenceReadback({checkout,head:next,
    files:project.nativeHandover.artifacts,workspaceProject:'example',archived:true,signal:AbortSignal.timeout(12000)});
  assert.equal(retainedReadback?.(),true);

  const definition = {...seed,projects:[{...project,nativeHandover:{...project.nativeHandover,shareArtifacts:false}}]};
  await writeFile(join(directory,'portfolio.json'),JSON.stringify(definition),{mode:0o600});
  for (const [item] of files) assert.equal((await fetch(app.url+item.href,{headers:{cookie}})).status,404);
  assert.equal(Object.hasOwn((await read('verified-turn')).result,'artifactDownloads'),false);
  assert.deepEqual((await (await fetch(listPath,{headers:{cookie}})).json()).artifacts,[]);
  await writeFile(join(directory,'portfolio.json'),JSON.stringify({...seed,projects:[project]}),{mode:0o600});
  const unrelated = git([...identity,'commit-tree',next+'^{tree}','-m','separate Git history']);
  git(['checkout','--detach',unrelated]);
  assert.equal(retainedReadback(),false);
  assert.equal((await fetch(artifactUrl,{headers:{cookie}})).status,404);
  assert.deepEqual((await (await fetch(listPath,{headers:{cookie}})).json()).artifacts,[]);
  const gitInfo = join(checkout,'.git','info');
  await mkdir(gitInfo,{recursive:true});
  await writeFile(join(gitInfo,'grafts'),unrelated+' '+project.nativeHandover.checkoutHead+'\n');
  assert.equal((await fetch(artifactUrl,{headers:{cookie}})).status,404);
});

test('Codex chat context locates a previously displayed turn from its scoped native history cursor', async t => {
  const {directory, start} = await runtimeFixture(t);
  const checkout = seed.projects[0].cwd;
  await writeFile(join(directory,'portfolio.json'),JSON.stringify({...seed,
    projects:[...seed.projects,{id:'other', name:'Other',cwd:checkout+'-other'}]}),{mode:0o600});
  const cursors = [];
  const app = await start({codex:{
    async readThread(scope,id,cursor) {
      if (!scope.includes(checkout)) throw Object.assign(new Error('Out of scope'),{status:404});
      cursors.push(cursor);
      if (cursor === 'tail-page') return {thread:{id},turns:[{id:'oldest',status:'completed'}],nextCursor:null};
      if (cursor === 'cycle') return {thread:{id},turns:[],nextCursor:'cycle'};
      const page = Number(cursor?.slice(5) ?? 0);
      return {thread:{id},turns:[{id:'turn-'+page,status:'completed'}],nextCursor:'page-'+(page+1)};
    },
    async readTurnEvidence(_scope,id,turn) { return {threadId:id,turnId:turn,entries:[],nextCursor:null}; },
  }});
  const cookie = await login(app);
  const url=app.url+'/api/codex/chat-context?';
  const base={project:'example',id:'thread',turn:'oldest'};
  const call=(query={})=>fetch(url+new URLSearchParams({...base,...query}),{headers:{cookie}});
  assert.equal((await call()).status,404);
  assert.deepEqual(cursors.splice(0),[null,'page-1','page-2','page-3']);
  assert.equal((await call({historyCursor:'tail-page',project:'other'})).status,404);
  assert.equal((await call({historyCursor:'tail-page',turn:'foreign'})).status,404);
  const read=await call({historyCursor:'tail-page'});
  assert.equal(read.status,200);
  const result=await read.json();
  assert.equal(result.turnId,'oldest');
  assert.equal(JSON.parse(result.document.text).coverage.turnPages,1);
  assert.deepEqual(cursors.splice(0),['tail-page','tail-page']);
  assert.equal((await call({historyCursor:'cycle'})).status,503);
  assert.equal((await fetch(url+new URLSearchParams(base)+'&historyCursor=one&historyCursor=two',{headers:{cookie}})).status,400);
  assert.equal((await call({historyCursor:'\n'})).status,400);
  assert.deepEqual(cursors,['cycle']);
});
