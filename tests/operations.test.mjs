import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createOperations} from '../app/operations.mjs';

const ordinaryUsage = (overrides = {}) => ({observedAt: new Date().toISOString(),
  ordinaryUsageAllowed: true, windows: [{usedPercent: 20}], ...overrides});

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hq-operation-test-')));
  const workspace = join(directory, 'workspaces', 'fixture');
  await mkdir(workspace, {recursive: true, mode: 0o700});
  await writeFile(join(workspace, '.hq-owned-workspace'), 'fixture\n');
  const project = {id: 'fixture', codexWrite: true, cwd: [workspace]};
  const authorize = enabled => writeFile(join(directory, 'portfolio.json'), JSON.stringify({
    projects: [{id: project.id, name: 'Fixture', enableCodexWrite: enabled, cwd: workspace, state: 'ready'}],
  }), {mode: 0o600});
  await authorize(true);
  const opened = new Set();
  t.after(async () => {
    for (const entry of opened) entry.close();
    await rm(directory, {recursive: true, force: true});
  });
  return {
    project, workspace, authorize,
    database: () => new DatabaseSync(join(directory, 'conversations.sqlite')),
    open(native) {
      const operations = createOperations(directory, {canWrite: true, subscriptionReady: async () => true,
        usage: async () => ordinaryUsage(), ...native});
      opened.add(operations);
      return {...operations, close() { opened.delete(operations); operations.close(); }};
    },
    age(id) {
      const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
      try { db.prepare('UPDATE codex_operations SET updatedAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z', id); }
      finally { db.close(); }
    },
  };
}

test('API-key or unknown accounts cannot start a subscription operation', async t => {
  const {project, open} = await fixture(t);
  let sends = 0;
  const operations = open({subscriptionReady: async () => false, submit: async () => { sends++; }});
  await assert.rejects(operations.start(project, {id: 'request-account', prompt: 'A fixture'}), {status: 403});
  assert.equal((await operations.read(project)).operation, null);
  assert.equal(sends, 0);
});

test('an exhausted or unverified ordinary subscription creates no native submission or reservation', async t => {
  const {project, open} = await fixture(t);
  let snapshot, submits = 0;
  const operations = open({
    usage: async () => snapshot,
    async submit() { submits++; return {turn: {id: 'fixture-turn', status: 'completed'}}; },
  });
  const denied = 'CODEX_SUBSCRIPTION_LIMIT_REACHED';
  const unverified = 'CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED';
  const request = {id: 'request-limit-guard', prompt: 'A fixture'};
  for (const [usage, code] of [
    [ordinaryUsage({ordinaryUsageAllowed: false}), denied],
    [ordinaryUsage({windows: [{usedPercent: 20}, {usedPercent: 100}]}), denied],
    [ordinaryUsage({ordinaryUsageAllowed: null}), unverified],
    [ordinaryUsage({windows: []}), unverified],
    [ordinaryUsage({windows: [{usedPercent: -1}]}), unverified],
    [ordinaryUsage({observedAt: '2000-01-01T00:00:00.000Z'}), unverified],
    [null, unverified],
  ]) {
    snapshot = usage;
    await assert.rejects(operations.start(project, request), {status: 409, code});
  }
  assert.equal((await operations.read(project)).operation, null);
  assert.equal(submits, 0);
});

test('subscription admission reads after preparation and expires before native thread setup', async t => {
  t.mock.timers.enable({apis:['Date'], now:new Date('2026-11-28T02:00:00Z')});
  const {project, open} = await fixture(t);
  const order = [];
  const threadSetups = [];
  const operations = open({
    async models() {
      order.push('models');
      t.mock.timers.tick(16000);
      return {data:[{id:'fixture-model'}]};
    },
    async usage() { order.push('usage'); return ordinaryUsage(); },
    async submit(input) {
      if (input.requestId === 'stale-thread-setup') t.mock.timers.tick(16000);
      assert.equal(input.beforeThread(), true);
      threadSetups.push(input.requestId);
      await input.beforeTurn();
      assert.equal(input.onThread('fixture-thread'), true);
      return {turn:{id:'fixture-turn',status:'completed'}};
    },
  });
  await operations.start(project, {id:'fresh-after-model', prompt:'A fixture', model:'fixture-model'});
  await until(async () => (await operations.read(project, 'fresh-after-model')).operation.phase === 'completed');
  assert.deepEqual(order,['models','usage','usage']);

  await operations.start(project, {id:'stale-thread-setup', prompt:'A fixture'});
  await until(async () => (await operations.read(project, 'stale-thread-setup')).operation.phase === 'failed');
  const {operation} = await operations.read(project, 'stale-thread-setup');
  assert.equal(operation.threadId,null);
  assert.match(operation.output,/契約内利用枠を確認できず/);
  assert.deepEqual(threadSetups,['fresh-after-model']);
});

test('ordinary subscription is rechecked before new and resumed turns send', async t => {
  const {project, open} = await fixture(t);
  let checkAtSend = true;
  const sent = [];
  const operations = open({
    usage: async () => ordinaryUsage({ordinaryUsageAllowed: checkAtSend}),
    async submit(input) {
      assert.equal(input.beforeThread(), true);
      if (input.requestId !== 'accepted-thread') checkAtSend = false;
      try { await input.beforeTurn?.(); }
      finally { checkAtSend = true; }
      assert.equal(input.onThread(input.knownId ?? 'fixture-thread'), true);
      sent.push(input.requestId);
      return {turn: {id: input.requestId + '-turn', status: 'completed'}};
    },
  });
  const initial = {id: 'blocked-new-turn', prompt: 'A new fixture'};
  assert.equal((await operations.start(project, initial)).operation.phase, 'reserved');
  await until(async () => (await operations.read(project, initial.id)).operation.phase === 'failed');
  assert.equal((await operations.start(project, initial)).operation.phase, 'failed');
  assert.deepEqual(sent, []);

  const accepted = {id: 'accepted-thread', prompt: 'Start once'};
  await operations.start(project, accepted);
  await until(async () => (await operations.read(project, accepted.id)).operation.phase === 'completed');
  const resume = {id: 'blocked-resumed-turn', prompt: 'Continue', resume: accepted.id, expectedThreadId: 'fixture-thread'};
  checkAtSend = false;
  await assert.rejects(operations.start(project, resume), {status: 409, code: 'CODEX_SUBSCRIPTION_LIMIT_REACHED'});
  assert.equal((await operations.read(project, resume.id)).operation, null);
  checkAtSend = true;
  await operations.start(project, resume);
  await until(async () => (await operations.read(project, resume.id)).operation.phase === 'failed');
  const failed = (await operations.read(project, resume.id)).operation;
  assert.equal(failed.turnId, null);
  assert.equal(failed.threadId, null);
  assert.deepEqual(sent, [accepted.id]);
});

test('a lost ordinary allowance blocks steering without blocking interruption', async t => {
  const {project, open, workspace} = await fixture(t);
  let permitted = true, steeringSent = 0, interrupted = 0;
  const operations = open({
    usage: async () => ordinaryUsage({ordinaryUsageAllowed: permitted}),
    async submit(input) {
      assert.equal(input.beforeThread(), true);
      await input.beforeTurn?.();
      assert.equal(input.onThread('fixture-thread'), true);
      return {turn: {id: 'fixture-turn', status: 'inProgress'}};
    },
    async steer({beforeSteer, beforeSend}) {
      permitted = false;
      await beforeSteer?.();
      beforeSend?.();
      steeringSent++;
      return 'fixture-turn';
    },
    async interrupt(scope, thread, turn, beforeSend) {
      assert.deepEqual([scope, thread, turn], [workspace, 'fixture-thread', 'fixture-turn']);
      beforeSend();
      interrupted++;
    },
  });
  const initial = {id: 'already-running', prompt: 'A fixture'};
  await operations.start(project, initial);
  await until(async () => (await operations.read(project, initial.id)).operation.phase === 'running');
  const extra = {id: 'blocked-steer', operationId: initial.id, prompt: 'Additional fixture instruction'};
  permitted = false;
  await assert.rejects(operations.steer(project, extra), {status: 409, code: 'CODEX_SUBSCRIPTION_LIMIT_REACHED'});
  assert.equal((await operations.readSteering(project, extra.id)).steering, null);
  permitted = true;
  assert.equal((await operations.steer(project, extra)).steering.phase, 'rejected');
  assert.equal((await operations.steer(project, extra)).steering.phase, 'rejected');
  assert.equal((await operations.read(project, initial.id)).operation.phase, 'running');
  assert.equal((await operations.interrupt(project, initial.id)).operation.phase, 'interrupting');
  assert.deepEqual([steeringSent, interrupted], [0, 1]);
});

test('a concurrent steering replay uses the existing receipt when its allowance check fails', async t => {
  const {project, open} = await fixture(t);
  const checks = [Promise.withResolvers(), Promise.withResolvers()];
  let readAdmission = false, steeringReads = 0, sends = 0;
  const operations = open({
    async usage() {
      if (!readAdmission) return ordinaryUsage();
      const pending = checks[steeringReads++];
      return pending ? pending.promise : ordinaryUsage();
    },
    async submit(input) {
      await input.beforeTurn?.();
      assert.equal(input.onThread('fixture-thread'), true);
      return {turn: {id: 'fixture-turn', status: 'inProgress'}};
    },
    async steer({beforeSteer, beforeSend}) {
      await beforeSteer?.();
      beforeSend();
      sends++;
      return 'fixture-turn';
    },
  });
  const request = {id: 'concurrent-origin', prompt: 'A fixture'};
  await operations.start(project, request);
  await waitForPhase(operations, project, request.id, 'running');
  const extra = {id: 'concurrent-steer', operationId: request.id, prompt: 'Add once'};
  readAdmission = true;
  const replies = Promise.allSettled([operations.steer(project, extra), operations.steer(project, extra)]);
  try {
    await until(() => steeringReads === checks.length);
    checks[0].resolve(ordinaryUsage());
    await until(async () => (await operations.readSteering(project, extra.id)).steering?.phase === 'accepted');
  } finally {
    checks[0].resolve(ordinaryUsage());
    checks[1].resolve(ordinaryUsage({ordinaryUsageAllowed: false}));
  }
  const expected = await operations.readSteering(project, extra.id);
  assert.deepEqual(await replies, [{status: 'fulfilled', value: expected}, {status: 'fulfilled', value: expected}]);
  assert.equal(sends, 1);
});

test('a restarted gateway releases a pre-send reservation and fences its late sender', async t => {
  const {project, open, age} = await fixture(t);
  let permit;
  const first = open({async submit(input) { permit = input.onThread; return new Promise(() => {}); }});
  const request = {id: 'request-reserved', prompt: 'A fixture'};
  assert.equal((await first.start(project, request)).operation.phase, 'reserved');
  age(request.id);
  const second = open({async submit() { return new Promise(() => {}); }});
  const stale = (await second.read(project, request.id)).operation;
  assert.equal(stale.phase, 'failed');
  assert.equal(stale.turnId, null);
  assert.equal(permit('too-late'), false);
  assert.equal((await second.start(project, request)).operation.phase, 'failed');
  assert.equal((await second.start(project, {id: 'request-next', prompt: 'Next'})).operation.phase, 'reserved');
});

test('a lost acknowledgement is reconciled by native client ID without another submission', async t => {
  const {project, workspace, open, age} = await fixture(t);
  const request = {id: 'request-accepted', prompt: 'A fixture'};
  let appEvent, sends = 0;
  const first = open({onEvent(listener) { appEvent = listener; }, async submit(input) {
    sends++;
    await input.beforeTurn?.();
    input.onThread('fixture-thread');
    appEvent('turn/started', {threadId: 'fixture-thread', turn: {id: 'unrelated-turn', status: 'inProgress'}});
    return new Promise(() => {});
  }});
  await first.start(project, request);
  assert.equal((await first.read(project, request.id)).operation.turnId, null);
  first.close();
  age(request.id);
  const second = open({async findSubmission(scope, thread, clientId, turnId) {
    assert.deepEqual([scope, thread, clientId, turnId], [workspace, 'fixture-thread', request.id, null]);
    return {id: 'accepted-turn', status: 'completed'};
  }, async submit() { sends++; }});
  const recovered = (await second.read(project, request.id)).operation;
  assert.equal(recovered.phase, 'completed');
  assert.equal(recovered.turnId, 'accepted-turn');
  assert.equal((await second.start(project, request)).operation.turnId, 'accepted-turn');
  assert.equal(sends, 1);
});

test('an interrupt held during gateway shutdown can be requested again for the same turn', async t => {
  const {project, workspace, open} = await fixture(t);
  const request = {id: 'request-interrupt', prompt: 'A fixture'};
  let startedInterrupt;
  const interrupted = new Promise(resolve => { startedInterrupt = resolve; });
  const first = open({async submit(input) {
    await input.beforeTurn?.();
    assert.equal(input.onThread('fixture-thread'), true);
    return {turn: {id: 'exact-turn', status: 'inProgress'}};
  }, async interrupt(_scope, _thread, _turn, beforeSend) { beforeSend(); startedInterrupt(); return new Promise(() => {}); }});
  await first.start(project, request);
  await waitForPhase(first, project, request.id, 'running');
  void first.interrupt(project, request.id);
  await interrupted;
  first.close();
  let retries = 0;
  const reopened = open({async interrupt(scope, thread, turn, beforeSend) {
    assert.deepEqual([scope, thread, turn], [workspace, 'fixture-thread', 'exact-turn']);
    beforeSend();
    retries++;
  }});
  assert.equal((await reopened.interrupt(project, request.id)).operation.phase, 'interrupting');
  assert.equal(retries, 1);
});

test('steering is tied to the current turn and a retry never sends the instructions again', async t => {
  const {project, workspace, open} = await fixture(t);
  let additions = 0;
  const operations = open({async submit(input) {
    await input.beforeTurn?.();
    assert.equal(input.onThread('current-thread'), true);
    return {turn: {id: 'current-turn', status: 'inProgress'}};
  }, async steer(input) {
    additions++;
    const {beforeSteer, beforeSend, ...details} = input;
    await beforeSteer?.();
    beforeSend?.();
    assert.deepEqual(details, {workspace, threadId: 'current-thread', turnId: 'current-turn',
      requestId: 'hq:steer:request-steer', prompt: 'An addition'});
    return 'current-turn';
  }});
  const original = {id: 'request-run', prompt: 'A fixture'};
  await operations.start(project, original);
  await waitForPhase(operations, project, original.id, 'running');
  const extra = {id: 'request-steer', operationId: original.id, prompt: 'An addition'};
  await assert.rejects(operations.steer(project, {...extra, operationId: 'different-operation'}), {status: 409});
  const first = await operations.steer(project, extra);
  assert.equal(first.steering.phase, 'accepted');
  assert.equal(first.steering.turnId, 'current-turn');
  assert.deepEqual(await operations.steer(project, extra), first);
  assert.deepEqual(await operations.readSteering(project, extra.id), first);
  await assert.rejects(operations.steer(project, {...extra, prompt: 'Changed'}), {status: 409});
  assert.equal(additions, 1);
});

test('an interrupt wins before a queued steer can send to the native turn', async t => {
  const {project, open} = await fixture(t);
  const waiting = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  let dispatched = 0;
  const operations = open({async submit(input) {
    await input.beforeTurn?.();
    assert.equal(input.onThread('fixture-thread'), true);
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }, async steer(input) {
    waiting.resolve();
    await proceed.promise;
    await input.beforeSteer?.();
    input.beforeSend?.();
    dispatched++;
    return 'fixture-turn';
  }, async interrupt(_scope, _thread, _turn, beforeSend) { beforeSend(); }});
  const original = {id: 'request-to-stop', prompt: 'A fixture'};
  await operations.start(project, original);
  await waitForPhase(operations, project, original.id, 'running');
  const steering = operations.steer(project, {id: 'queued-steering', operationId: original.id, prompt: 'A change'});
  await waiting.promise;
  assert.equal((await operations.interrupt(project, original.id)).operation.phase, 'interrupting');
  proceed.resolve();
  assert.equal((await steering).steering.phase, 'rejected');
  assert.equal(dispatched, 0);
});

test('stale running activity is unconfirmed until exact native observation', async t => {
  const {project, workspace, open, age} = await fixture(t);
  const request = {id: 'activity-stale', prompt: 'A fixture'};
  const first = open({async submit(input) {
    await input.beforeTurn?.();
    assert.equal(input.onThread('fixture-thread'), true);
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }});
  await first.start(project, request);
  await waitForPhase(first, project, request.id, 'running');
  assert.equal((await first.readActivity(project)).activity.phase, 'running');
  first.close();
  age(request.id);
  const unreachable = open({async findSubmission() { throw new Error('Unavailable'); }});
  const stale = (await unreachable.readActivity(project)).activity;
  assert.deepEqual([stale.phase, stale.observedAt, stale.terminal], ['unconfirmed', '2000-01-01T00:00:00.000Z', false]);
  unreachable.close();
  const reachable = open({async findSubmission(...args) {
    assert.deepEqual(args, [workspace, 'fixture-thread', request.id, 'fixture-turn']);
    return {id: 'fixture-turn', status: 'inProgress'};
  }});
  const confirmed = (await reachable.readActivity(project)).activity;
  assert.equal(confirmed.phase, 'running');
  assert.ok(confirmed.observedAt > stale.observedAt);
  assert.equal(confirmed.terminal, false);
  assert.deepEqual(await reachable.readActivity({...project, cwd: []}), {activity: null});
});

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Operation did not reach the expected fixture state');
}

function waitForPhase(operations, project, id, phase) {
  return until(async () => (await operations.read(project, id)).operation?.phase === phase);
}

test('cancel closes an unsent reservation and fences the native turn and resume', async t => {
  const {project, authorize, open} = await fixture(t);
  const request = {id: 'cancel-reserved', prompt: 'A fixture'};
  let admit, interrupts = 0;
  const first = open({async submit(input) { admit = input.onThread; return new Promise(() => {}); },
    async interrupt() { interrupts++; }});
  const second = open({async interrupt() { interrupts++; }});
  assert.equal((await first.start(project, request)).operation.phase, 'reserved');
  await assert.rejects(second.cancel({...project, id: 'different'}, request.id), {status: 404});
  await authorize(false);
  await assert.rejects(second.cancel(project, request.id), {status: 403});
  assert.equal((await second.read(project, request.id)).operation.phase, 'reserved');
  assert.equal((await second.read(project, request.id)).operation.cancellationRequestedAt, undefined);
  await authorize(true);
  const closed = (await second.cancel(project, request.id)).operation;
  assert.equal(closed.phase, 'cancelled');
  assert.ok(Number.isFinite(Date.parse(closed.cancellationRequestedAt)));
  assert.equal(admit('late-thread'), false);
  assert.equal((await first.start(project, request)).operation.phase, 'cancelled');
  await assert.rejects(first.start(project, {...request, id: 'cancelled-resume', resume: request.id}), {status: 409});
  assert.equal(first.hasActiveWork(project), false);
  assert.equal(interrupts, 0);
});

test('cancel waits for the exact accepted turn and never retries a claimed interrupt after restart', async t => {
  const {project, workspace, authorize, open} = await fixture(t);
  const request = {id: 'cancel-without-ack', prompt: 'A fixture'};
  let events, interrupts = 0;
  const first = open({onEvent(callback) { events = callback; }, async submit(input) {
    await input.beforeTurn?.();
    assert.equal(input.onThread('fixture-thread'), true);
    return new Promise(() => {});
  }, async interrupt(scope, thread, turn, beforeSend) {
    assert.deepEqual([scope, thread, turn], [workspace, 'fixture-thread', 'accepted-turn']);
    beforeSend();
    interrupts++;
    throw new Error('uncertain acknowledgement');
  }});
  await first.start(project, request);
  assert.equal((await first.cancel(project, request.id)).operation.phase, 'cancelling');
  events('turn/started', {threadId: 'fixture-thread', turn: {id: 'unrelated-turn', status: 'inProgress'}});
  events('item/started', {threadId: 'fixture-thread', turnId: 'unrelated-turn',
    item: {type: 'userMessage', clientId: 'other-receipt'}});
  assert.equal((await first.read(project, request.id)).operation.turnId, null);
  assert.equal(interrupts, 0);
  await authorize(false);
  events('item/completed', {threadId: 'fixture-thread', turnId: 'accepted-turn',
    item: {type: 'userMessage', clientId: request.id}});
  events('item/agentMessage/delta', {threadId: 'fixture-thread', turnId: 'accepted-turn', delta: 'Partial answer'});
  assert.equal((await first.read(project, request.id)).operation.turnId, 'accepted-turn');
  await delay(25);
  assert.equal(interrupts, 0);
  await assert.rejects(first.steer(project, {id: 'cancelled-steer', operationId: request.id, prompt: 'No'}), {status: 409});
  await authorize(true);
  const second = open({async interrupt(_scope, _thread, _turn, beforeSend) {
    beforeSend();
    interrupts++;
    throw new Error('uncertain acknowledgement');
  }});
  await Promise.all([first.read(project, request.id), second.read(project, request.id)]);
  await until(() => interrupts > 0);
  assert.equal(interrupts, 1);
  first.close();
  second.close();
  let status = 'inProgress';
  const reopened = open({async findSubmission(scope, thread, client, turn) {
    assert.deepEqual([scope, thread, client, turn], [workspace, 'fixture-thread', request.id, 'accepted-turn']);
    return {id: turn, status};
  }, async interrupt(_scope, _thread, _turn, beforeSend) { beforeSend(); interrupts++; }});
  assert.equal((await reopened.cancel(project, request.id)).operation.phase, 'cancelling');
  assert.equal(interrupts, 1);
  status = 'interrupted';
  reopened.close();
  const confirmed = open({async findSubmission() { return {id: 'accepted-turn', status}; }});
  const final = (await confirmed.read(project, request.id)).operation;
  assert.equal(final.phase, 'cancelled');
  assert.equal(final.output, 'Partial answer');
  assert.equal(Object.hasOwn(final, 'cancellationDispatchedAt'), false);
  assert.equal((await confirmed.readActivity(project)).activity.terminal, true);
  await assert.rejects(confirmed.start(project, {...request, id: 'cancelled-resume', resume: request.id}), {status: 409});
});

test('native completion wins over a pending cancellation and stale receipts cannot be cancelled', async t => {
  const {project, workspace, open} = await fixture(t);
  const request = {id: 'cancel-completing', prompt: 'A fixture'};
  let event, interrupts = 0;
  const operations = open({onEvent(callback) { event = callback; }, async submit(input) {
    await input.beforeTurn?.();
    assert.equal(input.onThread('fixture-thread'), true);
    return {turn: {id: input.requestId + '-turn', status: 'inProgress'}};
  }, async interrupt(scope, thread, turn, beforeSend) {
    assert.deepEqual([scope, thread, turn], [workspace, 'fixture-thread', request.id + '-turn']);
    beforeSend();
    interrupts++;
    event('turn/completed', {threadId: 'fixture-thread', turn: {id: request.id + '-turn', status: 'completed'}});
  }});
  await operations.start(project, request);
  await waitForPhase(operations, project, request.id, 'running');
  await operations.cancel(project, request.id);
  await until(async () => (await operations.read(project, request.id)).operation.phase === 'completed');
  assert.equal(interrupts, 1);
  const next = {...request, id: 'latest-interrupted'};
  await operations.start(project, {...next, resume: request.id});
  await waitForPhase(operations, project, next.id, 'running');
  await assert.rejects(operations.cancel(project, request.id), {status: 409});
  event('turn/completed', {threadId: 'fixture-thread', turn: {id: next.id + '-turn', status: 'interrupted'}});
  assert.equal((await operations.cancel(project, next.id)).operation.phase, 'cancelled');
  assert.equal(interrupts, 1);
  await assert.rejects(operations.start(project, {...request, id: 'old-resume-after-cancel', resume: request.id}),
    {status: 409, code: 'CODEX_RESUME_TARGET_UNAVAILABLE'});
});

test('selected thread reads and continuations remain tied to that thread and its latest receipt', async t => {
  const {project, open} = await fixture(t);
  const sent = [];
  const operations = open({async submit(input) {
    const threadId = input.knownId ?? input.requestId + '-thread';
    await input.beforeTurn?.();
    assert.equal(input.onThread(threadId), true);
    sent.push([input.requestId, input.knownId, input.previousTurnId]);
    return {turn: {id: input.requestId + '-turn', status: 'completed'}};
  }});
  await operations.start(project, {id: 'selected-first', prompt: 'A fixture'});
  await waitForPhase(operations, project, 'selected-first', 'completed');
  await operations.start(project, {id: 'separate-second', prompt: 'A separate fixture'});
  await waitForPhase(operations, project, 'separate-second', 'completed');
  assert.equal((await operations.read(project)).operation.id, 'separate-second');
  assert.equal((await operations.read(project, null, null, 'selected-first-thread')).operation.id, 'selected-first');
  assert.equal((await operations.read(project, null, null, 'external-thread')).operation, null);
  const request = {id: 'continued-first', prompt: 'Continue this thread', resume: 'selected-first'};
  await assert.rejects(operations.start(project, {...request, expectedThreadId: 'separate-second-thread'}),
    {status: 409, code: 'CODEX_RESUME_TARGET_UNAVAILABLE'});
  assert.equal(sent.length, 2);
  const exact = {...request, expectedThreadId: 'selected-first-thread'};
  await operations.start(project, exact);
  await waitForPhase(operations, project, exact.id, 'completed');
  assert.deepEqual(sent.at(-1), ['continued-first', 'selected-first-thread', 'selected-first-turn']);
  assert.equal((await operations.start(project, exact)).operation.id, 'continued-first');
  await assert.rejects(operations.start(project, {...exact, id: 'obsolete-first'}),
    {status: 409, code: 'CODEX_RESUME_TARGET_UNAVAILABLE'});
  assert.equal(sent.length, 3);
});

test('selected thread lookup recovers an unsent receipt and preserves its cancellation across restart', async t => {
  const {project, open} = await fixture(t);
  let lateSend;
  const first = open({async submit(input) {
    if (input.knownId) {
      lateSend = input.onThread;
      return new Promise(() => {});
    }
    await input.beforeTurn?.();
    assert.equal(input.onThread('fixture-thread'), true);
    return {turn: {id: 'fixture-turn', status: 'completed'}};
  }});
  const original = {id: 'thread-original', prompt: 'A fixture'};
  await first.start(project, original);
  await waitForPhase(first, project, original.id, 'completed');
  const resumed = {id: 'thread-unsent', prompt: 'Withhold this fixture', resume: original.id, expectedThreadId: 'fixture-thread'};
  await first.start(project, resumed);
  const second = open({async submit() { assert.fail('The cancelled thread cannot send'); }});
  let chosen = (await second.read(project, null, null, 'fixture-thread')).operation;
  assert.deepEqual([chosen.id, chosen.threadId, chosen.expectedThreadId, chosen.phase],
    [resumed.id, null, resumed.expectedThreadId, 'reserved']);
  await second.cancel(project, resumed.id);
  assert.equal(lateSend('fixture-thread'), false);
  chosen = (await second.read(project, null, null, 'fixture-thread')).operation;
  assert.deepEqual([chosen.id, chosen.phase], [resumed.id, 'cancelled']);
  await assert.rejects(second.start(project, {...resumed, id: 'thread-revival'}), {code: 'CODEX_RESUME_TARGET_UNAVAILABLE'});
});

test('a resumed receipt does not adopt a foreign turn from an event with its own client ID', async t => {
  const {project, open} = await fixture(t);
  let nativeEvent, interrupts = 0;
  const operations = open({
    onEvent(callback) { nativeEvent = callback; },
    async submit(input) {
      await input.beforeTurn?.();
      assert.equal(input.onThread('fixture-thread'), true);
      if (!input.knownId) return {turn: {id: 'first-turn', status: 'completed'}};
      nativeEvent('item/started', {threadId: 'fixture-thread', turnId: 'external-turn',
        item: {type: 'userMessage', clientId: input.requestId}});
      throw new Error('Could not verify the first user item');
    },
    async findSubmission(_workspace, _thread, _client, turn, verifiesOwnership) {
      assert.equal(turn, null);
      assert.equal(verifiesOwnership, true);
      return null;
    },
    async interrupt() { interrupts++; },
  });
  await operations.start(project, {id: 'thread-first-turn', prompt: 'A fixture'});
  await waitForPhase(operations, project, 'thread-first-turn', 'completed');
  const resumed = {id: 'thread-next-turn', prompt: 'Continue', resume: 'thread-first-turn', expectedThreadId: 'fixture-thread'};
  await operations.start(project, resumed);
  await until(async () => (await operations.read(project, resumed.id)).operation.phase === 'unconfirmed');
  const result = await operations.read(project, resumed.id);
  assert.equal(result.operation.phase, 'unconfirmed');
  assert.equal(result.operation.turnId, null);
  assert.equal((await operations.cancel(project, resumed.id)).operation.phase, 'cancelling');
  assert.equal(interrupts, 0);
});

test('cancel adopts an existing ordinary interrupt across connections without dispatching a second one', async t => {
  const {project, open} = await fixture(t);
  const observed = Promise.withResolvers();
  const release = Promise.withResolvers();
  let events, calls = 0;
  const ordinary = open({onEvent(callback) { events = callback; }, async submit(input) {
    await input.beforeTurn?.();
    assert.ok(input.onThread('fixture-thread'));
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }, async interrupt(_scope, _thread, _turn, beforeSend) {
    beforeSend();
    calls++;
    observed.resolve();
    await release.promise;
  }});
  const cancel = open({async interrupt() { calls++; }});
  const request = {id: 'cancel-existing-stop', prompt: 'A fixture'};
  await ordinary.start(project, request);
  await waitForPhase(ordinary, project, request.id, 'running');
  const stopping = ordinary.interrupt(project, request.id);
  await observed.promise;
  try {
    assert.equal((await cancel.cancel(project, request.id)).operation.phase, 'cancelling');
    assert.equal((await cancel.interrupt(project, request.id)).operation.phase, 'cancelling');
    events('turn/completed', {threadId: 'fixture-thread', turn: {id: 'fixture-turn', status: 'interrupted'}});
    assert.equal((await cancel.read(project, request.id)).operation.phase, 'cancelled');
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    await stopping;
  }
});

test('a transport failure before the interrupt send gate allows recovery from an exact native read', async t => {
  const {project, workspace, open} = await fixture(t);
  const request = {id: 'cancel-retry-before-send', prompt: 'A fixture'};
  const preflightFailed = Promise.withResolvers();
  const first = open({async submit(input) {
    await input.beforeTurn?.();
    assert.equal(input.onThread('fixture-thread'), true);
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }, async interrupt() {
    preflightFailed.resolve();
    throw new Error('Connection lost before the send gate');
  }});
  await first.start(project, request);
  assert.equal((await first.cancel(project, request.id)).operation.phase, 'cancelling');
  await preflightFailed.promise;
  first.close();
  let observations = 0, sends = 0, events;
  const restarted = open({onEvent(callback) { events = callback; },
    async findSubmission(...args) {
      assert.deepEqual(args, [workspace, 'fixture-thread', request.id, 'fixture-turn']);
      observations++;
      return {id: 'fixture-turn', status: 'inProgress'};
    },
    async interrupt(scope, thread, turn, beforeSend) {
      assert.deepEqual([scope, thread, turn], [workspace, 'fixture-thread', 'fixture-turn']);
      beforeSend();
      sends++;
      events('turn/completed', {threadId: thread, turn: {id: turn, status: 'interrupted'}});
    }});
  await restarted.read(project, request.id);
  await until(async () => (await restarted.read(project, request.id)).operation.phase === 'cancelled');
  assert.equal(observations, 1);
  assert.equal(sends, 1);
});

test('cancellation rechecks current workspace authorization in the wire send gate', async t => {
  const {project, authorize, open} = await fixture(t);
  const beforeScopeRead = Promise.withResolvers();
  const release = Promise.withResolvers();
  const afterGate = Promise.withResolvers();
  let sent = false;
  const operations = open({async submit(input) {
    await input.beforeTurn?.();
    assert.ok(input.onThread('fixture-thread'));
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }, async interrupt(_scope, _thread, _turn, beforeSend) {
    beforeScopeRead.resolve();
    await release.promise;
    try { beforeSend(); sent = true; }
    catch (error) { afterGate.resolve(error.status); }
    finally { afterGate.resolve(null); }
  }});
  const request = {id: 'cancel-auth-fence', prompt: 'A fixture'};
  await operations.start(project, request);
  assert.equal((await operations.cancel(project, request.id)).operation.phase, 'cancelling');
  await beforeScopeRead.promise;
  try { await authorize(false); }
  finally { release.resolve(); }
  assert.equal(await afterGate.promise, 409);
  assert.equal(sent, false);
  assert.equal((await operations.read(project, request.id)).operation.phase, 'cancelling');
});

test('a pause that fails before its wire gate leaves cancellation free to send once', async t => {
  const {project, workspace, open} = await fixture(t);
  const request = {id: 'cancel-after-unsent-pause', prompt: 'A fixture'};
  let paused = 0, reads = 0, sent = 0, events;
  const first = open({async submit(input) {
    await input.beforeTurn?.();
    assert.ok(input.onThread('fixture-thread'));
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }, async interrupt() {
    paused++;
    throw new Error('Failed before pause reached the send gate');
  }});
  await first.start(project, request);
  await waitForPhase(first, project, request.id, 'running');
  assert.equal((await first.interrupt(project, request.id)).operation.phase, 'unconfirmed');
  assert.equal(paused, 1);
  first.close();
  const second = open({onEvent(callback) { events = callback; },
    async findSubmission(...args) {
      assert.deepEqual(args, [workspace, 'fixture-thread', request.id, 'fixture-turn']);
      reads++;
      return {id: 'fixture-turn', status: 'inProgress'};
    },
    async interrupt(_scope, thread, turn, beforeSend) {
      beforeSend();
      sent++;
      events('turn/completed', {threadId: thread, turn: {id: turn, status: 'interrupted'}});
    }});
  assert.equal((await second.cancel(project, request.id)).operation.phase, 'cancelling');
  await until(async () => (await second.read(project, request.id)).operation.phase === 'cancelled');
  assert.equal(reads, 1);
  assert.equal(sent, 1);
});

test('a late pause cannot reach its wire gate after cancellation takes the receipt', async t => {
  const {project, open} = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let staleSent = false, cancelledSent = false, events;
  const pausing = open({async submit(input) {
    await input.beforeTurn?.();
    assert.ok(input.onThread('fixture-thread'));
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }, async interrupt(_scope, _thread, _turn, beforeSend) {
    entered.resolve();
    await release.promise;
    beforeSend?.();
    staleSent = true;
  }});
  const cancelling = open({onEvent(callback) { events = callback; },
    async interrupt(_scope, _thread, _turn, beforeSend) { beforeSend(); cancelledSent = true; }});
  const request = {id: 'cancel-before-pause-wire', prompt: 'A fixture'};
  await pausing.start(project, request);
  await waitForPhase(pausing, project, request.id, 'running');
  const pause = pausing.interrupt(project, request.id);
  await entered.promise;
  try {
    assert.equal((await cancelling.cancel(project, request.id)).operation.phase, 'cancelling');
    release.resolve();
    assert.equal((await pause).operation.phase, 'cancelling');
    assert.equal(staleSent, false);
    await until(() => cancelledSent);
    events('turn/completed', {threadId: 'fixture-thread', turn: {id: 'fixture-turn', status: 'interrupted'}});
    assert.equal((await cancelling.read(project, request.id)).operation.phase, 'cancelled');
  } finally { release.resolve(); }
});

test('migration treats an old unconfirmed pause with a known turn as possibly sent', async t => {
  const {project, database, open} = await fixture(t);
  const request = {id: 'cancel-legacy-pause', prompt: 'A fixture'};
  const first = open({async submit(input) {
    await input.beforeTurn?.();
    assert.ok(input.onThread('fixture-thread'));
    return {turn: {id: 'fixture-turn', status: 'inProgress'}};
  }, async interrupt() { throw new Error('Unconfirmed old pause'); }});
  await first.start(project, request);
  await waitForPhase(first, project, request.id, 'running');
  assert.equal((await first.interrupt(project, request.id)).operation.phase, 'unconfirmed');
  first.close();
  const legacy = database();
  try { legacy.exec('ALTER TABLE codex_operations DROP COLUMN interruptionDispatchedAt'); }
  finally { legacy.close(); }
  let events, sent = 0;
  const migrated = open({onEvent(callback) { events = callback; },
    async findSubmission() { return {id: 'fixture-turn', status: 'inProgress'}; },
    async interrupt(_scope, _thread, _turn, beforeSend) { beforeSend(); sent++; }});
  assert.equal((await migrated.cancel(project, request.id)).operation.phase, 'cancelling');
  assert.equal((await migrated.read(project, request.id)).operation.phase, 'cancelling');
  const preserved = database();
  try {
    const evidence = preserved.prepare('SELECT interruptionDispatchedAt, cancellationDispatchedAt FROM codex_operations WHERE id=?')
      .get(request.id);
    assert.ok(evidence.interruptionDispatchedAt);
    assert.equal(evidence.cancellationDispatchedAt, evidence.interruptionDispatchedAt);
  } finally { preserved.close(); }
  events('turn/completed', {threadId: 'fixture-thread', turn: {id: 'fixture-turn', status: 'interrupted'}});
  assert.equal((await migrated.read(project, request.id)).operation.phase, 'cancelled');
  assert.equal(sent, 0);
});
