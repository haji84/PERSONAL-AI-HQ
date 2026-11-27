import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import test from 'node:test';
import {WebSocketServer} from 'ws';
import {createCodexClient} from '../app/codex.mjs';

test('native usage reads only the Codex windows and explicit permission', {skip: process.platform === 'win32'}, async t => {
  const directory = await mkdtemp('/tmp/hq-codex-usage-');
  const socket = join(directory, 'rpc.sock');
  const server = createServer();
  const websocket = new WebSocketServer({server});
  const native = createCodexClient({socket});
  t.after(async () => {
    native.close();
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  });
  const reads = [];
  const accountTypes = ['apiKey', 'chatgpt', 'chatgpt', 'chatgpt'];
  const limit = {usedPercent: 24, windowDurationMins: 300, resetsAt: 1893456000};
  const snapshots = [{
    accountId: 'private-account',
    ordinaryUsageAllowed: false,
    rateLimits: {limitId: 'elsewhere', limitName: 'private-name', primary: {usedPercent: 99}},
    rateLimitsByLimitId: {codex: {primary: limit, secondary: {usedPercent: 100},
      credits: {balance: 'private-balance'}}},
    rateLimitResetCredits: {availableCount: 123},
  }, {
    ordinaryUsageAllowed: 'true',
    rateLimits: {primary: limit, secondary: {usedPercent: '100'}},
  }];
  websocket.on('connection', connection => {
    connection.on('message', bytes => {
      const request = JSON.parse(bytes);
      if (!Object.hasOwn(request, 'id')) return;
      if (request.method === 'initialize') return connection.send(JSON.stringify({id: request.id, result: {}}));
      reads.push([request.method, request.params]);
      if (request.method === 'account/read') return connection.send(JSON.stringify({id: request.id, result: {
        requiresOpenaiAuth: true, account: {type: accountTypes.shift()},
      }}));
      const result = snapshots.shift();
      connection.send(JSON.stringify(result ? {id: request.id, result} : {id: request.id, error: {message: 'private-error'}}));
    });
  });
  server.listen(socket);
  await once(server, 'listening');
  assert.deepEqual(await native.usage(), {observedAt: null, ordinaryUsageAllowed: null, windows: []});
  const first = await native.usage();
  assert.equal(new Date(first.observedAt).toISOString(), first.observedAt);
  const primary = {label: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: '2030-01-01T00:00:00.000Z'};
  assert.deepEqual(first, {observedAt: first.observedAt, ordinaryUsageAllowed: false, windows: [
    primary, {label: 'secondary', usedPercent: 100, durationMinutes: null, resetsAt: null},
  ]});
  const legacy = await native.usage();
  assert.deepEqual(legacy, {observedAt: legacy.observedAt, ordinaryUsageAllowed: null, windows: [primary]});
  assert.deepEqual(await native.usage(), {observedAt: null, ordinaryUsageAllowed: null, windows: []});
  const accountRead = ['account/read', {refreshToken: false}];
  const usageRead = ['account/rateLimits/read', {excludeResetCreditDetails: true}];
  assert.deepEqual(reads, [accountRead, accountRead, usageRead, accountRead, usageRead, accountRead, usageRead]);
});
