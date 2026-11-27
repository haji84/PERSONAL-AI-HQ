import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import test from 'node:test';
import {WebSocketServer} from 'ws';
import {createCodexClient} from '../app/codex.mjs';

const workspace = '/fixture/project';
const threadId = 'thread-exact';
const turnId = 'turn-exact';
const clientId = 'work-exact';
const defaultThread = {id: threadId, cwd: workspace, updatedAt: 20, status: {type: 'idle'}};
const completed = {id: turnId, status: 'completed', error: null, itemsView: 'notLoaded', items: [],
  startedAt: 10, completedAt: 20, durationMs: 10000};
const user = (id, text, link = clientId) => ({turnId, item: {id, type: 'userMessage', clientId: link,
  content: [{type: 'text', text, text_elements: []}]}});
const agent = (id, text, phase = 'final_answer') => ({turnId, item: {id, type: 'agentMessage', text, phase}});
const page = (data, nextCursor = null) => ({data, nextCursor, backwardsCursor: null});
const exchange = [user('user-1', '作業指示'), agent('agent-1', '完了')];
const read = native => native.readHandoverTurn(workspace, threadId, turnId, clientId);
const unverified = {code: 'HANDOVER_CONVERSATION_UNVERIFIED', status: 409};

async function ipc(t, {turns = [completed], thread = () => defaultThread, getPage = () => page(exchange)} = {}) {
  const directory = await mkdtemp('/tmp/hq-codex-turn-');
  const socket = join(directory, 'rpc.sock');
  const server = createServer();
  const websocket = new WebSocketServer({server});
  const native = createCodexClient({socket});
  const calls = [];
  t.after(async () => {
    native.close();
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  });
  let turnReads = 0;
  let threadReads = 0;
  websocket.on('connection', connection => {
    connection.on('message', bytes => {
      const {id, method, params} = JSON.parse(bytes);
      if (id === undefined) return;
      let result;
      if (method === 'initialize') result = {};
      else {
        calls.push([method, params]);
        if (method === 'thread/read') result = {thread: thread(threadReads++)};
        if (method === 'thread/turns/list') result = page([turns[Math.min(turnReads++, turns.length - 1)]]);
        if (method === 'thread/items/list') result = getPage(params.cursor);
      }
      connection.send(JSON.stringify({id, ...(result === undefined ? {error: {code: -32601}} : {result})}));
    });
  });
  server.listen(socket);
  await once(server, 'listening');
  return {native, calls};
}

test('read-only handover pages a completed latest turn and preserves visible text and IDs', {skip: process.platform === 'win32'}, async t => {
  const prompt = '  日本語 😺\r\n原文\n\t';
  const comment = ' 検討中 \n';
  const steering = ' 追加の指示\n';
  const answer = '\n 検証結果\r\n  ';
  const {native, calls} = await ipc(t, {getPage: cursor => cursor === null ? page([
    user('user-1', prompt), {turnId, item: {id: 'reasoning-1', type: 'reasoning', content: ['internal thought']}},
    agent('agent-1', comment, 'commentary'),
  ], 'next-page') : page([
    user('steering-1', steering, 'hq:steer:follow-up'),
    {turnId, item: {id: 'tool-1', type: 'commandExecution', command: 'internal command', aggregatedOutput: 'internal output'}},
    {turnId, item: {...agent('agent-2', answer).item, memoryCitation: {secret: 'private metadata'}}},
  ])});
  assert.deepEqual(await read(native), {threadId, turnId, messages: [
    {id: 'user-1', role: 'user', text: prompt}, {id: 'agent-1', role: 'assistant', text: comment},
    {id: 'steering-1', role: 'user', text: steering}, {id: 'agent-2', role: 'assistant', text: answer},
  ]});
  assert.deepEqual(calls.map(([method]) => method),
    ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/items/list', 'thread/read', 'thread/turns/list']);
  for (const [method, params] of calls) {
    assert.equal(params.threadId, threadId);
    if (method === 'thread/items/list') assert.deepEqual(params, {threadId, turnId, cursor: params.cursor, limit: 12, sortDirection: 'asc'});
    if (method === 'thread/turns/list') assert.equal(params.sortDirection, 'desc');
    if (method === 'thread/read') assert.equal(params.includeTurns, false);
  }
});

test('handover rejects latest, activity or workspace mismatches before collecting a transcript', {skip: process.platform === 'win32'}, async t => {
  for (const config of [
    {turns: [{...completed, id: 'later-turn'}]}, {turns: [{...completed, status: 'inProgress'}]},
    {turns: [{...completed, status: 'interrupted'}]}, {thread: () => ({...defaultThread, status: {type: 'active'}})},
    {thread: () => ({...defaultThread, cwd: '/fixture/other'})}, {thread: () => ({...defaultThread, id: 'other-thread'})},
  ]) {
    const {native, calls} = await ipc(t, config);
    await assert.rejects(read(native), {status: config.thread && config.thread().status.type === 'idle' ? 404 : 409});
    assert.equal(calls.some(([method]) => method === 'thread/items/list'), false);
  }
});

test('handover rejects ambiguous, incomplete or unsafe text rather than returning a partial conversation', {skip: process.platform === 'win32'}, async t => {
  const hidden = {...exchange[1], item: {...exchange[1].item, moderation: {moderated: true, display: {mode: 'hide'}}}};
  const attachment = {...exchange[0], item: {...exchange[0].item,
    content: [...exchange[0].item.content, {type: 'localImage', path: '/fixture/private'}]}};
  const cases = [
    [user('user-1', 'unrelated', 'another-work'), exchange[1]],
    [exchange[0], user('duplicate-primary', 'unrelated duplicate'), exchange[1]],
    [exchange[0], agent('user-1', 'duplicate item')], [exchange[0]],
    [exchange[0], agent('only-partial', 'draft', 'partial_answer')],
    [exchange[0], {...exchange[1], outputDeferred: true}], [exchange[0], hidden],
    [attachment, exchange[1]], [exchange[0], {...exchange[1], turnId: 'other-turn'}],
    [exchange[0], agent('', 'missing item id')], [exchange[0], agent('agent-1', 'a'.repeat(24001))],
  ];
  for (const data of cases) {
    const {native} = await ipc(t, {getPage: () => page(data)});
    await assert.rejects(read(native), unverified);
  }
});

test('handover detects changing state and malformed or exhausted pagination', {skip: process.platform === 'win32'}, async t => {
  for (const config of [
    {turns: [completed, {...completed, id: 'later-turn'}]},
    {thread: index => index ? {...defaultThread, status: {type: 'active'}} : defaultThread},
    {getPage: () => ({data: exchange})}, {getPage: () => page(exchange, 123)},
    {getPage: cursor => page([agent(`agent-${cursor}`, 'text')], 'same-cursor')},
    {getPage: cursor => page(cursor === null ? exchange : [agent(`agent-${cursor}`, 'text')], String(Number(cursor) + 1))},
  ]) {
    const {native, calls} = await ipc(t, config);
    await assert.rejects(read(native), unverified);
    assert.ok(calls.filter(([method]) => method === 'thread/items/list').length <= 4);
  }
});
