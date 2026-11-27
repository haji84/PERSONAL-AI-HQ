import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
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

async function fixture(t, fetchImpl, {handover = false, auxiliary = [], codex = {}} = {}) {
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
  }), {mode: 0o600});
  async function open(enableExecution) {
    await app?.close();
    servers.delete(app);
    app = await startOwnerApp({directory, port: 0, codex, apiDevelopment: enableExecution && {getKey: () => 'fixture-only', fetchImpl}});
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
  return {call: (...args) => requests(...args), source, requirements, portfolio, directory, store, ledgerFile, commitFiles, commitSource, open, openReader};
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
    return Response.json({model: modelId, service_tier: 'default', status: 'completed', usage: {input_tokens: 100, output_tokens: 25},
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

function providerAnswer(answer, changes = [{path: 'source.mjs', text: `export const answer = ${answer};\n`}]) {
  return Response.json({model: modelId, service_tier: 'default', status: 'completed', usage: {input_tokens: 100, output_tokens: 25},
    output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({
      summary: '実行確認', changes,
    })}]}]});
}

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
      return {ordinaryUsageAllowed: allowedUsage, windows: [{usedPercent: 20}]};
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
