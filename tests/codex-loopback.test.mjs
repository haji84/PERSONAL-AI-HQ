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
const fixtureThread = {id: '018f1cd1-6658-7fc4-bcc4-13fbdd3555a1', cwd: workspace, modelProvider: 'openai',
  status: {type: 'idle'}, ephemeral: false};
const fixtureTurn = {id: 'exact-turn', status: 'inProgress'};
const priorTurn = {id: 'completed-turn', status: 'completed'};
const admitPeer = async () => {};

async function fixture(t, {accountType = 'chatgpt', redirect, thread = fixtureThread, turn = priorTurn, resumed = thread,
  firstUser = 'fixture-request', rpcResults = {}} = {}) {
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
      let experimental = false;
      connection.on('message', bytes => {
        const {id, method, params} = JSON.parse(bytes);
        calls.push([method, params]);
        if (id === undefined) return;
        if (method === 'initialize') experimental = params.capabilities?.experimentalApi === true;
        const results = {
          initialize: {}, 'account/read': {requiresOpenaiAuth: true, account: accountType && {type: accountType}},
          'thread/list': {data: [fixtureThread, {id: 'outside', cwd: foreignWorkspace}]},
          'thread/read': {thread: params?.threadId === 'outside' ? {id: 'outside', cwd: foreignWorkspace} : thread},
          'thread/start': {thread}, 'thread/resume': {thread: resumed}, 'turn/start': {turn: fixtureTurn},
          'thread/turns/list': {data: turn ? [turn] : []},
          'thread/items/list': {data: [{turnId: params?.turnId, item: {type: 'userMessage', clientId: firstUser}}]},
          'turn/steer': {turnId: fixtureTurn.id}, 'turn/interrupt': {},
        };
        const result = rpcResults[method] ? rpcResults[method](params, {experimental}) : results[method];
        if (result === 'hold') return;
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

test('Codex history search resumes into older visible messages without reading a foreign thread', async t => {
  const scoped = {...fixtureThread, name: 'First conversation'};
  const foreign = {...fixtureThread, id: 'outside', cwd: foreignWorkspace};
  const {client, calls} = await fixture(t, {rpcResults: {
    'thread/list': ({cwd, cursor, limit}) => {
      assert.deepEqual(cwd, [workspace]);
      assert.equal(limit, 1);
      return cursor ? {data: [foreign], nextCursor: null} : {data: [scoped], nextCursor: 'outside-page'};
    },
    'thread/read': ({threadId}) => ({thread: threadId === scoped.id ? scoped : foreign}),
    'thread/turns/list': ({threadId, cursor}) => {
      assert.equal(threadId, scoped.id);
      const page = cursor === null ? 0 : Number(cursor);
      return {data: [{id: 'turn-' + page, items: page === 7
        ? [{type:'userMessage',content:[{type:'text',text:'release CHECKPOINT note'}]}]
        : [{type:'reasoning',summary:['private checkpoint']}, {type:'agentMessage',text:'Ordinary update'}]}],
      nextCursor: page === 7 ? null : String(page + 1)};
    },
  }});
  const native = client();
  const recent = await native.searchHistory([workspace], 'checkpoint', null);
  assert.deepEqual(recent.matches, []);
  assert.ok(recent.nextCursor);
  assert.equal(calls.filter(([method]) => method === 'thread/turns/list').length, 6);
  const older = await native.searchHistory([workspace], 'checkpoint', recent.nextCursor);
  assert.equal(older.nextCursor, null);
  assert.deepEqual(older.matches, [{id:scoped.id,title:scoped.name,updatedAt:null,turnId:'turn-7',turnCursor:'7'}]);
  assert.ok(calls.filter(([method]) => method === 'thread/list').every(([, params]) => params.useStateDbOnly === true));
  assert.ok(!calls.some(([, params]) => params?.threadId === foreign.id));
  assert.ok(calls.every(([method]) => ['initialize','initialized','thread/list','thread/read','thread/turns/list'].includes(method)));
});

test('native activity reports only scoped live flags and verified exact turn transitions', async t => {
  const active = (id, activeFlags = [], extra = {}) => ({id, cwd: workspace, preview: 'private prompt',
    status: {type: 'active', activeFlags}, ...extra});
  const completedAt = 1760000000;
  const rows = [
    active('parent', ['waitingOnApproval'], {name: 'Parent'}),
    active('child', ['waitingOnApproval', 'waitingOnUserInput'], {source: {subagent: 'review'},
      agentRole: 'reviewer', path: '/private/history'}),
    active('managed', ['waitingOnUserInput']),
    active('other-child', [], {parentThreadId: 'parent'}),
    active('outside', [], {cwd: foreignWorkspace}),
    active('future-active', ['waitingOnFutureCondition']),
    {id: 'missing-flags', cwd: workspace, status: {type: 'active'}},
    {id: 'unknown', cwd: workspace, status: {type: 'notLoaded'}},
    {id: 'idle', cwd: workspace, status: {type: 'idle'}},
    {id: 'finished', cwd: workspace, status: {type: 'idle'}},
    {id: 'advanced', cwd: workspace, status: {type: 'idle'}},
  ];
  const {client, calls} = await fixture(t, {rpcResults: {
    'thread/list': () => ({data: rows, nextCursor: 'another-page'}),
    'thread/read': ({threadId}) => ({thread: rows.find(row => row.id === threadId) ?? {id: threadId, cwd: workspace}}),
    'thread/turns/list': ({threadId}) => ({data: [
      threadId === 'finished' ? {id: 'prior-turn', status: 'completed', completedAt} :
      threadId === 'advanced' ? {id: 'different-turn', status: 'interrupted'} :
      {id: threadId + '-current', status: 'inProgress'},
    ]}),
  }});
  const result = await client().readActivity([workspace], [
    {threadId: 'finished', turnId: 'prior-turn'}, {threadId: 'advanced', turnId: 'prior-turn'},
    {threadId: 'managed', turnId: 'managed-current'},
  ], {isManaged: id => id === 'managed'});
  assert.equal(result.status, 'observed');
  assert.equal(result.truncated, true);
  assert.equal(result.unconfirmed, 3);
  assert.deepEqual(result.live.map(({id, phase, subagent, role, turnId}) => ({id, phase, subagent, role, turnId})), [
    {id: 'parent', phase: 'approval', subagent: false, role: undefined, turnId: 'parent-current'},
    {id: 'child', phase: 'approval-and-input', subagent: true, role: 'reviewer', turnId: 'child-current'},
    {id: 'managed', phase: 'input', subagent: false, role: undefined, turnId: undefined},
    {id: 'other-child', phase: 'running', subagent: true, role: undefined, turnId: 'other-child-current'},
  ]);
  assert.deepEqual(result.transitions, [{id: 'finished', title: 'Codexセッション', turnId: 'prior-turn',
    phase: 'completed', endedAt: new Date(completedAt * 1000).toISOString()}]);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(calls.find(([method]) => method === 'thread/list')[1].useStateDbOnly, true);
  assert.ok(calls.filter(([method]) => method === 'thread/turns/list')
    .every(([, params]) => params.itemsView === 'notLoaded' && params.limit === 1 && params.sortDirection === 'desc'));
  assert.ok(!calls.some(([method, params]) => method.startsWith('thread/') && ['outside', 'managed'].includes(params.threadId)));
  const foreign = await client().readActivity([workspace], [
    {threadId: 'outside', turnId: 'prior-turn'}, {threadId: 'not-in-page', turnId: 'prior-turn'},
  ]);
  assert.deepEqual(foreign.transitions, []);
  assert.ok(!calls.some(([method, params]) => method.startsWith('thread/') &&
    ['outside', 'not-in-page'].includes(params.threadId)));
});

test('a terminal watch supersedes an earlier active snapshot and shares the latest-turn read', async t => {
  const activity = {id: 'watched-thread', cwd: workspace, status: {type: 'active', activeFlags: []}};
  let resolvedScope = workspace;
  const {client, calls} = await fixture(t, {rpcResults: {
    'thread/list': () => ({data: [activity]}),
    'thread/read': () => ({thread: {...activity, cwd: resolvedScope, status: {type: 'idle'}}}),
    'thread/turns/list': () => ({data: [{id: 'watched-turn', status: 'failed', completedAt: 1760000000}]}),
  }});
  const native = client();
  const watch = [{threadId: 'watched-thread', turnId: 'watched-turn'}];
  const result = await native.readActivity([workspace], watch);
  assert.deepEqual(result.live, []);
  assert.equal(result.transitions[0].phase, 'failed');
  assert.equal(result.transitions[0].turnId, 'watched-turn');
  assert.equal(calls.filter(([method]) => method === 'thread/turns/list').length, 1);
  resolvedScope = foreignWorkspace;
  const moved = await native.readActivity([workspace], watch);
  assert.deepEqual([moved.live, moved.transitions, moved.unconfirmed], [[], [], 1]);
  assert.equal(calls.filter(([method]) => method === 'thread/turns/list').length, 1);
});

test('native activity aborts a held list before starting turn reads and leaves the connection usable', async t => {
  let held;
  const {client, calls} = await fixture(t, {rpcResults: {
    'thread/list': () => { held?.(); return held ? 'hold' : {data: []}; },
  }});
  const received = new Promise(resolve => { held = resolve; });
  const signal = new AbortController();
  const native = client();
  const result = native.readActivity([workspace], [{threadId: 'finished', turnId: 'prior-turn'}], {signal: signal.signal});
  await received;
  signal.abort();
  await assert.rejects(result, {name: 'AbortError'});
  held = undefined;
  assert.equal((await native.readActivity([workspace], [])).status, 'observed');
  assert.deepEqual(calls.map(([method]) => method), ['initialize', 'initialized', 'thread/list', 'thread/list']);
  const stdio = createCodexClient({command: 'unavailable-fixture-command'});
  assert.equal((await stdio.readActivity([workspace], [])).status, 'unconfigured');
});

const request = {workspace, prompt: 'Run the fixture.', requestId: 'fixture-request', model: 'fixture-model', effort: 'low', onThread: () => true};

test('turn evidence returns bounded exact command and workspace file metadata', async t => {
  const turnId = 'evidence-turn';
  const entry = (id, fields) => ({turnId, item: {id, status: 'completed', ...fields}});
  const run = {type: 'commandExecution', cwd: workspace, command: 'npm test', exitCode: 0, durationMs: 34};
  const {client, calls, connections} = await fixture(t, {rpcResults: {
    'thread/items/list': ({cursor}, {experimental}) => {
      if (!experimental) return null;
      if (cursor) return {data: [{...entry('foreign', run), turnId: 'different-turn'}], nextCursor: null};
      return {data: [
        entry('inline', {...run, aggregatedOutput: '\x1b[31mPASS\x1b[0m'}),
        entry('sensitive', {...run, command: 'printenv', aggregatedOutput: 'private-value'}),
        entry('token-output', {...run, aggregatedOutput: 'OPENAI_API_KEY=private-value'}),
        {...entry('deferred', run), outputDeferred: true},
        entry('tool', {type: 'mcpToolCall', arguments: 'private tool payload'}),
        entry('moderated', {...run, aggregatedOutput: 'private moderated output', moderation: {moderated: true}}),
        entry('bounded', {...run, aggregatedOutput: 'a'.repeat(7000)}),
        entry('outside-cwd', {...run, cwd: workspace + '-sibling', aggregatedOutput: 'foreign data'}),
        entry('outside-read', {...run, command: 'cat input.txt', aggregatedOutput: 'outside content',
          commandActions: [{type: 'read', path: foreignWorkspace + '\\input.txt'}]}),
        entry('changes', {type: 'fileChange', changes: [
          {path: workspace + '\\old.txt', kind: {type: 'update', move_path: workspace + '\\new.txt'}, diff: 'private diff'},
          {path: workspace + '-sibling\\private.txt', kind: {type: 'add'}},
          {path: '..\\private.txt', kind: {type: 'delete'}},
        ]}),
        entry('outside-changes', {type: 'fileChange', changes: [{path: '..\\outside.txt', kind: {type: 'delete'}}]}),
      ], nextCursor: 'native-cursor'};
    },
    'thread/items/read': ({itemIds: [id]}, {experimental}) => experimental ? {data: [id === 'deferred' ?
      entry(id, {...run, aggregatedOutput: 'later output'}) : entry('different-id', run)]} : null,
  }});
  const native = client();
  assert.equal((await native.readThread([workspace], fixtureThread.id)).thread.id, fixtureThread.id);
  await assert.rejects(native.readTurnEvidence([foreignWorkspace], fixtureThread.id, turnId, {}), {status: 404});
  assert.ok(!calls.some(([method]) => method.startsWith('thread/items')));
  const page = await native.readTurnEvidence([workspace], fixtureThread.id, turnId, {});
  assert.equal(page.threadId, fixtureThread.id);
  assert.equal(page.turnId, turnId);
  assert.equal(page.nextCursor, 'native-cursor');
  assert.deepEqual(page.entries.map(item => [item.id, item.outputState]), [
    ['inline', 'visible'], ['sensitive', 'hidden'], ['token-output', 'hidden'], ['deferred', 'deferred'],
    ['bounded', 'visible'], ['outside-cwd', 'hidden'], ['outside-read', 'hidden'], ['changes', undefined],
  ]);
  assert.deepEqual(page.entries[0], {id: 'inline', type: 'command', status: 'completed', cwd: '.', command: 'npm test',
    exitCode: 0, durationMs: 34, outputState: 'visible', output: 'PASS'});
  assert.equal(page.entries[1].exitCode, 0);
  assert.equal(page.entries[1].command, undefined);
  assert.equal(page.entries.find(item => item.id === 'bounded').output.length, 6000);
  assert.equal(page.entries.find(item => item.id === 'bounded').truncated, true);
  assert.deepEqual(page.entries.at(-1).changes, [{path: 'new.txt', from: 'old.txt', kind: 'update'}]);
  assert.ok(!JSON.stringify(page).match(/private|foreign data|outside content|Fixture/i));
  assert.equal((await native.readTurnEvidence([workspace], fixtureThread.id, turnId, {item: 'deferred'})).entry.output, 'later output');
  assert.equal(connections.length, 4);
  await Promise.all(connections.slice(1).map(connection => connection.closed));
  assert.equal((await native.readThread([workspace], fixtureThread.id)).thread.id, fixtureThread.id);
  assert.equal(connections.length, 4);
  const negotiated = {experimentalApi: true, requestAttestation: false};
  assert.deepEqual(calls.filter(([method]) => method === 'initialize').map(([, params]) => params.capabilities),
    [undefined, negotiated, negotiated, negotiated]);
  assert.ok(calls.some(([method, params]) => method === 'thread/items/read' && params.turnId === turnId &&
    params.threadId === fixtureThread.id && params.itemIds.length === 1 && params.itemIds[0] === 'deferred'));
  await assert.rejects(native.readTurnEvidence([workspace], fixtureThread.id, turnId, {item: 'wrong-id'}), {status: 404});
  await assert.rejects(native.readTurnEvidence([workspace], fixtureThread.id, turnId, {cursor: 'native-cursor'}), {status: 503});
});

test('even an authorized native cwd move during the evidence read invalidates that result', async t => {
  for (const item of [undefined, 'changed-item']) {
    let reads = 0;
    const entry = {turnId: 'changed-turn', item: {id: 'changed-item', status: 'completed', type: 'commandExecution',
      cwd: workspace, command: 'npm test', aggregatedOutput: 'initial workspace output'}};
    const {client, calls} = await fixture(t, {rpcResults: {
      'thread/read': () => ({thread: {...fixtureThread, cwd: reads++ ? foreignWorkspace : workspace}}),
      'thread/items/list': (_params, {experimental}) => experimental ? {data: [entry], nextCursor: null} : null,
      'thread/items/read': (_params, {experimental}) => experimental ? {data: [entry]} : null,
    }});
    await assert.rejects(client().readTurnEvidence([workspace, foreignWorkspace], fixtureThread.id, 'changed-turn', {item}), {status: 404});
    assert.equal(calls.filter(([method]) => method === 'thread/read').length, 2);
  }
});

test('unknown command actions hide outside literals in both the evidence page and exact output', async t => {
  const projectRoot = '/private/project root';
  const turnId = 'literal-path-turn';
  const command = (id, text, deferred = false, cwd = projectRoot) => ({turnId, outputDeferred: deferred,
    item: {id, type: 'commandExecution', status: 'completed', command: text, cwd, exitCode: 0,
      commandActions: [{type: 'unknown', command: text}], aggregatedOutput: 'fixture-' + id}});
  const safe = [
    command('local', "/bin/zsh -lc 'node --test proof.test.mjs'"),
    command('inside-quoted', 'cat "/private/project root/test report.txt"'),
    command('deferred-local', "/bin/zsh -lc 'node --test nested/proof.test.mjs'", true),
  ];
  const outside = [
    command('outside-posix', 'cat "/private/outside report.txt"'),
    command('outside-drive', 'cat "D:\\Outside report.txt"'),
    command('outside-unc', 'cat "\\\\host\\share\\Outside report.txt"'),
    command('outside-parent', "/bin/zsh -lc 'cat ../outside.txt'"),
    command('outside-nested', 'cat reports/../../outside.txt'),
    command('outside-home', 'cat ~/outside.txt'),
    command('outside-env', 'cat "$HOME/outside.txt"'),
    command('outside-windows-env', 'type "%USERPROFILE%\\Outside report.txt"'),
    command('fake-shell-prefix', '/private/bin/zsh -lc "node --test proof.test.mjs"'),
  ];
  const rows = [...safe, ...outside];
  const {client} = await fixture(t, {thread: {...fixtureThread, cwd: projectRoot}, rpcResults: {
    'thread/items/list': () => ({data: rows, nextCursor: null}),
    'thread/items/read': ({itemIds: [id]}) => {
      const row = rows.find(row => row.item.id === id);
      return {data: [{...row, outputDeferred: false}]};
    },
  }});
  const native = client();
  const options = {scope: [projectRoot], id: fixtureThread.id, turnId};
  const {entries} = await native.readTurnEvidence(options.scope, options.id, options.turnId);
  assert.deepEqual(entries.slice(0, 3).map(row => row.outputState), ['visible', 'visible', 'deferred']);
  assert.ok(entries[1].command.includes('test report.txt'));
  for (const row of entries.slice(3)) {
    assert.equal(row.outputState, 'hidden', row.id);
    assert.equal(row.command, undefined);
    assert.equal(row.output, undefined);
    assert.equal(row.exitCode, 0);
  }
  const direct = await native.readTurnEvidence(options.scope, options.id, options.turnId, {item: 'outside-parent'});
  assert.equal(direct.entry.outputState, 'hidden');
  assert.equal(direct.entry.output, undefined);
  const deferred = await native.readTurnEvidence(options.scope, options.id, options.turnId, {item: 'deferred-local'});
  assert.equal(deferred.entry.output, 'fixture-deferred-local');
});

test('PowerShell 7 evidence shows scoped command results and hides opaque or external inputs', async t => {
  const projectRoot = 'C:\\Fixture\\Project';
  const turnId = 'powershell-evidence-turn';
  const installed = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"';
  const packaged = '"C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime.v26-813-10124-0_26.813.10124.0_x64__3k8sg7r9htsxt\\dependencies\\native\\powershell\\pwsh.exe"';
  const make = (id, command, outputDeferred = false) => ({
    turnId, outputDeferred, item: {id, command, type: 'commandExecution', status: 'completed', cwd: projectRoot,
      commandActions: [{type: 'unknown', command}], aggregatedOutput: 'fixture-' + id, exitCode: 0},
  });
  const rows = [
    make('local', installed + ' -NoLogo -NoProfile -NonInteractive -Command "node --test proof.test.mjs"'),
    make('deferred', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoProfile -Command "Write-Output proof"', true),
    make('bare', 'pwsh -NoProfile -Command "Write-Output proof"'),
    make('packaged', packaged + ' -NoProfile -Command "Write-Output proof"'),
    make('leading-space', '  pwsh.exe -NoProfile -Command "Write-Output proof"'),
    make('outside', installed + ' -NoProfile -Command "Get-Content B:\\Outside\\example.txt"'),
    make('outside-unc', installed + " -Command 'Get-Content \"\\\\server\\share\\example.txt\"'"),
    make('secret', installed + ' -NoProfile -Command "Write-Output $env:PRIVATE_VALUE"'),
    make('unknown-launcher', '"C:\\Unapproved\\pwsh.exe" -Command "Write-Output proof"'),
    make('different-package', packaged.replace('3k8sg7r9htsxt', '0000000000000') + ' -Command "Write-Output proof"'),
    make('encoded', 'pwsh -EncodedCommand ZgBpAHgAdAB1AHIAZQA='),
    make('spaced-encoded', ' pwsh -EncodedCommand ZgBpAHgAdAB1AHIAZQA='),
    make('relative-encoded', '.\\pwsh.exe -EncodedCommand ZgBpAHgAdAB1AHIAZQA='),
    make('relative-call', '& ".\\bin\\pwsh.exe" -EncodedCommand ZgBpAHgAdAB1AHIAZQA='),
    make('stdin', 'pwsh -NoProfile -Command -'),
    make('stdin-quoted', 'pwsh.exe -Command "-" example'),
    make('file', 'pwsh.exe -File proof.ps1'),
    make('other-flag', 'pwsh.exe -CommandWithArgs "Write-Output proof"'),
  ];
  const {client} = await fixture(t, {thread: {...fixtureThread, cwd: projectRoot}, rpcResults: {
    'thread/items/list': ({cursor, limit}) => cursor
      ? {data: rows.slice(limit), nextCursor: null}
      : {data: rows.slice(0, limit), nextCursor: 'powershell-page-2'},
    'thread/items/read': ({itemIds: [id]}) => ({data: [{...rows.find(row => row.item.id === id), outputDeferred: false}]}),
  }});
  const native = client();
  const read = item => native.readTurnEvidence([projectRoot], fixtureThread.id, turnId, item ? {item} : {});
  const first = await read();
  assert.equal(first.nextCursor, 'powershell-page-2');
  const second = await native.readTurnEvidence([projectRoot], fixtureThread.id, turnId, {cursor: first.nextCursor});
  assert.equal(second.nextCursor, null);
  const entries = [...first.entries, ...second.entries];
  assert.deepEqual(entries.map(({id, outputState}) => [id, outputState]), [
    ['local', 'visible'], ['deferred', 'deferred'], ['bare', 'visible'], ['packaged', 'visible'], ['leading-space', 'visible'],
    ...rows.slice(5).map(({item}) => [item.id, 'hidden']),
  ]);
  assert.match(entries[0].command, /pwsh\.exe.*node --test proof\.test\.mjs/i);
  assert.doesNotMatch(entries[0].command, /Program Files/i);
  assert.equal(entries[0].output, 'fixture-local');
  assert.equal((await read('deferred')).entry.output, 'fixture-deferred');
  for (const {item: {id}} of rows.slice(5)) {
    const {entry} = await read(id);
    assert.equal(entry.outputState, 'hidden', id);
    assert.equal(entry.command, undefined);
    assert.equal(entry.output, undefined);
    assert.equal(entry.exitCode, 0);
  }
});

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
  assert.deepEqual(await native.submit({...request, knownId: fixtureThread.id, previousTurnId: priorTurn.id}),
    {threadId: fixtureThread.id, turn: fixtureTurn});
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

test('cross-client or stale native turns cannot receive a managed continuation', async t => {
  const active = {...fixtureThread, status: {type: 'active'}};
  for (const [name, options, mayResume] of [
    ['already active', {thread: active}, false],
    ['active after resume', {resumed: active}, true],
    ['different latest turn', {turn: {...priorTurn, id: 'newer-turn'}}, false],
    ['in-progress latest turn', {turn: {...priorTurn, status: 'inProgress'}}, false],
  ]) {
    await t.test(name, async run => {
      const {client, calls} = await fixture(run, options);
      await assert.rejects(client().submit({...request, knownId: fixtureThread.id, previousTurnId: priorTurn.id}),
        {code: 'CODEX_RESUME_TARGET_UNAVAILABLE'});
      assert.equal(calls.some(([method]) => method === 'thread/resume'), mayResume);
      assert.equal(calls.some(([method]) => method === 'turn/start'), false);
    });
  }
});

test('a verified desktop handoff identifies only a persisted native thread', async t => {
  const persisted = await fixture(t);
  const ephemeral = await fixture(t, {thread: {...fixtureThread, ephemeral: true}});
  assert.equal((await persisted.client().readThread([workspace], fixtureThread.id)).desktopThreadId, fixtureThread.id);
  assert.equal((await ephemeral.client().readThread([workspace], fixtureThread.id)).desktopThreadId, undefined);
  await assert.rejects(persisted.client().readThread([foreignWorkspace], fixtureThread.id), {status: 404});
});

test('the exact history turn exposes native recorded timestamps only when present', async t => {
  const dated = await fixture(t, {turn: {...priorTurn, startedAt: 1760000000, completedAt: 1760000001}});
  const blank = await fixture(t, {turn: {...priorTurn, startedAt: null}});
  const [read] = (await dated.client().readThread([workspace], fixtureThread.id)).turns;
  const [old] = (await blank.client().readThread([workspace], fixtureThread.id)).turns;
  assert.equal(read.id, priorTurn.id);
  assert.equal(read.startedAt, '2025-10-09T08:53:20.000Z');
  assert.equal(read.completedAt, '2025-10-09T08:53:21.000Z');
  assert.equal(Object.hasOwn(old, 'startedAt'), false);
  assert.equal(Object.hasOwn(old, 'completedAt'), false);
});

test('Codex adding this client to a different active turn does not confer ownership of that turn', async t => {
  const {client, calls} = await fixture(t, {firstUser: 'external-writer'});
  const native = client();
  await assert.rejects(native.submit({...request, knownId: fixtureThread.id, previousTurnId: priorTurn.id}), {status: 503});
  assert.equal(calls.filter(([method]) => method === 'turn/start').length, 1);
  assert.equal(calls.some(([method]) => method === 'turn/interrupt'), false);
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
