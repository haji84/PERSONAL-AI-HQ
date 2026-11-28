import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
const section = (first, next) => source.slice(source.indexOf(first), source.indexOf(next));
const composerSource = section('const stateLabels = ', 'const dom = ') +
  section('function projectList(', 'function artifactFilterScope(') + section('function planComposer(', 'function importSection(');
const previewSource = section('function handoffRecordLinks(', 'function chatCodexHandoff(') +
  section('async function verifiedCodexChatResult(', 'function codexTurnEvidence(');
const project = 'example';
const draftKey = 'chat-draft/example';
const prompt = '確認した結果について相談したい';
const stale = 'CODEX_RESULT_STALE';
const held = 'EXECUTION_HELD';
const settled = () => new Promise(setImmediate);
const digest = (value, name = '') => createHash('sha256').update(name).update(value).digest('hex');

function node(tag, _style, textContent = '') {
  return {tag, textContent, children: [], events: {}, hidden: false, isConnected: true, value: '', checked: false,
    append(...children) {
      this.children.push(...children);
      if (tag === 'select' && !this.value) this.value = this.children[0]?.value;
    },
    replaceChildren(...children) { this.children = children; },
    addEventListener(event, callback) { this.events[event] = callback; },
    setAttribute() {}, focus() {},
    get options() { return this.children; }};
}
const button = (label, click) => ({...node('button', '', label), click});
const descendants = root => [root, ...root.children.flatMap(descendants)];

function fixture() {
  const review = {threadId: 'work-thread', turnId: 'done', historyCursor: 'second-page'};
  const repository = 'https://github.com/owner/example';
  const original = 'a'.repeat(40);
  const progress = 'b'.repeat(40);
  const record = {
    requirements: {url: repository + '/blob/' + original + '/OWNER.md', revision: original, sha256: 'c'.repeat(64)},
    progress: {url: repository + '/blob/' + progress + '/DELIVERY.md', revision: progress, nextAction: '次の作業を照合する'},
  };
  const packet = {project: {id: project, record}, threadId: review.threadId, turnId: review.turnId,
    conversationId: 'chat-a', status: 'completed', artifacts: [], commands: [], files: []};
  const ui = {view: 'chat', project, capabilities: {chatgptPlan: true}, chatIds: new Map([[project, 'chat-a']]),
    attachmentDrafts: new Map(), chatIntents: new Map(), chatTurns: new Map(), drafts: new Map([[draftKey, prompt]])};
  const location = {hash: '#codex'};
  const requests = [];
  const selectedConversations = [];
  let providerResponse, previousTurn;
  const apiPath = (route, params) => ({route, params});
  const previewSelector = {value: review.turnId, selectedOptions: [{dataset: {status: 'completed', historyCursor: review.historyCursor}}]};
  const context = {project, location, previewSelector, workThread: review.threadId, node, button, ui, AbortSignal, AbortController,
    TextEncoder, textDocumentLimit: 16384, attachmentDigest: digest, apiPath, asArray: value => Array.isArray(value) ? value : [],
    text: (value, fallback) => value || fallback, link: (label, href) => ({...node('a', '', label), href}),
    chatStreams: new Map(), memoryKey: (area, id) => area + '/' + id, storeTab() {}, addDictation() {}, abortLocalDictation() {},
    runViewCleanups: new Set(), createCodexCamera: () => null, codexImageLimit: 512 * 1024,
    codexImageTypes: [], textDocumentExtensions: ['.json'],
    crypto: {randomUUID: () => 'unique-submit-id'}, onConversation: id => selectedConversations.push(id),
    panel() { const root = node('section'); const body = node('div'); root.append(body); return {root, body}; },
    async api(path) {
      if (path === '/api/chat/plan') return {status: 'connected'};
      if (path === '/api/chat/plan/models') return {models: [{slug: 'model', displayName: 'Model'}]};
      if (path.route === '/api/chat/live') return {turn: previousTurn};
      if (path.route === '/api/codex/chat-context') {
        const text = JSON.stringify(packet);
        return {threadId: review.threadId, turnId: review.turnId, codexReview: review,
          document: {name: 'codex-result.json', text}, sha256: digest(text),
          conversation: {id: 'chat-a', linked: false}, summary: {commands: 0, files: 0, artifacts: 0}};
      }
    },
    async requestOwner(_path, options) { requests.push(JSON.parse(options.body)); return providerResponse; },
    async chatEvents(response, handle) { for (const event of response.events) handle(event); },
  };
  return {preview: () => runInNewContext(previewSource +
    '\ncodexResultChatHandoff(project, workThread, previewSelector, () => true);', context),
  composer: () => runInNewContext(composerSource + '\nplanComposer(project, onConversation);', context),
  ui, packet, review, record, location, requests, selectedConversations, respond(response) { providerResponse = response; },
  acceptPrevious(turn) { previousTurn = turn; }};
}

test('a saved project stop disables ChatGPT send and retry while keeping receipt lookup and drafts', async () => {
  const view = fixture();
  view.ui.portfolio = {projects: [{id: project, state: 'paused', stateScope: '作業先の保存状態'}]};
  view.ui.chatTurns.set(project, 'earlier-id');
  view.acceptPrevious({id: 'earlier-id', status: 'completed', text: '保存済みの回答'});
  const composer = view.composer();
  await settled();
  const elements = descendants(composer.root);
  const send = elements.find(item => item.textContent === 'ChatGPTに送る');
  const retry = elements.find(item => item.textContent === '同じ受付番号を使う');
  const check = elements.find(item => item.textContent === '前の応答を確認');
  assert.equal(send.disabled, true);
  assert.equal(retry.disabled, true);
  assert.ok(elements.some(item => !item.hidden && /一時停止.*作業先の保存状態/.test(item.textContent)));
  send.click();
  retry.click();
  await check.click();
  assert.ok(elements.some(item => item.textContent === '保存済みの回答'));
  assert.deepEqual(view.requests, []);
  assert.equal(view.ui.drafts.get(draftKey), prompt);
});

test('a pre-receipt stop rejection leaves the draft and accepts a later new request', async () => {
  const view = fixture();
  view.respond({status: 409, ok: false, json: async () => ({
    code: 'EXECUTION_HELD', error: '案件の停止条件を確認してください。',
  })});
  const composer = view.composer();
  await settled();
  const send = descendants(composer.root).find(item => item.textContent === 'ChatGPTに送る');
  send.click();
  await settled();
  assert.equal(view.requests.length, 1);
  assert.equal(view.ui.chatIntents.has(project), false);
  assert.equal(view.ui.chatTurns.has(project), false);
  assert.equal(view.ui.drafts.get(draftKey), prompt);
  assert.equal(send.disabled, false);
});

test('a stop after ChatGPT receipt restores the prompt and keeps the attachment and receipt', async () => {
  const view = fixture();
  const id = 'unique-submit-id';
  const document = {name: 'context.txt', text: '相談する資料'};
  const attachment = {document, digest: digest(document.text, document.name)};
  view.ui.attachmentDrafts.set(draftKey, attachment);
  view.respond({status: 200, ok: true, events: [
    {type: 'started', turn: {id, status: 'in_progress'}},
    {type: 'done', code: held, turn: {id, status: 'failed', conversationId: 'live/rejected'}},
  ]});
  const composer = view.composer();
  await settled();
  const elements = descendants(composer.root);
  elements.find(item => item.textContent === 'ChatGPTに送る').click();
  await settled();
  assert.equal(view.requests.length, 1);
  assert.equal(view.ui.drafts.get(draftKey), prompt);
  assert.equal(elements.find(item => item.tag === 'textarea').value, prompt);
  assert.equal(view.ui.attachmentDrafts.get(draftKey), attachment);
  assert.equal(view.ui.chatIntents.has(project), false);
  assert.equal(view.ui.chatTurns.get(project), id);
  assert.equal(elements.find(item => item.textContent === '前の応答を確認').hidden, false);
  assert.deepEqual(view.selectedConversations, []);
  assert.ok(elements.some(item => /送信前.*受付/.test(item.textContent)));
});

test('readback of a saved pre-send stop restores a cleared draft and preserves a replacement attachment', async () => {
  const view = fixture();
  const id = 'saved-held';
  view.ui.drafts.delete(draftKey);
  view.ui.chatTurns.set(project, id);
  view.ui.chatIntents.set(project, {id, prompt, documentDigest: 'original'});
  const replacement = {document: {name: 'replacement.txt', text: '新しい資料'}, digest: 'new'};
  view.ui.attachmentDrafts.set(draftKey, replacement);
  view.acceptPrevious({id, status: 'failed', code: held, conversationId: 'live/rejected'});
  const composer = view.composer();
  await settled();
  const elements = descendants(composer.root);
  const check = elements.find(item => item.textContent === '前の応答を確認');
  await check.click();
  await check.click();
  assert.equal(view.ui.drafts.get(draftKey), prompt);
  assert.equal(elements.find(item => item.tag === 'textarea').value, prompt);
  assert.equal(view.ui.attachmentDrafts.get(draftKey), replacement);
  assert.equal(view.ui.chatIntents.has(project), false);
  assert.equal(view.ui.chatTurns.get(project), id);
  assert.equal(check.hidden, false);
  assert.deepEqual(view.selectedConversations, []);
  assert.deepEqual(view.requests, []);
  assert.ok(elements.some(item => /送信前.*受付/.test(item.textContent)));
});

test('result review presents pinned project links and stages the exact selected Codex evidence', async () => {
  const view = fixture();
  const preview = view.preview();
  const actions = descendants(preview.root);
  actions.find(item => item.textContent === 'チャットへ渡す内容を確認').click();
  await settled();
  assert.deepEqual(descendants(preview.root).filter(item => item.tag === 'a').map(item => item.href),
    [view.record.requirements.url, view.record.progress.url]);
  actions.find(item => item.textContent === '結果をチャットの下書きに添付').click();
  assert.deepEqual(view.ui.attachmentDrafts.get(draftKey)?.codexReview, view.review);
  assert.equal(view.location.hash, 'chat');

  view.ui.attachmentDrafts.clear();
  view.packet.conversationId = 'wrong-chat';
  actions.find(item => item.textContent === 'チャットへ渡す内容を確認').click();
  await settled();
  assert.equal(actions.find(item => item.textContent === '結果をチャットの下書きに添付').disabled, true);
});

test('readback after a lost event stream explains the held result and leaves the conversation in place', async () => {
  const view = fixture();
  const id = 'recovered-result';
  view.ui.chatTurns.set(project,id);
  view.ui.chatIntents.set(project,{id,prompt,codexResult:true,documentDigest:'existing'});
  const replacement = {document:{name:'new.txt',text:'Keep the new draft attachment'},digest:'replacement'};
  view.ui.attachmentDrafts.set(draftKey,replacement);
  view.acceptPrevious({id,status:'failed',code:stale,conversationId:'live/wrong'});
  const composer = view.composer();
  await settled();
  const elements = descendants(composer.root);
  elements.find(item=>item.textContent === '前の応答を確認').click();
  await settled();
  assert.equal(view.ui.drafts.get(draftKey),prompt);
  assert.equal(view.ui.chatIntents.has(project),false);
  assert.equal(view.ui.attachmentDrafts.get(draftKey),replacement);
  assert.deepEqual(view.selectedConversations,[]);
  assert.ok(elements.some(item=>/もう一度.*確認/.test(item.textContent)));
});

test('definite early and late rejections release the stale result and keep the user draft', async () => {
  for (const response of [
    {status: 409, ok: false, json: async () => ({code: stale, error: '照合結果が変わりました。'})},
    {status: 200, ok: true, events: [
      {type: 'started'},
      {type: 'done', code: stale, turn: {id: 'unique-submit-id', status: 'failed', conversationId: 'live/wrong'}},
    ]},
  ]) {
    const view = fixture();
    view.respond(response);
    const composer = view.composer();
    await settled();
    const text = JSON.stringify(view.packet);
    const document = {name: 'codex-result.json', text};
    assert.equal(composer.stageCodexResult({document, digest: digest(text, document.name),
      sourceConversationId: 'chat-a', codexReview: view.review}), true);
    const elements = descendants(composer.root);
    elements.find(item => item.textContent === 'ChatGPTに送る').click();
    await settled();
    assert.equal(view.requests.length, 1);
    assert.deepEqual(view.requests[0].codexReview, view.review);
    assert.equal(view.requests[0].conversationId, 'chat-a');
    assert.equal(view.ui.drafts.get(draftKey), prompt);
    assert.equal(elements.find(item => item.tag === 'textarea').value, prompt);
    assert.equal(view.ui.chatIntents.has(project), false);
    assert.equal(view.ui.attachmentDrafts.has(draftKey), false);
    assert.deepEqual(view.selectedConversations, []);
    assert.ok(elements.some(item => /もう一度.*確認/.test(item.textContent)));
  }
});
