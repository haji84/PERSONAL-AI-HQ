import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {WebSocketServer} from 'ws';
import {createCodexClient} from '../app/codex.mjs';
import {startOwnerApp} from '../app/server.mjs';

const limit = 512 * 1024;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';
const webp = Buffer.from('5249464616000000574542505650384c0a0000002f000000000000000000', 'hex').toString('base64');
const image = (mime = 'image/png', data = png) => ({mime, data});
const task = {id: 'fixture-image-run', prompt: '画像の所見をまとめてください。'};
const fixtureModel = (model, isDefault, inputModalities) => ({model, isDefault, inputModalities,
  defaultReasoningEffort: 'low', supportedReasoningEfforts: [{reasoningEffort: 'low'}]});

async function fixture(t, {catalog = [fixtureModel('image-model', true, ['text', 'image', 'internal', 'image']),
  fixtureModel('text-model', false, ['text']), fixtureModel('unknown-model', false, null)]} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hq-codex-image-')));
  const socket = join(directory, 'rpc.sock');
  const workspace = join(directory, 'workspaces', 'fixture');
  await mkdir(workspace, {recursive: true, mode: 0o700});
  await writeFile(join(workspace, '.hq-owned-workspace'), 'fixture\n');
  const writePortfolio = state => writeFile(join(directory, 'portfolio.json'), JSON.stringify({projects: [
    {id: 'fixture', name: 'Fixture', enableCodexWrite: true, cwd: workspace, state},
  ]}), {mode: 0o600});
  await writePortfolio('ready');
  const server = createServer();
  const websocket = new WebSocketServer({server});
  const native = createCodexClient({socket});
  const calls = [];
  let app;
  let turn = 0;
  let firstUserId;
  t.after(async () => {
    await app?.close();
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  });
  const thread = {id: 'exact-thread', cwd: workspace, modelProvider: 'openai', ephemeral: false, status: {type: 'idle'}};
  websocket.on('connection', connection => {
    connection.on('message', bytes => {
      const {id, method, params} = JSON.parse(bytes);
      if (id === undefined) return;
      calls.push([method, params]);
      const results = {initialize: {}, 'account/read': {account: {type: 'chatgpt'}, requiresOpenaiAuth: true},
        'model/list': {data: catalog}, 'thread/start': {thread}, 'thread/resume': {thread}, 'thread/read': {thread},
        'thread/items/list': {data: [{turnId: params?.turnId, item: {type: 'userMessage', clientId: firstUserId}}]},
        'thread/turns/list': {data: turn ? [{id: `exact-turn-${turn}`, status: 'completed'}] : []}};
      if (method === 'turn/start') firstUserId = params.clientUserMessageId;
      const result = method === 'turn/start' ? {turn: {id: `exact-turn-${++turn}`, status: 'completed'}} : results[method];
      connection.send(JSON.stringify({id, ...(result ? {result} : {error: {code: -32601}})}));
    });
  });
  server.listen(socket);
  await once(server, 'listening');
  app = await startOwnerApp({directory, port: 0, codex: native});
  const signIn = await readFile(app.signInFile, 'utf8');
  const key = /name="key" value="([a-f0-9]{64})"/.exec(signIn)?.[1];
  const login = await fetch(app.url + '/api/session', {method: 'POST', headers: {Origin: 'null'},
    redirect: 'manual', body: new URLSearchParams({key})});
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (endpoint, body, overrides) => fetch(app.url + endpoint, body === undefined ? {headers: {cookie}} : {
    method: 'POST', headers: {cookie, Origin: app.url, 'Content-Type': 'application/json', ...overrides}, body: JSON.stringify(body),
  });
  return {directory, calls, call, writePortfolio, run: (body, overrides) => call('/api/codex/run?project=fixture', body, overrides),
    writeCalls: () => calls.filter(([method]) => ['thread/start', 'thread/resume', 'turn/start', 'turn/steer'].includes(method))};
}

test('one validated image is sent on the pinned Codex turn and replay never repeats it', {skip: process.platform === 'win32'}, async t => {
  const {directory, call, run, writeCalls} = await fixture(t);
  const catalog = await (await call('/api/codex/models')).json();
  assert.deepEqual(catalog.data.map(({id, inputModalities}) => [id, inputModalities]),
    [['image-model', ['text', 'image']], ['text-model', ['text']], ['unknown-model', []]]);
  const first = {...task, image: image()};
  assert.equal((await run(first, {cookie: ''})).status, 401);
  assert.equal((await run(first, {Origin: 'https://fixture.invalid'})).status, 403);
  const start = await run(first);
  assert.equal(start.status, 202);
  assert.equal((await start.json()).operation.image, undefined);
  const terminal = await readCompleted(call, first.id);
  assert.equal(terminal.threadId, 'exact-thread');
  const wrongThread = await run({...task, id: 'fixture-image-mismatch', resume: first.id, expectedThreadId: 'another-thread'});
  assert.equal(wrongThread.status, 409);
  assert.equal((await wrongThread.json()).code, 'CODEX_RESUME_TARGET_UNAVAILABLE');
  assert.equal(terminal.fingerprint, undefined);
  assert.equal(JSON.stringify(terminal).includes(png), false);
  assert.equal((await run(first)).status, 202);
  assert.equal((await run(task)).status, 409);
  assert.equal((await run({...task, image: image('image/jpeg', jpeg)})).status, 409);
  const changed = Buffer.from(png, 'base64');
  changed[changed.length - 1] ^= 1;
  assert.equal((await run({...task, image: image('image/png', changed.toString('base64'))})).status, 409);
  assert.deepEqual(writeCalls().map(([method]) => method), ['thread/start', 'turn/start']);
  const [, turn] = writeCalls()[1];
  assert.equal(turn.model, 'image-model');
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.deepEqual(turn.input, [{type: 'text', text: task.prompt, text_elements: []},
    {type: 'image', url: `data:image/png;base64,${png}`}]);

  const resumed = {...task, id: 'fixture-image-next', resume: task.id, image: image('image/webp', webp)};
  assert.equal((await run(resumed)).status, 202);
  await readCompleted(call, resumed.id);
  assert.deepEqual(writeCalls().slice(2).map(([method]) => method), ['thread/resume', 'turn/start']);
  assert.equal(writeCalls()[3][1].input[1].url, `data:image/webp;base64,${webp}`);

  const text = {...task, id: 'fixture-text-only', model: 'text-model'};
  assert.equal((await run(text)).status, 202);
  await readCompleted(call, text.id);
  assert.deepEqual(writeCalls()[5][1].input, [{type: 'text', text: text.prompt, text_elements: []}]);
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'), {readOnly: true});
  try {
    const rows = db.prepare('SELECT id, fingerprint, output FROM codex_operations ORDER BY id').all();
    const textReceipt = createHash('sha256').update(JSON.stringify([text.prompt, text.model, undefined, undefined])).digest('hex');
    assert.equal(rows.find(row => row.id === text.id).fingerprint, textReceipt);
    assert.equal(JSON.stringify(rows).includes(png), false);
  } finally { db.close(); }
});

async function readCompleted(call, id) {
  for (let i = 0; i < 20; i++) {
    const read = await call(`/api/codex/run?project=fixture&id=${id}`);
    const {operation} = await read.json();
    if (operation?.phase === 'completed') return operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('fixture turn never completed');
}

test('validation rejects paths, noncanonical data, type mismatches and oversized data before dispatch', {skip: process.platform === 'win32'}, async t => {
  const {call, run, writeCalls} = await fixture(t);
  for (const bad of [null, [image()], {mime: 'image/png', url: 'file:///fixture.png'},
    {...image(), path: '/fixture.png'}, image('image/gif'), image('image/jpeg'), image('image/webp', Buffer.from('RIFF0000WAVE').toString('base64')),
    image('image/png', `data:image/png;base64,${png}`), image('image/png', png.replace(/=+$/u, '')),
    image('image/png', png.replace('Jggg==', 'Jggh==')), image('image/png', ` ${png}`), image('image/png', ''),
  ]) assert.equal((await run({...task, image: bad})).status, 400);
  const paddedImage = size => Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(size - Buffer.from(png, 'base64').length)]).toString('base64');
  assert.equal((await run({...task, image: image('image/png', paddedImage(limit + 1))})).status, 413);
  assert.equal((await run({...task, image: image('image/png', 'A'.repeat(768 * 1024))})).status, 413);
  assert.equal((await call('/api/codex/steer?project=fixture', {id: task.id, operationId: task.id, prompt: 'follow-up', image: image()})).status, 400);
  assert.equal(writeCalls().length, 0);
  const atLimit = image('image/png', paddedImage(limit));
  assert.equal((await run({...task, image: atLimit})).status, 202);
  await readCompleted(call, task.id);
  assert.equal(writeCalls()[1][1].input[1].url.length, 'data:image/png;base64,'.length + atLimit.data.length);
});

test('image dispatch does not select another model or bypass project state', {skip: process.platform === 'win32'}, async t => {
  const {call, run, writePortfolio, writeCalls} = await fixture(t, {catalog: [fixtureModel('text-model', true, ['text']),
    fixtureModel('unknown-model', false, undefined), fixtureModel('image-model', false, ['image'])]});
  const withImage = {...task, image: image('image/jpeg', jpeg)};
  for (const model of [undefined, 'unknown-model', 'not-in-catalog']) {
    const denied = await run({...withImage, model});
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).code, 'CODEX_IMAGE_MODEL_UNAVAILABLE');
    const unwritten = await call('/api/codex/run?project=fixture&id=' + task.id);
    assert.equal((await unwritten.json()).operation, null);
  }
  await writePortfolio('paused');
  assert.equal((await run({...withImage, model: 'image-model'})).status, 409);
  assert.equal(writeCalls().length, 0);
  await writePortfolio('ready');
  assert.equal((await run({...withImage, model: 'image-model'})).status, 202);
  await readCompleted(call, task.id);
  assert.equal(writeCalls()[1][1].model, 'image-model');
  assert.equal(writeCalls()[1][1].input[1].url, `data:image/jpeg;base64,${jpeg}`);
});

test('document dispatch preserves UTF-8 prompt and reference text and binds both name and bytes to replay', {skip: process.platform === 'win32'}, async t => {
  const {directory, call, run, writeCalls} = await fixture(t);
  const document = {name: '見積もり 😺.CSV', text: '\ufeff\t 項目,数量\r\n  部材,2\r\n\t'};
  const prompt = '\n資料を確認してください。 \t';
  const request = {id: 'fixture-document', prompt, model: 'text-model', document};
  assert.equal((await run(request)).status, 202);
  const terminal = await readCompleted(call, request.id);
  assert.equal(terminal.document, undefined);
  assert.equal(JSON.stringify(terminal).includes(document.name), false);
  assert.equal((await run({...request, document: {...document}})).status, 202);
  assert.equal((await run({...request, document: {...document, name: '他の資料.csv'}})).status, 409);
  assert.equal((await run({...request, document: {...document, text: document.text.trim()}})).status, 409);
  assert.equal((await run({...request, document: undefined})).status, 409);
  assert.deepEqual(writeCalls().map(([method]) => method), ['thread/start', 'turn/start']);
  const {input, model, sandboxPolicy} = writeCalls()[1][1];
  assert.equal(model, 'text-model');
  assert.equal(sandboxPolicy.networkAccess, false);
  assert.deepEqual(input[0], {type: 'text', text: prompt, text_elements: []});
  assert.equal(input[1].type, 'text');
  const [explanation, json] = input[1].text.split('\n', 2);
  assert.match(explanation, /参考資料/);
  assert.match(explanation, /指示/);
  assert.deepEqual(JSON.parse(json), document);
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'), {readOnly: true});
  try {
    const row = db.prepare('SELECT * FROM codex_operations WHERE id = ?').get(request.id);
    assert.equal(JSON.stringify(row).includes(document.name), false);
    assert.equal(JSON.stringify(row).includes('部材'), false);
  } finally { db.close(); }
});

test('document uploads reject path, suffix, binary data, dual attach and steering before reservation', {skip: process.platform === 'win32'}, async t => {
  const {call, run, writeCalls} = await fixture(t);
  const document = {name: '資料.md', text: '# 注記\r\n'};
  const request = {id: 'fixture-document-reject', prompt: '資料の内容を確認してください。', document};
  for (const bad of [null, [document], {name: '資料.md', url: 'file:///fixture.md'}, {...document, url: 'https://fixture.invalid'},
    {...document, name: '../資料.md'}, {...document, name: 'dir\\資料.md'}, {...document, name: 'C:資料.md'},
    {...document, name: '...'}, {...document, name: '資料.exe'}, {...document, name: '資料\n.md'},
    {...document, name: '資料\u202e.md'}, {...document, name: `${'日'.repeat(85)}.txt`},
    {...document, text: 'binary\0flag'}, {...document, text: '\ud800'},
  ]) assert.equal((await run({...request, document: bad})).status, 400);
  const limit = 16 * 1024;
  const atLimit = '界'.repeat(Math.floor(limit / 3)) + '\n';
  assert.equal(Buffer.byteLength(atLimit), limit);
  assert.equal((await run({...request, document: {...document, text: atLimit + '\n'}})).status, 413);
  assert.equal((await run({...request, image: image()})).status, 400);
  assert.equal((await call('/api/codex/steer?project=fixture', {...request, operationId: 'active-native-turn'})).status, 400);
  assert.equal(writeCalls().length, 0);
  assert.equal((await run({...request, document: {...document, text: atLimit}})).status, 202);
  await readCompleted(call, request.id);
  const reference = writeCalls()[1][1].input[1].text;
  assert.equal(JSON.parse(reference.split('\n', 2)[1]).text, atLimit);
});
