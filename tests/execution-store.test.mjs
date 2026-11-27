import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExecutionStore } from '../app/execution-store.mjs';

const now = Date.parse('2026-11-27T07:00:00Z');
const hash = 'a'.repeat(64);
const checkpoint = version => ({ id: `cp-${version}`, version, goalId: 'goal-1', requirementsHash: hash, conversationHash: hash, stopHash: hash, budgetHash: hash, artifactsHash: hash });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-execution-'));
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('hq-execution-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const file = path.join(dir, 'execution.json');
  return { file, store: new ExecutionStore(file, { authorityId: 'owner-main' }) };
}
const context = () => ({ now, capabilities: {
  api: { available: true, executorId: 'api-worker-1', defaultModel: 'high-model', models: [{ id: 'high-model', reasoningEfforts: ['high'] }] },
  subscription: { available: true, executorId: 'codex-worker-1', authMode: 'chatgpt', defaultModel: 'high-model', models: [{ id: 'high-model', reasoningEfforts: ['high'] }] },
}, safety: { authorized: true, status: 'ready', allowedRoutes: ['api', 'subscription'], api: {
  organizationId: 'grant-org', creditOrganizationId: 'grant-org', reservationAuthorityId: 'owner-main', availableCreditUsd: 0.3,
  observedAt: '2026-11-27T06:59:30Z', expiresAt: '2026-11-28T00:00:00Z', zeroAdditionalCostGuaranteed: true, maxRequestCostUsd: 0.2,
} } });
const request = (projectId = 'project-a', taskId = 'task-1') => ({ projectId, taskId, instructionDigest: hash, expectedRevision: 1, task: {} });
function finish(store, requestInfo, receipt, extra = {}) {
  return store.recordOutcome({ ...requestInfo, executionId: receipt.operation.executionId, outcome: 'completed', confirmedTerminal: true, effectsReconciled: true, checkpoint: checkpoint(1), ...extra });
}

const voiceRequest = (taskId = 'voice-first') => ({...request('project-a', taskId), kind: 'realtime-voice',
  task: {route: 'api', stage: 'consultation', model: 'voice-fixture', reasoningEffort: 'none'}});
function voiceContext() {
  const current = context();
  current.capabilities.api = {available: true, executorId: 'owner-realtime-voice', defaultModel: 'voice-fixture',
    models: [{id: 'voice-fixture', reasoningEfforts: ['none']}]};
  current.realtimeVoice = {scopeDigest: hash, config: {model: 'voice-fixture', voice: 'test-voice',
    transcriptionModel: 'asr-test', contextTokens: 3200, maxInputSeconds: 10, maxOutputTokens: 100,
    rates: {inputTextUsdPerMillion: 5, inputAudioUsdPerMillion: 30, cachedTextUsdPerMillion: 2,
      cachedAudioUsdPerMillion: 3, outputTextUsdPerMillion: 10, outputAudioUsdPerMillion: 35},
    transcription: {type: 'duration', usdPerMinute: 0.06, billingIncrementSeconds: 1}}};
  return current;
}
const billedVoice = {
  responseRequested: true,
  response: {id: 'resp_voice_A', status: 'completed', usage: {inputTokens: 4, outputTokens: 3, totalTokens: 7,
    input: {textTokens: 2, audioTokens: 2}, output: {textTokens: 0, audioTokens: 3}, cachedInput: {textTokens: 1, audioTokens: 0}}},
  transcription: {itemId: 'item_voice_A', usage: {type: 'duration', seconds: 1.25}},
};

test('Realtime reserves shared credit and settles separate receipts without changing the development checkpoint', t => {
  const {file, store} = fixture(t);
  store.updateSettings('project-a', 0, {mode: 'api-only', apiBudgetUsd: 0.25});
  store.updateSettings('project-b', 0, {mode: 'api-only', apiBudgetUsd: 0.25});
  const prior = store.prepareDispatch(request(), context());
  assert.equal(prior.dispatchable, true);
  assert.equal(store.markDispatched('project-a', 'task-1', prior.operation.executionId, context()).dispatchable, true);
  finish(store, request(), prior, {actualCostUsd: 0.01});
  const voice = voiceContext();
  assert.equal(store.previewRealtime('project-a', voiceRequest().task, voice).code, 'HANDOVER_REQUIRED');
  voice.handoverReadback = checkpoint(1);
  const prepared = store.prepareDispatch(voiceRequest(), voice);
  assert.equal(prepared.operation.reservedMicros, 109500);
  assert.equal(store.prepareDispatch(request('project-b'), context()).code, 'SHARED_CREDIT_INSUFFICIENT');
  const {executionId} = prepared.operation;
  assert.equal(store.markDispatched('project-a', 'voice-first', executionId, voice).dispatchable, true);
  assert.throws(() => store.recordOutcome({...voiceRequest(), executionId, outcome: 'completed'}), /EXECUTION_KIND_MISMATCH/);
  const settlement = {...voiceRequest(), executionId, phase: 'terminal', outcome: 'completed', receipts: billedVoice};
  const result = store.recordRealtimeOutcome(settlement);
  assert.equal(result.operation.costMicros, 2172);
  assert.deepEqual([result.operation.voiceSettlement.response.accountedMicros,
    result.operation.voiceSettlement.transcription.accountedMicros], [172, 2000]);
  const reopened = new ExecutionStore(file, {authorityId: 'owner-main'});
  const saved = reopened.getWork('project-a');
  assert.equal(saved.settledApiMicros, 12172);
  assert.equal(saved.checkpointOperation.executionId, prior.operation.executionId);
  assert.deepEqual(saved.checkpoint, checkpoint(1));
  assert.equal(reopened.recordRealtimeOutcome(settlement).replayed, true);
  assert.equal(reopened.prepareDispatch(voiceRequest(), voice).dispatchable, false);
  assert.equal(reopened.prepareDispatch(request('project-b'), context()).dispatchable, true);
});

test('Realtime preserves partial receipts and the reservation across restart', t => {
  const {file, store} = fixture(t);
  store.updateSettings('project-a', 0, {mode: 'api-only', apiBudgetUsd: 0.25});
  store.updateSettings('project-b', 0, {mode: 'api-only', apiBudgetUsd: 0.25});
  const voice = voiceContext();
  const {operation: {executionId}} = store.prepareDispatch(voiceRequest(), voice);
  assert.equal(store.markDispatched('project-a', 'voice-first', executionId, voice).dispatchable, true);
  store.recordRealtimeOutcome({...voiceRequest(), executionId, phase: 'uncertain', outcome: 'failed',
    receipts: {...billedVoice, transcription: null}});
  const reopened = new ExecutionStore(file, {authorityId: 'owner-main'});
  const {operation, busy, settledApiMicros, checkpoint: current} = reopened.getWork('project-a');
  assert.equal(busy, true);
  assert.equal(settledApiMicros, 0);
  assert.equal(current, null);
  assert.equal(operation.status, 'uncertain');
  assert.equal(operation.voiceSettlement.response.accountedMicros, 172);
  assert.equal(operation.voiceSettlement.transcription, null);
  assert.equal(reopened.prepareDispatch(voiceRequest('voice-second'), voice).code, 'PROJECT_BUSY');
  assert.equal(reopened.prepareDispatch(request('project-b'), context()).code, 'SHARED_CREDIT_INSUFFICIENT');
});

test('two projects keep different settings across a real new Node process', t => {
  const { file, store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'api-only', apiBudgetUsd: 0.25 });
  store.updateSettings('project-b', 0, { mode: 'subscription-only', model: 'high-model' });
  const moduleUrl = new URL('../app/execution-store.mjs', import.meta.url).href;
  const script = `import { ExecutionStore } from ${JSON.stringify(moduleUrl)};const s=new ExecutionStore(process.argv[1],{authorityId:'owner-main'});process.stdout.write(JSON.stringify([s.getSettings('project-a'),s.getSettings('project-b')]));`;
  const processResult = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8' });
  assert.equal(processResult.status, 0, processResult.stderr);
  const [a, b] = JSON.parse(processResult.stdout);
  assert.equal(a.settings.mode, 'api-only');
  assert.equal(a.settings.apiBudgetUsd, 0.25);
  assert.equal(b.settings.mode, 'subscription-only');
  assert.equal(b.settings.model, 'high-model');
});

test('reading absent settings creates no files and stale updates cannot overwrite', t => {
  const { file, store } = fixture(t);
  assert.equal(store.getSettings('project-a').revision, 0);
  assert.equal(fs.existsSync(file), false);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  assert.throws(() => store.updateSettings('project-a', 0, { mode: 'api-only' }), /REVISION_CONFLICT/);
  assert.equal(store.getSettings('project-a').settings.mode, 'subscription-only');
});

test('duplicate task reuses its receipt and never grants a second dispatch', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  const first = store.prepareDispatch(request(), context());
  const second = store.prepareDispatch(request(), context());
  assert.equal(first.dispatchable, true);
  assert.equal(second.dispatchable, false);
  assert.equal(second.replayed, true);
  assert.equal(second.operation.executionId, first.operation.executionId);
  assert.throws(() => store.prepareDispatch({ ...request(), instructionDigest: 'b'.repeat(64) }, context()), /TASK_ID_CONFLICT/);
});

test('a running or uncertain task prevents configuration changes and another launch', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  const receipt = store.prepareDispatch(request(), context());
  assert.throws(() => store.updateSettings('project-a', 1, { mode: 'api-only', apiBudgetUsd: 1 }), /PROJECT_BUSY/);
  assert.equal(store.prepareDispatch(request('project-a', 'task-2'), context()).code, 'PROJECT_BUSY');
  store.recordOutcome({ ...request(), executionId: receipt.operation.executionId, outcome: 'interrupted', confirmedTerminal: false });
  assert.equal(store.prepareDispatch(request('project-a', 'task-2'), context()).code, 'PROJECT_BUSY');
});

test('two projects reserve against one organization balance instead of each using it', t => {
  const { store } = fixture(t);
  for (const id of ['project-a', 'project-b']) store.updateSettings(id, 0, { mode: 'api-only', apiBudgetUsd: 1 });
  assert.equal(store.prepareDispatch(request(), context()).allowed, true);
  assert.equal(store.prepareDispatch(request('project-b'), context()).code, 'SHARED_CREDIT_INSUFFICIENT');
});

test('an outcome with missing cost retains its reservation after restart', t => {
  const { file, store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'api-only', apiBudgetUsd: 1 });
  store.updateSettings('project-b', 0, { mode: 'api-only', apiBudgetUsd: 1 });
  const receipt = store.prepareDispatch(request(), context());
  finish(store, request(), receipt);
  const resumed = new ExecutionStore(file, { authorityId: 'owner-main' });
  assert.equal(resumed.prepareDispatch(request('project-b'), context()).code, 'SHARED_CREDIT_INSUFFICIENT');
});

test('confirmed settlement is idempotent and delayed old events cannot unlock a new job', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  const first = store.prepareDispatch(request(), context());
  finish(store, request(), first);
  assert.equal(finish(store, request(), first).replayed, true);
  const second = store.prepareDispatch(request('project-a', 'task-2'), context());
  assert.equal(second.allowed, true);
  finish(store, request(), first);
  assert.equal(store.prepareDispatch(request('project-a', 'task-3'), context()).code, 'PROJECT_BUSY');
  assert.throws(() => store.recordOutcome({ ...request('project-a', 'task-2'), executionId: first.operation.executionId, outcome: 'completed', confirmedTerminal: true, effectsReconciled: true, checkpoint: checkpoint(2) }), /EXECUTION_ID_MISMATCH/);
});

test('dispatch rechecks a new pause before any external launch', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  const receipt = store.prepareDispatch(request(), context());
  const paused = context(); paused.safety.status = 'paused';
  const result = store.markDispatched('project-a', 'task-1', receipt.operation.executionId, paused);
  assert.equal(result.allowed, false);
});

test('an unstarted reservation can be cancelled, while each follow-up must recheck the same paid receipt', t => {
  const {store} = fixture(t);
  store.updateSettings('project-a', 0, {mode: 'api-only', apiBudgetUsd: 1});
  const reserved = store.prepareDispatch(request(), context()).operation;
  assert.equal(store.cancelReserved('project-a', 'task-1', reserved.executionId, now).cancelled, true);
  assert.equal(store.markDispatched('project-a', 'task-1', reserved.executionId, context()).allowed, false);
  assert.equal(store.getWork('project-a', 'task-1').operation.status, 'cancelled');
  assert.equal(store.getWork('project-a').busy, false);
  const current = store.prepareDispatch(request('project-a', 'task-2'), context()).operation;
  assert.equal(store.markDispatched('project-a', 'task-2', current.executionId, context()).allowed, true);
  assert.equal(store.cancelReserved('project-a', 'task-2', current.executionId, now).cancelled, false);
  const exhausted = context();
  exhausted.safety.api.availableCreditUsd = 0.01;
  assert.equal(store.recheckDispatched('project-a', 'task-2', current.executionId, exhausted).code, 'SHARED_CREDIT_INSUFFICIENT');
  assert.equal(store.recheckDispatched('project-a', 'task-2', current.executionId, context()).dispatchable, true);
  assert.equal(store.getWork('project-a').busy, true);
});

test('route handover requires matching destination readback and never resets spending', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'api-only', apiBudgetUsd: 0.25 });
  const first = store.prepareDispatch(request(), context());
  finish(store, request(), first, { actualCostUsd: 0.2 });
  store.updateSettings('project-a', 1, { mode: 'subscription-only' });
  const next = { ...request('project-a', 'task-2'), expectedRevision: 2 };
  assert.equal(store.prepareDispatch(next, context()).code, 'HANDOVER_REQUIRED');
  const ready = context(); ready.handoverReadback = checkpoint(1);
  const second = store.prepareDispatch(next, ready);
  assert.equal(second.allowed, true);
  assert.equal(store.markDispatched(next.projectId, next.taskId, second.operation.executionId, context()).code, 'HANDOVER_REQUIRED');
  const changed = {...ready, handoverReadback: {...checkpoint(1), requirementsHash: 'b'.repeat(64)}};
  assert.equal(store.markDispatched(next.projectId, next.taskId, second.operation.executionId, changed).code, 'HANDOVER_REQUIRED');
  assert.equal(store.markDispatched(next.projectId, next.taskId, second.operation.executionId, ready).dispatchable, true);
  assert.equal(store.recheckDispatched(next.projectId, next.taskId, second.operation.executionId, changed).code, 'HANDOVER_REQUIRED');
  finish(store, next, second, { checkpoint: checkpoint(2) });
  store.updateSettings('project-a', 2, { mode: 'api-only', apiBudgetUsd: 0.25 });
  ready.handoverReadback = checkpoint(2);
  assert.equal(store.prepareDispatch({ ...request('project-a', 'task-3'), expectedRevision: 3 }, ready).code, 'PROJECT_BUDGET_EXCEEDED');
});

test('independent authority or corrupt state fails closed without replacing the file', t => {
  const { file, store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  assert.throws(() => new ExecutionStore(file, { authorityId: 'other-authority' }).getSettings('project-a'), /AUTHORITY_MISMATCH/);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => store.updateSettings('project-a', 1, { mode: 'api-only' }), /STATE_INVALID/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('file lock refuses concurrent writers and leaves prior settings intact', t => {
  const { file, store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  fs.writeFileSync(`${file}.lock`, 'another-writer', { flag: 'wx' });
  assert.throws(() => store.updateSettings('project-a', 1, { mode: 'api-only' }), /STORE_BUSY/);
  assert.equal(store.getSettings('project-a').settings.mode, 'subscription-only');
});

test('API requests cannot use an independent per-device reservation authority', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'api-only', apiBudgetUsd: 1 });
  const wrong = context(); wrong.safety.api.reservationAuthorityId = 'zbook-copy';
  assert.equal(store.prepareDispatch(request(), wrong).code, 'RESERVATION_AUTHORITY_MISMATCH');
});

test('invalid IDs cannot mutate another project or create arbitrary object keys', t => {
  const { store } = fixture(t);
  for (const id of ['../outside', '__proto__', 'constructor', '']) assert.throws(() => store.updateSettings(id, 0, { mode: 'subscription-only' }));
});

test('settled costs are still withheld until the official balance explicitly includes them', t => {
  const { store } = fixture(t);
  for (const id of ['project-a', 'project-b']) store.updateSettings(id, 0, { mode: 'api-only', apiBudgetUsd: 1 });
  const first = store.prepareDispatch(request(), context());
  finish(store, request(), first, { actualCostUsd: 0.2 });
  assert.equal(store.prepareDispatch(request('project-b'), context()).code, 'SHARED_CREDIT_INSUFFICIENT');
  const reconciled = context(); reconciled.safety.api.includedExecutionIds = [first.operation.executionId];
  assert.equal(store.prepareDispatch(request('project-b'), reconciled).allowed, true);
});

test('checkpoint metadata cannot introduce arbitrary secret fields into the state', t => {
  const { file, store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only' });
  const first = store.prepareDispatch(request(), context());
  assert.throws(() => finish(store, request(), first, { checkpoint: { ...checkpoint(1), apiKey: 'EXAMPLE_sensitive-value' } }), /INVALID_CHECKPOINT/);
  assert.equal(fs.readFileSync(file, 'utf8').includes('EXAMPLE_sensitive-value'), false);
});

test('dispatch cannot change the API organization after reserving its funds', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'api-only', apiBudgetUsd: 1 });
  const receipt = store.prepareDispatch(request(), context());
  const changed = context();
  changed.safety.api.organizationId = 'other-org';
  changed.safety.api.creditOrganizationId = 'other-org';
  assert.equal(store.markDispatched('project-a', 'task-1', receipt.operation.executionId, changed).allowed, false);
});

test('missing stored settings cannot turn an API-only project into subscription defaults', t => {
  const { file, store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'api-only', apiBudgetUsd: 1 });
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete state.projects['project-a'].settings;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => store.prepareDispatch(request(), context()), /STATE_INVALID/);
});

test('missing organization in a stored reservation cannot release shared funds', t => {
  const { file, store } = fixture(t);
  for (const projectId of ['project-a', 'project-b']) store.updateSettings(projectId, 0, { mode: 'api-only', apiBudgetUsd: 1 });
  store.prepareDispatch(request(), context());
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete state.projects['project-a'].operations['task-1'].organizationId;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => store.prepareDispatch(request('project-b'), context()), /STATE_INVALID/);
});

test('a model or device change on the same route requires matching checkpoint readback', t => {
  const { store } = fixture(t);
  store.updateSettings('project-a', 0, { mode: 'subscription-only', model: 'high-model' });
  const first = store.prepareDispatch(request(), context());
  finish(store, request(), first);
  store.updateSettings('project-a', 1, { model: 'second-high-model' });
  const changed = context();
  changed.capabilities.subscription.defaultModel = 'second-high-model';
  changed.capabilities.subscription.models.push({ id: 'second-high-model', reasoningEfforts: ['high'] });
  const next = { ...request('project-a', 'task-2'), expectedRevision: 2 };
  assert.equal(store.prepareDispatch(next, changed).code, 'HANDOVER_REQUIRED');
  changed.handoverReadback = checkpoint(1);
  const second = store.prepareDispatch(next, changed);
  assert.equal(second.allowed, true);
  finish(store, next, second, { checkpoint: checkpoint(2) });
  changed.capabilities.subscription.executorId = 'codex-worker-2';
  delete changed.handoverReadback;
  assert.equal(store.prepareDispatch({ ...request('project-a', 'task-3'), expectedRevision: 2 }, changed).code, 'HANDOVER_REQUIRED');
});
