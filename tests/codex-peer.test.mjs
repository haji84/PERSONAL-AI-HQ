import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createConnection, createServer} from 'node:net';
import {join} from 'node:path';
import test from 'node:test';
import {createCodexPeerVerifier} from '../app/codex-peer.mjs';

const supported = ['darwin', 'win32'].includes(process.platform);

test('the established loopback peer must use the expected owner executable', {skip: !supported}, async t => {
  const server = createServer();
  const sockets = [];
  server.on('connection', socket => sockets.push(socket));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const client = createConnection({host: '127.0.0.1', port: serverPort});
  sockets.push(client);
  await once(client, 'connect');
  const address = {serverPort, clientPort: client.localPort};
  const correct = await createCodexPeerVerifier(process.execPath);
  await correct(address);
  const different = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'netstat.exe') : '/usr/bin/true';
  const wrong = await createCodexPeerVerifier(different);
  await assert.rejects(wrong(address), /ローカル接続を確認できません/);
  await assert.rejects(correct({serverPort, clientPort: serverPort}), /ローカル接続を確認できません/);
});
