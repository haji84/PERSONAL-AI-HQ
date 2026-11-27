import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import http from 'node:http';
import test from 'node:test';
import {WebSocketServer} from 'ws';
import {createCodexClient, isCodexLoopbackUrl} from '../app/codex.mjs';

const fixtureToken = randomBytes(32).toString('base64url');
const workspace = 'C:\\Fixture\\owner';
const foreignWorkspace = 'C:\\Fixture\\other';
const fixtureThread = {id: 'exact-thread', cwd: workspace, modelProvider: 'openai'};
const fixtureTurn = {id: 'exact-turn', status: 'inProgress'};
const admitPeer = async () => {};

async function fixture(t, {accountType = 'chatgpt', redirect} = {}) {
  const server = http.createServer();
  const websocket = new WebSocketServer({noServer: true});
  const calls = [];
  const attempts = [];
  const connections = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const connection of websocket.clients) connection.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  server.on('connection', socket => {
    const connection = {serverPort: socket.localPort, clientPort: socket.remotePort, bytes: 0,
      closed: once(socket, 'close')};
    connections.push(connection);
    socket.on('data', bytes => { connection.bytes += bytes.length; });
  });
  server.on('upgrade', (request, socket, head) => {
    const authenticated = request.headers.authorization === `Bearer ${fixtureToken}`;
    attempts.push({authenticated, path: request.url});
    if (redirect) {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${redirect}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (!authenticated) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    websocket.handleUpgrade(request, socket, head, connection => {
      connection.on('message', bytes => {
        const {id, method, params} = JSON.parse(bytes);
        calls.push([method, params]);
        if (id === undefined) return;
        const results = {
          initialize: {}, 'account/read': {requiresOpenaiAuth: true, account: accountType && {type: accountType}},
          'thread/list': {data: [fixtureThread, {id: 'outside', cwd: foreignWorkspace}]},
          'thread/read': {thread: params?.threadId === 'outside' ? {id: 'outside', cwd: foreignWorkspace} : fixtureThread},
          'thread/start': {thread: fixtureThread}, 'thread/resume': {thread: fixtureThread}, 'turn/start': {turn: fixtureTurn},
          'turn/steer': {turnId: fixtureTurn.id}, 'turn/interrupt': {},
        };
        const result = results[method];
        connection.send(JSON.stringify({id, ...(result ? {result} : {error: {code: -32601}})}));
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  return {url, calls, attempts, connections, nextConnection: () => once(server, 'connection'), client(options = {}) {
    const client = createCodexClient({command: 'unavailable-fixture-command',
      loopback: {url, token: fixtureToken, verifyPeer: admitPeer}, ...options});
    clients.push(client);
    return client;
  }};
}

const request = {workspace, prompt: 'Run the fixture.', requestId: 'fixture-request', model: 'fixture-model', effort: 'low', onThread: () => true};

test('loopback rejects any noncanonical destination, unsafe token, and mixed transport synchronously', () => {
  const url = 'ws://127.0.0.1:8123';
  for (const invalidUrl of ['ws://localhost:8123', 'ws://127.1:8123', 'ws://[::1]:8123', 'ws://0.0.0.0:8123',
    'ws://127.0.0.1', 'ws://127.0.0.1:08123', 'ws://127.0.0.1:0', 'ws://127.0.0.1:65536',
    'ws://127.0.0.1:8123/rpc', 'ws://127.0.0.1:8123/?q=x', 'ws://127.0.0.1:8123/#fragment',
    'ws://user@127.0.0.1:8123', 'wss://127.0.0.1:8123', 'ws://127.0.0.1:8123\n', null, undefined]) {
    assert.equal(isCodexLoopbackUrl(invalidUrl), false);
    assert.throws(() => createCodexClient({loopback: {url: invalidUrl, token: fixtureToken, verifyPeer: admitPeer}}), {name: 'TypeError'});
  }
  assert.equal(isCodexLoopbackUrl(url), true);
  assert.equal(isCodexLoopbackUrl(url + '/'), true);
  for (const token of ['a'.repeat(42), 'a'.repeat(129), 'a'.repeat(43) + '\n', 'a'.repeat(43) + '=', 'あ'.repeat(43), null]) {
    assert.throws(() => createCodexClient({loopback: {url, token, verifyPeer: admitPeer}}), {name: 'TypeError'});
  }
  for (const loopback of [null, [], {url}, {url, token: fixtureToken}, {url, token: fixtureToken, verifyPeer: null},
    {url, token: fixtureToken, verifyPeer: admitPeer, headers: {}}, {url, token: fixtureToken, verifyPeer: admitPeer, agent: {}}]) {
    assert.throws(() => createCodexClient({loopback}), {name: 'TypeError'});
  }
  assert.throws(() => createCodexClient({socket: '/fixture/rpc.sock', loopback: {url, token: fixtureToken, verifyPeer: admitPeer}}), {name: 'TypeError'});
  assert.equal(createCodexClient({loopback: {url, token: randomBytes(32).toString('hex'), verifyPeer: admitPeer}}).canWrite, true);
});

test('authorized loopback shares initialization and preserves scope, checks, and sandbox inputs', async t => {
  const {attempts, calls, client, url} = await fixture(t);
  const loopback = {url: url + '/', token: fixtureToken, verifyPeer: admitPeer};
  const native = client({loopback});
  loopback.url = 'ws://127.0.0.1:0';
  loopback.token = 'changed-after-construction';
  loopback.verifyPeer = null;
  assert.equal(native.canWrite, true);
  const [ready, listed] = await Promise.all([native.subscriptionReady(), native.listThreads([workspace])]);
  assert.equal(ready, true);
  assert.deepEqual(listed.data.map(row => row.id), [fixtureThread.id]);
  assert.deepEqual(attempts, [{authenticated: true, path: '/'}]);
  assert.equal(calls.filter(([method]) => method === 'initialize').length, 1);
  assert.equal(calls.filter(([method]) => method === 'initialized').length, 1);
  await assert.rejects(native.submit({...request, knownId: 'outside'}), {status: 404});
  await assert.rejects(native.submit({...request, beforeThread: () => false}), {status: 503});
  assert.equal(calls.some(([method]) => method === 'thread/start' || method === 'thread/resume'), false);
  await assert.rejects(native.submit({...request, onThread: () => false}), {status: 503});
  assert.equal(calls.some(([method]) => method === 'turn/start'), false);
  assert.deepEqual(await native.submit({...request, knownId: fixtureThread.id}), {threadId: fixtureThread.id, turn: fixtureTurn});
  const [, turn] = calls.find(([method]) => method === 'turn/start');
  assert.equal(turn.threadId, fixtureThread.id);
  assert.equal(turn.clientUserMessageId, request.requestId);
  assert.equal(turn.model, request.model);
  assert.equal(turn.effort, request.effort);
  assert.equal(turn.approvalPolicy, 'never');
  assert.deepEqual(turn.sandboxPolicy, {type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true});
  assert.deepEqual(turn.input, [{type: 'text', text: request.prompt, text_elements: []}]);
  await assert.rejects(native.interrupt(workspace, 'outside'), {status: 404});
  const held = new Error('Cancellation claim was declined');
  await assert.rejects(native.interrupt(workspace, fixtureThread.id, fixtureTurn.id, () => { throw held; }), error => error === held);
  assert.equal(calls.some(([method]) => method === 'turn/interrupt'), false);
  let claimed = false;
  await native.interrupt(workspace, fixtureThread.id, fixtureTurn.id, () => {
    assert.equal(calls.at(-1)?.[0], 'thread/read');
    claimed = true;
  });
  assert.equal(claimed, true);
  assert.deepEqual(calls.filter(([method]) => method === 'turn/interrupt'), [
    ['turn/interrupt', {threadId: fixtureThread.id, turnId: fixtureTurn.id}],
  ]);
  assert.equal(await native.steer({workspace, threadId: fixtureThread.id, turnId: fixtureTurn.id,
    prompt: 'Add one instruction.', requestId: 'fixture-steering'}), fixtureTurn.id);
});

test('a denied handshake, redirect, or logged-out account never starts a writable connection elsewhere', async t => {
  const receiver = await fixture(t);
  const wrongToken = randomBytes(32).toString('base64url');
  const wrong = receiver.client({loopback: {url: receiver.url, token: wrongToken, verifyPeer: admitPeer}});
  await assert.rejects(wrong.subscriptionReady(), error => error.status === 503 &&
    !error.message.includes(fixtureToken) && !error.message.includes(wrongToken));
  assert.deepEqual(receiver.attempts, [{authenticated: false, path: '/'}]);
  assert.deepEqual(receiver.calls, []);

  const redirector = await fixture(t, {redirect: receiver.url + '/'});
  await assert.rejects(redirector.client().subscriptionReady(), {status: 503});
  assert.deepEqual(redirector.attempts, [{authenticated: true, path: '/'}]);
  assert.equal(receiver.attempts.length, 1);
  assert.deepEqual(redirector.calls, []);

  const loggedOut = await fixture(t, {accountType: null});
  const native = loggedOut.client();
  assert.equal(await native.subscriptionReady(), false);
  await assert.rejects(native.submit(request), {status: 503});
  assert.equal(loggedOut.calls.some(([method]) => method === 'thread/start' || method === 'turn/start'), false);

  const stdio = createCodexClient({command: 'unavailable-fixture-command'});
  assert.equal(stdio.canWrite, false);
  assert.equal(await stdio.subscriptionReady(), false);
  await assert.rejects(stdio.submit(request), {status: 503});
});

test('peer verification runs for each physical connection before any HTTP bytes are sent', {timeout: 3000}, async t => {
  const receiver = await fixture(t);
  const peers = [];
  const firstCheck = Promise.withResolvers();
  const firstApproved = Promise.withResolvers();
  const verifyPeer = async peer => {
    peers.push(peer);
    if (peers.length === 1) {
      firstCheck.resolve();
      await firstApproved.promise;
    } else throw new Error('private identity mismatch');
  };
  const native = receiver.client({loopback: {url: receiver.url, token: fixtureToken, verifyPeer}});
  const firstAccepted = receiver.nextConnection();
  const initial = native.subscriptionReady();
  await Promise.all([firstCheck.promise, firstAccepted]);
  assert.equal(receiver.connections[0].bytes, 0);
  assert.deepEqual(receiver.attempts, []);
  firstApproved.resolve();
  assert.equal(await initial, true);
  assert.equal(receiver.attempts.length, 1);
  native.close();
  await receiver.connections[0].closed;

  const acceptedAgain = receiver.nextConnection();
  await assert.rejects(native.subscriptionReady(), error => error.status === 503 && !error.message.includes('private identity mismatch'));
  await acceptedAgain;
  await receiver.connections[1].closed;
  assert.deepEqual(peers, receiver.connections.map(({serverPort, clientPort}) => ({serverPort, clientPort})));
  assert.equal(receiver.attempts.length, 1);
  assert.equal(receiver.connections[1].bytes, 0);
});

test('closing during peer verification discards the socket even if verification later resolves', async t => {
  const receiver = await fixture(t);
  const checkStarted = Promise.withResolvers();
  const approved = Promise.withResolvers();
  const native = receiver.client({loopback: {url: receiver.url, token: fixtureToken, async verifyPeer() {
    checkStarted.resolve();
    await approved.promise;
  }}});
  const accepted = receiver.nextConnection();
  const rejected = assert.rejects(native.subscriptionReady(), {status: 503});
  await Promise.all([checkStarted.promise, accepted]);
  native.close();
  await rejected;
  await receiver.connections[0].closed;
  approved.resolve();
  assert.equal(receiver.connections[0].bytes, 0);
  assert.equal(receiver.attempts.length, 0);
});

test('peer verification must complete with no return value before the connection deadline', {timeout: 7500}, async t => {
  const receiver = await fixture(t);
  for (const verifyPeer of [() => {}, async () => true, async () => new Promise(() => {})]) {
    const native = receiver.client({loopback: {url: receiver.url, token: fixtureToken, verifyPeer}});
    const accepted = receiver.nextConnection();
    await assert.rejects(native.subscriptionReady(), {status: 503});
    await accepted;
    const connection = receiver.connections.at(-1);
    await connection.closed;
    assert.equal(connection.bytes, 0);
  }
  assert.deepEqual(receiver.attempts, []);
});

test('a failed TCP connection never calls peer verification', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  let checks = 0;
  const native = createCodexClient({command: 'unavailable-fixture-command', loopback: {url, token: fixtureToken,
    async verifyPeer() { checks++; }}});
  try {
    await assert.rejects(native.subscriptionReady(), {status: 503});
    assert.equal(checks, 0);
  } finally { native.close(); }
});

test('loopback credentials use an explicit direct agent even with a Node global proxy',
  {skip: typeof http.setGlobalProxyFromEnv !== 'function'}, async t => {
    let proxyRequests = 0;
    const proxy = http.createServer((_request, response) => { proxyRequests++; response.writeHead(403).end(); });
    for (const event of ['connect', 'upgrade']) proxy.on(event, (_request, socket) => { proxyRequests++; socket.destroy(); });
    proxy.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => proxy.close(resolve)));
    await once(proxy, 'listening');
    const direct = await fixture(t);
    const restore = http.setGlobalProxyFromEnv({HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`});
    try {
      assert.equal(await direct.client().subscriptionReady(), true);
      assert.equal(proxyRequests, 0);
      assert.deepEqual(direct.attempts, [{authenticated: true, path: '/'}]);
    } finally { restore(); }
  });
