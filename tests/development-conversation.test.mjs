import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createChatStore} from '../app/chat-store.mjs';

const request = {id: '05293ae6-b9f3-4a2f-b53c-a18177427a5c', model: 'fixture-model',
  prompt: '  指示原文を保存する。\n', createdAt: '2026-11-27T08:40:00.000Z'};
const conversationId = `api/${request.id}`;
const completion = {id: request.id, outcome: 'completed', summary: '独立テストに合格。',
  updatedAt: '2026-11-27T08:42:00.000Z'};

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const path = await mkdtemp(join(temp, 'hq-development-conversation-'));
  const opened = new Set();
  const keep = entry => {
    opened.add(entry);
    return entry;
  };
  function close(entry) {
    entry.close();
    opened.delete(entry);
  }
  t.after(async () => {
    for (const entry of Array.from(opened).reverse()) close(entry);
    const target = await realpath(path);
    assert.equal(dirname(target), temp);
    assert.ok(basename(target).startsWith('hq-development-conversation-'));
    await rm(target, {recursive: true, force: true});
  });
  return {
    database: () => keep(new DatabaseSync(join(path, 'conversations.sqlite'))),
    store: () => keep(createChatStore(path)),
    close,
  };
}

test('migrates existing exports and lists API work in the same project history', async t => {
  const unit = await fixture(t);
  const old = unit.database();
  const original = [{role: 'user', text: '以前の会話', createdAt: null}];
  old.exec(`CREATE TABLE conversations (
    project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, imported_at TEXT NOT NULL,
    modified REAL NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(project,id))`);
  old.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run('example', 'export-1', '履歴',
    '2026-11-01T00:00:00.000Z', 1, JSON.stringify(original));
  unit.close(old);

  const store = unit.store();
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
  const unit = await fixture(t);
  const first = unit.store();
  first.beginDevelopment('example', request);
  unit.close(first);

  const second = unit.store();
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
