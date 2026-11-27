import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createChatStore} from '../app/chat-store.mjs';
import {chatInputLimit} from '../app/chatgpt-responses.mjs';

const request = {id: 'request-1', model: 'fixture-model', prompt: '新しい質問'};

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const path = await mkdtemp(join(temp, 'hq-live-chat-test-'));
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
    assert.ok(basename(target).startsWith('hq-live-chat-test-'));
    await rm(target, {recursive: true, force: true});
  });
  return {
    database: () => keep(new DatabaseSync(join(path, 'conversations.sqlite'))),
    store: options => keep(createChatStore(path, options)),
    close,
  };
}

test('migrates the existing SQLite file, branches a reviewed export, and leaves its source untouched', async t => {
  const unit = await fixture(t);
  const old = unit.database();
  const original = [
    {role: 'user', text: '元の質問', createdAt: null},
    {role: 'assistant', text: '元の返答', createdAt: null},
  ];
  old.exec(`CREATE TABLE conversations (
    project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, imported_at TEXT NOT NULL,
    modified REAL NOT NULL, messages TEXT NOT NULL, PRIMARY KEY(project,id))`);
  old.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run('example', 'export-1', 'タイトル',
    '2026-11-01T00:00:00.000Z', 1, JSON.stringify(original));
  unit.close(old);
  const store = unit.store();
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
  const unit = await fixture(t);
  let time = Date.now();
  const first = unit.store({now: () => time});
  const {turn} = first.beginLive('one', request);
  assert.equal(turn.status, 'in_progress');
  first.persistLiveText('one', request.id, '途中');
  unit.close(first);

  const second = unit.store({now: () => time});
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
  const unit = await fixture(t);
  const one = unit.store();
  const two = unit.store();
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
  const unit = await fixture(t);
  const store = unit.store();
  const routing = unit.database();

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

test('migrates old live rows and retains exact document identity, history and replay across connections', async t => {
  const unit = await fixture(t);
  const oldRequest = {...request, id: 'old-request'};
  const previous = unit.store();
  previous.beginLive('example', oldRequest);
  const oldTurn = previous.finishLive('example', oldRequest.id, {status: 'completed', text: '以前の回答'});
  unit.close(previous);

  const oldSchema = unit.database();
  if (oldSchema.prepare('PRAGMA table_info(live_turns)').all().some(({name}) => name === 'document')) {
    oldSchema.exec('ALTER TABLE live_turns DROP COLUMN document');
  }
  unit.close(oldSchema);

  const first = unit.store();
  const second = unit.store();
  assert.deepEqual(first.readLive('example', oldRequest.id), oldTurn);
  const document = {name: '元資料.csv', text: '\ufeff項目,数量\r\n部材,2\r\n'};
  const attached = {...request, document};
  const {turn, messages} = first.beginLive('example', attached);
  const userMessage = {role: 'user', content: [
    {type: 'input_text', text: attached.prompt},
    {type: 'input_text', text: '添付資料（元資料.csv）\n' + document.text},
  ]};
  assert.deepEqual(messages, [userMessage]);
  assert.deepEqual(turn.document, {name: document.name});
  assert.deepEqual(second.beginLive('example', {...attached, document: {text: document.text, name: document.name}},
    () => assert.fail('duplicate should not reserve')), {duplicate: true, turn});
  for (const mismatch of [undefined, {...document, name: '同じ内容.csv'}, {...document, text: document.text.replaceAll('\r\n', '\n')}]) {
    assert.throws(() => second.beginLive('example', {...attached, document: mismatch}), {status: 409, code: 'CHAT_REQUEST_CONFLICT'});
  }
  assert.equal(second.readLive('other', attached.id), null);
  assert.equal(second.read('other', turn.conversationId, 0), null);
  assert.throws(() => second.beginLive('other', {...request, conversationId: turn.conversationId}), {status: 404});
  const finished = first.finishLive('example', attached.id, {status: 'completed', text: '資料を確認しました'});
  unit.close(first);
  unit.close(second);
  const reopened = unit.store();
  assert.deepEqual(reopened.readLive('example', attached.id), finished);
  assert.deepEqual(reopened.read('example', turn.conversationId, 0).conversation.messages[0],
    {role: 'user', text: attached.prompt, document, createdAt: turn.createdAt, status: 'completed', turnId: attached.id});
  assert.equal(reopened.read('example', turn.conversationId, 1).conversation.messages[0].document, undefined);
  for (const query of ['元資料.CSV', '数量\r\n部材']) {
    assert.deepEqual(reopened.list('example', query).conversations.map(row => row.id), [turn.conversationId]);
    assert.deepEqual(reopened.list('other', query).conversations, []);
  }
  assert.ok(reopened.list('example', oldRequest.prompt).conversations.some(row => row.id === oldTurn.conversationId));

  const followup = {...request, id: 'request-followup', conversationId: turn.conversationId, prompt: '続き'};
  assert.deepEqual(reopened.beginLive('example', followup).messages, [
    userMessage, {role: 'assistant', content: '資料を確認しました'}, {role: 'user', content: '続き'},
  ]);
  reopened.finishLive('example', followup.id, {status: 'completed', text: '続きを確認しました'});
  const interruptedDocument = {name: '中断資料.txt', text: '次の会話に出さない'};
  const interrupted = {...followup, id: 'interrupted-request', document: interruptedDocument};
  reopened.beginLive('example', interrupted);
  reopened.finishLive('example', interrupted.id, {status: 'interrupted', text: '途中'});
  const continued = reopened.beginLive('example', {...followup, id: 'after-interrupt'});
  assert.equal(continued.messages.length, 5);
  assert.equal(JSON.stringify(continued.messages).includes(interruptedDocument.text), false);
  const interruptedHistory = reopened.read('example', turn.conversationId, 4).conversation.messages;
  assert.deepEqual(interruptedHistory[0].document, interruptedDocument);
  assert.equal(interruptedHistory[1].text, '途中');
});

test('provider context omits an oversized prior attachment without altering saved history', async t => {
  const unit = await fixture(t);
  const store = unit.store();
  const document = {name: '大きい資料.txt', text: 'x'.repeat(16 * 1024)};
  const {turn} = store.beginLive('example', {...request, document});
  const reply = '応'.repeat(6000);
  store.finishLive('example', request.id, {status: 'completed', text: reply});
  const next = {id: 'request-bound', model: request.model, conversationId: turn.conversationId,
    prompt: '問'.repeat(12000), document: {name: '追加.txt', text: 'y'.repeat(16 * 1024)}};
  const {messages} = store.beginLive('example', next);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], {role: 'user', content: request.prompt});
  assert.equal(messages[1].role === 'assistant' && messages[1].content === reply, true, 'prior answer remains intact');
  assert.equal(messages[2].role, 'user');
  assert.ok(Array.isArray(messages[2].content));
  assert.deepEqual(messages[2].content.map(part => part.type), ['input_text', 'input_text']);
  assert.equal(messages[2].content[0].text === next.prompt, true, 'current prompt remains intact');
  assert.equal(messages[2].content[1].text === '添付資料（追加.txt）\n' + next.document.text, true, 'current attachment remains intact');
  assert.ok(messages.reduce((sum, {content}) => sum + (Array.isArray(content) ?
    content.reduce((length, part) => length + part.text.length, 0) : content.length), 0) <= chatInputLimit);
  assert.deepEqual(store.read('example', turn.conversationId, 0).conversation.messages[0].document, document);
});
