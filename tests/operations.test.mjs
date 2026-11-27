import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createOperations} from '../app/operations.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hq-operation-test-')));
  const workspace = join(directory, 'workspaces', 'fixture');
  await mkdir(workspace, {recursive: true, mode: 0o700});
  await writeFile(join(workspace, '.hq-owned-workspace'), 'fixture\n');
  const project = {id: 'fixture', codexWrite: true, cwd: [workspace]};
  const opened = new Set();
  t.after(async () => {
    for (const entry of opened) entry.close();
    await rm(directory, {recursive: true, force: true});
  });
  return {project, workspace, open(native) {
    const operations = createOperations(directory, {canWrite: true, subscriptionReady: async () => true, ...native});
    opened.add(operations);
    return {...operations, close() { opened.delete(operations); operations.close(); }};
  }, age(id) {
    const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
    db.prepare('UPDATE codex_operations SET updatedAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z', id);
    db.close();
  }};
}

test('API-key or unknown accounts cannot start a subscription operation', async t => {
  const {project, open} = await fixture(t);
  let sends = 0;
  const operations = open({subscriptionReady: async () => false, submit: async () => { sends++; }});
  await assert.rejects(operations.start(project, {id: 'request-account', prompt: 'A fixture'}), {status: 403});
  assert.equal((await operations.read(project)).operation, null);
  assert.equal(sends, 0);
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
    assert.equal(input.onThread('fixture-thread'), true);
    return {turn: {id: 'exact-turn', status: 'inProgress'}};
  }, async interrupt() { startedInterrupt(); return new Promise(() => {}); }});
  await first.start(project, request);
  assert.equal((await first.read(project, request.id)).operation.phase, 'running');
  void first.interrupt(project, request.id);
  await interrupted;
  first.close();
  let retries = 0;
  const reopened = open({async interrupt(...args) {
    assert.deepEqual(args, [workspace, 'fixture-thread', 'exact-turn']);
    retries++;
  }});
  assert.equal((await reopened.interrupt(project, request.id)).operation.phase, 'interrupting');
  assert.equal(retries, 1);
});

test('steering is tied to the current turn and a retry never sends the instructions again', async t => {
  const {project, workspace, open} = await fixture(t);
  let additions = 0;
  const operations = open({async submit(input) {
    assert.equal(input.onThread('current-thread'), true);
    return {turn: {id: 'current-turn', status: 'inProgress'}};
  }, async steer(input) {
    additions++;
    assert.deepEqual(input, {workspace, threadId: 'current-thread', turnId: 'current-turn',
      requestId: 'hq:steer:request-steer', prompt: 'An addition'});
    return 'current-turn';
  }});
  const original = {id: 'request-run', prompt: 'A fixture'};
  await operations.start(project, original);
  assert.equal((await operations.read(project, original.id)).operation.phase, 'running');
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
