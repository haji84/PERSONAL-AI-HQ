import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createChatStore} from '../app/chat-store.mjs';

const request = {id: 'request-1', model: 'fixture-model', prompt: '新しい質問'};

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'hq-live-chat-test-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

test('migrates the existing SQLite file, branches a reviewed export, and leaves its source untouched', async t => {
  const path = await directory(t);
  const old = new DatabaseSync(join(path, 'conversations.sqlite'));
  const original = [
    {role: 'user', text: '元の質問', createdAt: null},
    {role: 'assistant', text: '元の返答', createdAt: null},
  ];
  old.exec(`CREATE TABLE conversations (
    project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, imported_at TEXT NOT NULL,
    modified REAL NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(project,id))`);
  old.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run('example', 'export-1', 'タイトル',
    '2026-11-01T00:00:00.000Z', 1, JSON.stringify(original));
  old.close();
  const store = createChatStore(path);
  t.after(() => store.close());
  assert.throws(() => store.beginLive('other', {...request, conversationId: 'export-1'}), {status: 404});
  const {turn, messages, duplicate} = store.beginLive('example', {...request, conversationId: 'export-1'});
  assert.equal(duplicate, false);
  assert.notEqual(turn.conversationId, 'export-1');
  assert.deepEqual(messages, [
    {role: 'user', content: '元の質問'},
    {role: 'assistant', content: '元の返答'},
    {role: 'user', content: '新しい質問'},
  ]);
  store.finishLive('example', request.id, {status: 'completed', text: '新しい返答'});
  assert.deepEqual(store.read('example', 'export-1', 0).conversation.messages, original);
  assert.equal(store.read('other', turn.conversationId, 0), null);
  assert.equal(store.read('example', turn.conversationId, 0).conversation.messages.at(-1).text, '新しい返答');
  assert.deepEqual(store.list('example', '').conversations.map(row => row.source), ['chatgpt-live', 'chatgpt-export']);
});

test('replays persisted turn IDs after restart, preserves interrupted partials and never auto-sends', async t => {
  const path = await directory(t);
  let time = Date.now();
  const first = createChatStore(path, {now: () => time});
  const {turn} = first.beginLive('one', request);
  assert.equal(turn.status, 'in_progress');
  first.persistLiveText('one', request.id, '途中');
  first.close();

  const second = createChatStore(path, {now: () => time});
  t.after(() => second.close());
  assert.equal(second.readLive('one', request.id).status, 'in_progress');
  time += 10 * 60 * 1000;
  const resumed = second.beginLive('one', request);
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.messages, undefined);
  assert.equal(resumed.turn.text, '途中');
  assert.equal(resumed.turn.status, 'interrupted');
  assert.throws(() => second.beginLive('one', {...request, prompt: 'different'}), {status: 409});
  assert.equal(second.readLive('other', request.id), null);
  const next = second.beginLive('one', {...request, id: 'request-2', conversationId: turn.conversationId});
  assert.deepEqual(next.messages, [{role: 'user', content: request.prompt}]);
  assert.equal(second.beginLive('other', request).duplicate, false);
});

test('serializes turns by conversation across connections and does not replace a terminal outcome', async t => {
  const path = await directory(t);
  const one = createChatStore(path);
  const two = createChatStore(path);
  t.after(() => { two.close(); one.close(); });
  const {turn} = one.beginLive('example', request);
  const next = {...request, id: 'request-2', conversationId: turn.conversationId, prompt: '続き'};
  assert.throws(() => two.beginLive('example', next), {status: 409});
  one.persistLiveText('example', request.id, '最初');
  assert.throws(() => one.persistLiveText('example', request.id, '上書き'), {status: 409});
  const ended = one.finishLive('example', request.id, {status: 'completed', text: '最初の返答'});
  assert.equal(ended.status, 'completed');
  assert.deepEqual(two.finishLive('example', request.id, {status: 'aborted', text: '最初'}), ended);
  assert.deepEqual(two.beginLive('example', next).messages, [
    {role: 'user', content: '新しい質問'}, {role: 'assistant', content: '最初の返答'},
    {role: 'user', content: '続き'},
  ]);
});

test('reserves only after a synchronous routing check and can inspect active turns under a write lock', async t => {
  const path = await directory(t);
  const store = createChatStore(path);
  const routing = new DatabaseSync(join(path, 'conversations.sqlite'));
  t.after(() => { routing.close(); store.close(); });

  let policyChecks = 0;
  assert.throws(() => store.beginLive('project', request, () => {
    policyChecks++;
    throw new Error('route changed');
  }), /route changed/);
  assert.equal(policyChecks, 1);
  assert.deepEqual(store.list('project').conversations, []);
  assert.equal(store.readLive('project', request.id), null);

  store.beginLive('project', request, () => policyChecks++);
  assert.equal(store.beginLive('project', request, () => assert.fail('duplicate should not reserve')).duplicate, true);
  assert.equal(policyChecks, 2);
  routing.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(store.hasActiveLive('project'), true);
    assert.equal(store.hasActiveLive('other'), false);
  } finally {
    routing.exec('ROLLBACK');
  }
  store.finishLive('project', request.id, {status: 'failed', text: '途中までの回答'});
  assert.equal(store.hasActiveLive('project'), false);
});
