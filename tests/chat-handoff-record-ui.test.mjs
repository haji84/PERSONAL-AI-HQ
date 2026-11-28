import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function handoffRecordLinks(');
const mount = source.indexOf('function chatCodexHandoff(');
const viewSource = source.slice(start < 0 ? mount : start, source.indexOf('async function chatEvents('));
const revision = 'a'.repeat(40);
const progressRevision = 'b'.repeat(40);
const docRepo = 'https://github.com/owner/authority';
const record = {
  requirements: {url: `${docRepo}/blob/${revision}/OWNER_REQUIREMENTS.md`, revision, sha256: 'c'.repeat(64)},
  progress: {url: `${docRepo}/blob/${progressRevision}/docs/DELIVERY.md`, revision: progressRevision, nextAction: '次の確認工程'},
};

function fixture(projectRecord, {sha = null, projects = {}, previous} = {}) {
  const messages = [{role: 'user', text: '確認する内容'}];
  const conversation = {id: 'conversation-1', importedAt: '2026-11-28T04:00:00Z', messages};
  const range = {start: 0, end: 1};
  const digest = (value, name = '') => createHash('sha256').update(name).update(value).digest('hex');
  const key = 'codex-draft/hq';
  const location = {hash: '#chat'};
  const ui = {capabilities: {codexWrite: true}, runIntents: new Map(), steerIntents: new Map(), attachmentDrafts: new Map()};
  if (previous) ui.attachmentDrafts.set(key, previous);
  function node(tag, classes, textContent = '') {
    return {tag, classes, textContent, children: [], listeners: {}, hidden: false, append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }, setAttribute() {},
      addEventListener(event, handler) { this.listeners[event] = handler; }};
  }
  const result = runInNewContext(viewSource + '\nchatCodexHandoff("hq", conversation, () => true, () => {}, () => {});', {
    node, location, ui, conversation, TextEncoder, File, URL, AbortSignal, connectionGeneration: 0, textDocumentLimit: 16384,
    button(label, click) { return {...node('button', '', label), click}; },
    link(label, href) { return {...node('a', '', label), href}; },
    directChatWork() { return {area: node('div'), paint() {}, activate() {}}; },
    memoryKey: (...parts) => parts.join('/'), chatDirectWorkKey: () => 'direct', selectedProject: () => ({codexWrite: true}),
    asArray: value => Array.isArray(value) ? value : [], attachmentDigest: digest, apiPath: (_, query) => query,
    api({viewSha256}) {
      const text = JSON.stringify({schemaVersion: 1, range, messages,
        project: {id: 'hq', repository: 'https://github.com/owner/main-work', ...projects, ...(projectRecord !== undefined && {record: projectRecord})},
        source: {id: conversation.id, observedAt: conversation.importedAt, viewSha256}});
      return {document: {name: 'chatgpt-handoff.json', text}, range, sha256: sha ?? digest(text), imageCount: 0};
    },
  });
  const descendants = item => [item, ...item.children.flatMap(descendants)];
  const find = (tag, label) => descendants(result).find(item => item.tag === tag && (label === undefined || item.textContent === label));
  return {ui, key, location, find, list: tag => descendants(result).filter(item => item.tag === tag), async review() {
    result.open = true;
    result.listeners.toggle();
    await new Promise(setImmediate);
  }};
}

test('the approved handoff presents the two pinned source links and next recorded action', async () => {
  const view = fixture(record);
  await view.review();
  assert.deepEqual(view.list('a').map(item => item.href), [record.requirements.url, record.progress.url]);
  assert.ok(view.find('p', record.progress.nextAction));
  assert.equal(view.find('button', 'Codexの下書きに添付').disabled, false);
  view.find('button', 'Codexの下書きに添付').click();
  assert.equal(view.ui.attachmentDrafts.get(view.key).chatHandoffConversationId, 'conversation-1');
  assert.equal(view.location.hash, 'codex');
});

test('the review rejects tampered or unpinned evidence but retains existing handoffs with no registered evidence', async () => {
  const elsewhere = {...record, progress: {...record.progress, url: record.progress.url.replace('/owner/authority/', '/owner/other/')}};
  const wrongRevision = {...record, progress: {...record.progress, url: `${docRepo}/blob/main/DELIVERY.md`}};
  for (const view of [fixture(elsewhere), fixture(wrongRevision), fixture(record, {sha: 'f'.repeat(64)}),
    fixture(record, {projects: {id: 'another-project'}})]) {
    await view.review();
    assert.equal(view.list('a').length, 0);
    assert.equal(view.find('button', 'Codexの下書きに添付').disabled, true);
  }
  const legacy = fixture(undefined);
  await legacy.review();
  assert.equal(legacy.list('a').length, 0);
  assert.equal(legacy.find('button', 'Codexの下書きに添付').disabled, false);
});

test('explicitly reviewing the original chat can replace only its own rejected handoff', async () => {
  const stale = {chatHandoffConversationId: 'conversation-1', needsChatHandoffReview: true};
  const view = fixture(record, {previous: stale});
  await view.review();
  view.find('button', 'Codexの添付を更新').click();
  assert.equal(view.ui.attachmentDrafts.get(view.key).needsChatHandoffReview, undefined);
  assert.equal(view.location.hash, 'codex');
  const another = {...stale, chatHandoffConversationId: 'another'};
  const blocked = fixture(record, {previous: another});
  await blocked.review();
  blocked.find('button', 'Codexの下書きに添付').click();
  assert.equal(blocked.ui.attachmentDrafts.get(blocked.key), another);
  assert.equal(blocked.location.hash, '#chat');
});
