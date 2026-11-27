import {strict as assert} from 'node:assert';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {startOwnerApp} from '../app/server.mjs';
import {createCodexClient} from '../app/codex.mjs';

// Run explicitly on an owner-signed-in Mac. It uses a new, isolated workspace and native account usage.
assert.equal(process.platform, 'darwin');
const directory = await mkdtemp('/private/tmp/hq-native-proof.');
const workspace = join(directory, 'workspaces', 'app-proof');
const socket = join(directory, 'codex.sock');
await mkdir(workspace, {recursive: true, mode: 0o700});
await writeFile(join(workspace, '.hq-owned-workspace'), 'app-proof\n', {mode: 0o600});
await writeFile(join(workspace, 'README.md'), '# Isolated owner-authorized integration verification\n', {mode: 0o600});
execFileSync('git', ['init', '-q', workspace], {stdio: 'ignore'});
await writeFile(join(directory, 'portfolio.json'), JSON.stringify({observedAt: new Date(), projects: [
  {id: 'app-proof', name: '分離した実行検証', cwd: workspace, enableCodexWrite: true},
]}), {mode: 0o600});
const command = process.env.HQ_CODEX_BIN ?? '/opt/homebrew/bin/codex';
const daemon = spawn(command, ['app-server', '--listen', `unix://${socket}`], {stdio: 'ignore', cwd: workspace});
const exited = once(daemon, 'exit');
let app, cookie;
const operationPath = '/api/codex/run?project=app-proof';

async function openApp() {
  app = await startOwnerApp({directory, socket, port: 0});
  const ownerFile = await readFile(app.signInFile, 'utf8');
  const key = /name="key" value="([a-f0-9]{64})"/.exec(ownerFile)?.[1];
  assert.ok(key);
  const response = await fetch(app.url + '/api/session', {method: 'POST', redirect: 'manual', headers: {Origin: 'null'},
    body: new URLSearchParams({key})});
  assert.equal(response.status, 303);
  cookie = response.headers.get('set-cookie').split(';')[0];
}

async function call(path, data) {
  const headers = {cookie, ...(data ? {Origin: app.url, 'Content-Type': 'application/json'} : {})};
  const response = await fetch(app.url + path, {method: data ? 'POST' : 'GET', headers,
    ...(data ? {body: JSON.stringify(data)} : {})});
  const value = await response.json();
  if (!response.ok) throw new Error(`${path.split('?')[0]} ${response.status} ${value.error ?? ''}`);
  return value;
}

async function observe(id, states, limit) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const {operation} = await call(operationPath + '&id=' + id);
    if (operation && states.includes(operation.phase)) return operation;
    if (operation && ['failed', 'unconfirmed', 'completed', 'interrupted'].includes(operation.phase)) {
      throw new Error(`Unexpected operation state ${operation.phase}`);
    }
    await wait(1200);
  }
  throw new Error('Timed out waiting for ' + states.join(','));
}

let keepDiagnostics = false;
try {
  const ready = Date.now() + 8000;
  while (!(await stat(socket).catch(() => null))?.isSocket()) {
    assert.ok(Date.now() < ready && daemon.exitCode === null, 'Native socket did not become ready');
    await wait(120);
  }
  await openApp();
  assert.equal((await call('/api/session')).capabilities.codexWrite, true);
  const id = randomUUID();
  const instructions = 'This is a controlled Personal AI HQ integration check. In this workspace only, create proof.txt with exactly the single line HQ_NATIVE_WRITE_OK followed by a newline, then wait for 12 seconds using the shell sleep command before the final response. If a separate instruction arrives during this turn, also perform that instruction in this workspace. Do not contact the network or delegate. Reply HQ_NATIVE_RESPONSE_OK and stop.';
  const data = {id, prompt: instructions, stage: 'test', route: 'subscription'};
  const [first, duplicate] = await Promise.all([call(operationPath, data), call(operationPath, data)]);
  assert.equal(first.operation.id, duplicate.operation.id);
  assert.equal(first.operation.stage, 'test');
  assert.equal(first.operation.explicitRoute, 'subscription');
  const running = await observe(id, ['running'], 45000);
  const steeringId = randomUUID();
  const newInstruction = {id: steeringId, operationId: id,
    prompt: 'For the same integration check, also create steered.txt with exactly the single line HQ_NATIVE_STEER_OK followed by a newline. Keep proof.txt and do not access the network.'};
  const {steering} = await call('/api/codex/steer?project=app-proof', newInstruction);
  assert.equal(steering.phase, 'accepted');
  assert.equal(steering.turnId, running.turnId);
  assert.equal((await call('/api/codex/steer?project=app-proof', newInstruction)).steering.updatedAt, steering.updatedAt);
  await app.close();
  app = undefined;
  await openApp();
  const complete = await observe(id, ['completed'], 55000);
  assert.equal(complete.threadId, running.threadId);
  assert.equal(complete.turnId, running.turnId);
  assert.equal(daemon.exitCode, null);
  const history = createCodexClient({socket: await realpath(socket)});
  try {
    const reconciled = await history.findSubmission(workspace, complete.threadId, id, null);
    assert.equal(reconciled?.id, complete.turnId, 'Native history did not preserve the exact client request ID');
    assert.equal(reconciled.status, 'completed');
    assert.equal(await history.hasTurnMessage(workspace, complete.threadId, complete.turnId, `hq:steer:${steeringId}`), true,
      'Native item history did not preserve the steering request');
  } finally { history.close(); }
  const written = await readFile(join(workspace, 'proof.txt'));
  assert.equal(written.toString(), 'HQ_NATIVE_WRITE_OK\n');
  assert.equal(await readFile(join(workspace, 'steered.txt'), 'utf8'), 'HQ_NATIVE_STEER_OK\n');
  console.log(JSON.stringify({stage: 'write', completed: complete.phase, duplicateSameId: true,
    scopedWorkStageAndRouteApplied: true,
    gatewayRestart: true, continuedThroughRestart: true, nativeHistoryClientIdMatched: true,
    sameTurnSteerAccepted: true, duplicateSteerSuppressed: true, steeredArtifactVerified: true,
    verifiedOutputSha256: createHash('sha256').update(written).digest('hex')}));

  const stopId = randomUUID();
  await call(operationPath, {id: stopId, prompt: 'This is a controlled interrupt test only. Run the harmless command sleep 35 in the current workspace immediately. Do not create any files. After the wait reply HQ_WAIT_DONE. Do not do other work.'});
  const stoppable = await observe(stopId, ['running'], 45000);
  await call('/api/codex/interrupt?project=app-proof', {id: stopId});
  const stopped = await observe(stopId, ['interrupted'], 45000);
  const resumeId = randomUUID();
  await call(operationPath, {id: resumeId, resume: stopId, prompt: 'Ignore the earlier wait. In this same test workspace, create resume.txt containing exactly the single line HQ_NATIVE_RESUME_OK followed by a newline. Do not contact the network or delegate. Reply HQ_RESUMED and finish.'});
  const resumed = await observe(resumeId, ['completed'], 65000);
  assert.equal(await readFile(join(workspace, 'resume.txt'), 'utf8'), 'HQ_NATIVE_RESUME_OK\n');
  assert.equal(resumed.threadId, stopped.threadId);
  assert.notEqual(resumed.turnId, stoppable.turnId);
  console.log(JSON.stringify({stage: 'interrupt-resume', nativeInterrupted: stopped.phase, actualResumed: resumed.phase,
    sameThread: true, differentTurn: true, resumeArtifactVerified: true}));
} catch (error) {
  keepDiagnostics = true;
  console.error(error.message);
  if (app && cookie) {
    try {
      const {operation} = await call(operationPath);
      console.log(JSON.stringify({state: operation?.phase ?? null, hasThread: !!operation?.threadId, hasTurn: !!operation?.turnId}));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  await app?.close();
  if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await Promise.race([exited, wait(3500)]); }
  if (!keepDiagnostics) await rm(directory, {recursive: true, force: true});
  else console.log(JSON.stringify({privateDiagnosticDirectory: directory}));
}
