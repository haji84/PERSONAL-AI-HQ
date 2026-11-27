import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createChatStore} from '../app/chat-store.mjs';

const request = {id: '05293ae6-b9f3-4a2f-b53c-a18177427a5c', model: 'fixture-model',
  prompt: '  指示原文を保存する。\n', createdAt: '2026-11-27T08:40:00.000Z'};
const conversationId = `api/${request.id}`;
const completion = {id: request.id, outcome: 'completed', summary: '独立テストに合格。',
  updatedAt: '2026-11-27T08:42:00.000Z'};

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'hq-development-conversation-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

test('migrates existing exports and lists API work in the same project history', async t => {
  const path = await directory(t);
  const old = new DatabaseSync(join(path, 'conversations.sqlite'));
  const original = [{role: 'user', text: '以前の会話', createdAt: null}];
  old.exec(`CREATE TABLE conversations (
    project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, imported_at TEXT NOT NULL,
    modified REAL NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(project,id))`);
  old.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run('example', 'export-1', '履歴',
    '2026-11-01T00:00:00.000Z', 1, JSON.stringify(original));
  old.close();

  const store = createChatStore(path);
  t.after(() => store.close());
  const start = store.beginDevelopment('example', request).conversation;
  assert.equal(start.id, conversationId);
  assert.equal(start.source, 'api-development');
  assert.equal(start.model, request.model);
  assert.equal(start.outcome, 'in_progress');
  assert.equal(start.messages[0].text, request.prompt);
  const done = store.finishDevelopment('example', completion).conversation;
  assert.equal(done.outcome, 'completed');
  assert.deepEqual(done.messages.map(({role, text}) => ({role, text})), [
    {role: 'user', text: request.prompt}, {role: 'assistant', text: completion.summary},
  ]);
  assert.deepEqual(store.list('example').conversations.map(({id, source}) => [id, source]), [
    [conversationId, 'api-development'], ['export-1', 'chatgpt-export'],
  ]);
  assert.equal(store.list('example', '独立テスト').conversations[0].id, conversationId);
  assert.deepEqual(store.read('example', 'export-1', 0).conversation.messages, original);
  assert.equal(store.read('other', conversationId, 0), null);
  assert.throws(() => store.finishDevelopment('other', completion), {status: 404});
  assert.throws(() => store.beginLive('example', {id: 'attempt', model: request.model,
    prompt: '引き継ぐ', conversationId}), {status: 400});
  assert.equal(store.hasActiveLive('example'), false);
});

test('preserves interrupted and unconfirmed work across restart and competing replays', async t => {
  const path = await directory(t);
  const first = createChatStore(path);
  first.beginDevelopment('example', request);
  first.close();

  const second = createChatStore(path);
  t.after(() => second.close());
  assert.equal(second.read('example', conversationId, 0).conversation.outcome, 'in_progress');
  assert.throws(() => second.beginDevelopment('example', {...request, prompt: '上書き'}), {status: 409});
  const interrupted = {...completion, outcome: 'interrupted', summary: ''};
  const persisted = second.finishDevelopment('example', interrupted);
  assert.equal(persisted.conversation.outcome, 'interrupted');
  assert.equal(persisted.conversation.messages.length, 1);
  assert.deepEqual(second.beginDevelopment('example', request), persisted);
  assert.deepEqual(second.finishDevelopment('example', interrupted), persisted);
  assert.throws(() => second.finishDevelopment('example', completion), {status: 409});

  const id = '95cc5ad2-2a19-4b35-9960-030d7a3cca25';
  second.beginDevelopment('example', {...request, id});
  const uncertain = second.finishDevelopment('example', {...interrupted, id, outcome: 'unconfirmed'});
  assert.equal(uncertain.conversation.outcome, 'unconfirmed');
  assert.deepEqual(second.beginDevelopment('example', {...request, id}), uncertain);
  assert.throws(() => second.finishDevelopment('example', {...completion, id}), {status: 409});
  const settled = {...completion, id, updatedAt: new Date(Date.parse(completion.updatedAt) + 1).toISOString()};
  assert.equal(second.finishDevelopment('example', settled).conversation.outcome, 'completed');
  assert.deepEqual(second.beginDevelopment('example', {...request, id}).conversation.messages.map(message => message.role), ['user', 'assistant']);
  assert.throws(() => second.finishDevelopment('example', {...settled, summary: '差替え'}), {status: 409});
});
