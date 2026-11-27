import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {startOwnerApp} from '../app/server.mjs';
import {ExecutionStore} from '../app/execution-store.mjs';
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
    models:async () => {
      modelReads++;
      return {accountType:'chatgpt', data:[{id:'current', isDefault:true, defaultReasoningEffort:'low',
        reasoningEfforts:[{reasoningEffort:'low'}]}]};
    },
    async submit(input) {
      nativeStarts++;
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

  ]};
  const file = join(directory,'portfolio.json');
  await writeFile(file,JSON.stringify(definition),{mode:0o600});
  let modelReads = 0;
  const app = await start({codex:{models() { modelReads++; throw new Error('No model is needed'); }}});
  const path = '/api/execution/estimates';
  assert.equal((await fetch(app.url+path+'?project=example')).status,401);
  const cookie = await login(app);
  const get = (route = path+'?project=example') => fetch(app.url+route,{headers:{cookie}});
  const update = async (revision, settings) => fetch(app.url+'/api/execution/settings?project=example',{method:'POST',
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
