const pages = {
  dashboard: 'ダッシュボード',
  chat: 'チャット',
  codex: 'Codex',
  artifacts: '成果物',
};
const stateLabels = {
  active: '稼働中', running: '稼働中', inprogress: '稼働中', 'in-progress': '稼働中',
  implementing: '開発中', development: '開発中', developing: '開発中', investigating: '調査中', researching: '調査中', designing: '設計中',
  testing: '検証中', verifying: '検証中', repairing: '修正中', fixing: '修正中', integrating: '統合中',
  complete: '完成', completed: '完成', done: '完成', succeeded: '成功',
  idle: '待機中', waiting: '待機中', paused: '一時停止', stopped: '停止中',
  archived: '停止中', legacy: '旧版', blocked: '障害停止', failed: '障害停止',
  delayed: '遅延中', approval: '承認待ち', 'approval-required': '承認待ち', 'awaiting-approval': '承認待ち',
  limit: '利用上限停止', 'quota-exceeded': '利用上限停止', offline: 'オフライン', online: 'オンライン',
  unknown: '状態未確認', interrupted: '中断', notloaded: '未読み込み',
};
const dom = {};
for (const id of [
  'gate', 'gate-title', 'gate-description', 'gate-retry', 'shell', 'navigation',
  'project-select', 'theme-button', 'page-title', 'page-summary', 'refresh-button', 'notice', 'content',
]) dom[id] = document.getElementById(id);
const prefsKey = 'personal-ai-hq/preferences/v1';
const tabKey = 'personal-ai-hq/tab/v1';

function readStorage(storage, key) {
  try { return JSON.parse(storage.getItem(key) ?? '{}') ?? {}; }
  catch { return {}; }
}
function writeStorage(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); }
  catch {}
}

const saved = readStorage(localStorage, prefsKey);
const savedTab = readStorage(sessionStorage, tabKey);
const view = () => {
  const name = location.hash.slice(1);
  return Object.hasOwn(pages, name) ? name : 'dashboard';
};
const ui = {
  view: view(), portfolio: null, capabilities: {},
  project: typeof saved.project === 'string' ? saved.project : '',
  theme: ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'system',
  chatIds: new Map(Object.entries(savedTab.chatIds ?? {})),
  threadIds: new Map(Object.entries(savedTab.threadIds ?? {})),
  options: new Map(Object.entries(saved.modelOptions ?? {})),
  scroll: new Map(Object.entries(savedTab.scroll ?? {})),
  drafts: new Map(Object.entries(savedTab.drafts ?? {})),
  searches: new Map(Object.entries(savedTab.searches ?? {})),
  runIntents: new Map(Object.entries(savedTab.runIntents ?? {})),
};
const resources = new Map();
const runStates = new Map();
let requestSequence = 0;
let mounted = 0;
let pendingScroll;
let stopRunView;

function storePreferences() {
  writeStorage(localStorage, prefsKey, {
    project: ui.project, theme: ui.theme, modelOptions: Object.fromEntries(ui.options),
  });
}
function storeTab() {
  writeStorage(sessionStorage, tabKey, {
    chatIds: Object.fromEntries(ui.chatIds), threadIds: Object.fromEntries(ui.threadIds),
    scroll: Object.fromEntries(ui.scroll), drafts: Object.fromEntries(ui.drafts),
    searches: Object.fromEntries(ui.searches),
    runIntents: Object.fromEntries(ui.runIntents),
  });
}
function node(tag, classes, text) {
  const element = document.createElement(tag);
  if (classes) element.className = classes;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}
function button(text, handler, secondary = true) {
  const element = node('button', secondary ? 'button secondary' : 'button', text);
  element.type = 'button';
  element.addEventListener('click', handler);
  return element;
}
function safeUrl(value, local = false) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value, location.origin);
    if (url.username || url.password) return null;
    if (local && url.origin === location.origin && value.startsWith('/') && !value.startsWith('//') &&
        url.pathname.startsWith('/api/artifact')) return url.href;
    return url.protocol === 'https:' && url.origin !== location.origin ? url.href : null;
  } catch { return null; }
}
function link(text, url, local = false, asButton = false) {
  const href = safeUrl(url, local);
  if (!href) return null;
  const element = node('a', asButton ? 'button secondary' : '', text);
  element.href = href;
  if (new URL(href).origin !== location.origin) {
    element.target = '_blank';
    element.rel = 'noopener noreferrer';
  }
  return element;
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function text(value, fallback = '不明') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}
function statusKey(value) {
  return text(value, 'unknown').toLowerCase().replaceAll('_', '-');
}
function statusLabel(value) {
  return stateLabels[statusKey(value)] ?? '状態未確認';
}
function chip(value, label = statusLabel(value)) {
  const status = statusKey(value);
  const positive = /^(active|running|in-?progress|developing|complete[d]?|done|succeeded|online)$/.test(status);
  const warning = /^(delayed|blocked|failed|approval|approval-required|awaiting-approval|offline|limit|quota-exceeded)$/.test(status);
  return node('span', 'chip' + (positive ? ' positive' : warning ? ' notice-chip' : ''), label);
}
const formatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function time(value) {
  if (value === null || value === undefined || value === '') return '不明';
  const date = new Date(typeof value === 'number' && Math.abs(value) < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? formatter.format(date) + ' JST' : '不明';
}
function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja');
}
function matches(query, ...values) {
  return values.some(value => normalize(value).includes(normalize(query.trim())));
}
function projectList() {
  return asArray(ui.portfolio?.projects);
}
function selectedProject() {
  return projectList().find(item => item.id === ui.project);
}
function routeKey(viewName = ui.view, project = ui.project) {
  return viewName + ':' + project;
}
function rememberScroll() {
  ui.scroll.set(routeKey(), scrollY);
  storeTab();
}
function restoreScroll() {
  const desired = pendingScroll;
  if (!desired) return;
  requestAnimationFrame(() => {
    if (pendingScroll !== desired || desired.epoch !== mounted) return;
    const allowed = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    window.scrollTo(0, Math.min(allowed, desired.y));
    if (allowed >= desired.y) pendingScroll = null;
  });
}
function selectProject(id, reveal = false) {
  if (id === ui.project || !projectList().some(item => item.id === id)) return;
  rememberScroll();
  ui.project = id;
  storePreferences();
  updateProjectSelect();
  render();
  if (reveal) requestAnimationFrame(() => document.getElementById('active-project')?.scrollIntoView({block: 'nearest'}));
}
function changeView() {
  const next = view();
  if (next === ui.view) return;
  rememberScroll();
  ui.view = next;
  render();
}
function setTheme() {
  document.documentElement.dataset.theme = ui.theme;
  const names = {system: '端末に合わせる', light: 'ライト', dark: 'ダーク'};
  const phrase = '表示テーマを切り替える（' + names[ui.theme] + '）';
  dom['theme-button'].setAttribute('aria-label', phrase);
  dom['theme-button'].title = phrase;
}
function setNotice(message = '', isError = false) {
  dom.notice.textContent = message;
  dom.notice.hidden = !message;
  dom.notice.classList.toggle('error', isError);
}
function gate(title, description, canRetry) {
  dom.shell.hidden = true;
  dom.gate.hidden = false;
  dom['gate-title'].textContent = title;
  dom['gate-description'].textContent = description;
  dom['gate-retry'].hidden = !canRetry;
}
function endSession() {
  stopRunView?.();
  resources.clear();
  ui.portfolio = null;
  dom.content.replaceChildren();
  gate('サインイン', 'この端末のサインイン用ファイルを開いてください。', true);
}
function apiPath(path, values = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return path + (query.size ? '?' + query : '');
}
const httpMessages = {
  400: 'データの形式を確認してください。',
  401: 'サインインの有効期限が切れました。',
  403: 'この操作を実行する権限がありません。',
  404: '選択したデータを読み込めませんでした。',
  409: '現在のCodex作業と競合しています。状況を確認してください。',
  413: 'ファイルは16 MiBまで取り込めます。',
  429: '取得が混み合っています。少し待ってから更新してください。',
  503: '接続先の現在の状態を確認できません。',
};
async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, {...options, credentials: 'same-origin', cache: 'no-store'}); }
  catch { throw new Error('通信できませんでした。接続してから更新してください。'); }
  if (response.status === 401) endSession();
  if (!response.ok) {
    const error = new Error(httpMessages[response.status] ?? '読み込みに失敗しました。');
    error.status = response.status;
    throw error;
  }
  try { return await response.json(); }
  catch { throw new Error('対応するデータを読み込めませんでした。'); }
}

function panel(name) {
  const root = node('section', 'panel');
  const header = node('div', 'panel-header');
  const body = node('div', 'panel-body');
  header.append(node('h2', '', name));
  root.append(header, body);
  return {root, header, body};
}
function listItem(child) {
  const row = node('li');
  row.append(child);
  return row;
}
function rowButton(primary, secondary, active, onClick, badge) {
  const target = button('', onClick);
  target.className = 'row-button';
  target.setAttribute('aria-pressed', String(active));
  const labels = node('span');
  labels.append(node('span', 'strong', primary));
  if (secondary) labels.append(node('span', 'muted small', secondary));
  target.append(labels);
  if (badge) target.append(badge);
  return target;
}
function queryInput(key, label, placeholder, onInput) {
  const field = node('input', 'search');
  field.type = 'search';
  field.setAttribute('aria-label', label);
  field.placeholder = placeholder;
  field.value = ui.searches.get(key) ?? '';
  field.addEventListener('input', () => {
    ui.searches.set(key, field.value);
    storeTab();
    onInput(field.value);
  });
  return field;
}
function updateProjectSelect() {
  const menu = dom['project-select'];
  menu.replaceChildren();
  const projects = projectList();
  if (!projects.length) {
    const option = node('option', '', 'プロジェクト未登録');
    option.value = '';
    menu.append(option);
    menu.disabled = true;
    ui.project = '';
    return;
  }
  if (!projects.some(item => item.id === ui.project)) ui.project = projects[0].id;
  for (const item of projects) {
    const option = node('option', '', text(item.name, item.id));
    option.value = item.id;
    menu.append(option);
  }
  menu.disabled = false;
  menu.value = ui.project;
  storePreferences();
}
function metric(list, label, value, percentage = false) {
  const row = node('dd', 'property-value');
  if (percentage && typeof value === 'number' && value >= 0 && value <= 100) {
    row.textContent = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 1}).format(value) + '%';
    const bar = node('progress', 'progress');
    bar.max = 100;
    bar.value = value;
    bar.setAttribute('aria-label', label);
    row.append(bar);
  } else row.textContent = text(value);
  list.append(node('dt', '', label), row);
}
function appendStrings(parent, values) {
  const clean = asArray(values).filter(value => typeof value === 'string' && value.length);
  if (!clean.length) return false;
  const list = node('ul', 'marked-list');
  for (const value of clean) list.append(node('li', '', value));
  parent.append(list);
  return true;
}
function sourceSection(parent, proof) {
  const list = node('ul', 'marked-list');
  for (const entry of asArray(proof)) {
    const label = text(entry?.label, '');
    if (label) list.append(listItem(link(label, entry?.url) ?? node('span', '', label)));
  }
  if (list.children.length) parent.append(node('h3', '', '確認した記録'), list);
}
function projectDetail() {
  const project = selectedProject();
  const detail = panel(project ? text(project.name) : 'プロジェクト詳細');
  detail.root.id = 'active-project';
  if (!project) {
    detail.body.append(node('p', 'muted', '取得できるプロジェクトがありません。'));
    return detail.root;
  }
  detail.header.append(chip(project.state));
  if (project.goal) detail.body.append(node('p', 'strong', project.goal));
  if (project.summary) detail.body.append(node('p', 'muted', project.summary));
  const facts = node('dl', 'properties');
  const m = project.measurements ?? {};
  metric(facts, '実装完成率', m.implementationCompletion, true);
  metric(facts, '正式な要求達成率', m.formalCompletion, true);
  metric(facts, '動作検証済み割合', m.verifiedCompletion, true);
  metric(facts, '実用完成率', m.usableCompletion, true);
  metric(facts, '完成予定', time(m.estimateFinish));
  metric(facts, '累計実作業時間', Number.isFinite(m.activeMinutes) ? m.activeMinutes + '分' : null);
  metric(facts, '情報の取得時刻', time(project.observedAt ?? ui.portfolio?.observedAt));
  detail.body.append(facts);
  if (asArray(project.remaining).length) {
    detail.body.append(node('h3', '', '確認・作業が残っている項目'));
    appendStrings(detail.body, project.remaining);
  }
  sourceSection(detail.body, project.evidence);
  const source = link('GitHubの正本を開く', project.repository);
  if (source) {
    detail.body.append(node('h3', '', '関連リポジトリ'), source);
  }
  return detail.root;
}
function dashboard() {
  const groups = [
    ['全プロジェクト', () => true],
    ['稼働中', value => ['active', 'running', 'inprogress', 'in-progress', 'developing'].includes(value)],
    ['停止中', value => ['stopped', 'paused', 'blocked', 'limit', 'quota-exceeded'].includes(value)],
    ['遅延中', value => value === 'delayed'],
    ['完成', value => ['complete', 'completed', 'done'].includes(value)],
    ['承認待ち', value => ['approval', 'approval-required', 'awaiting-approval'].includes(value)],
  ];
  const statistics = node('div', 'metrics');
  for (const [label, filter] of groups) {
    const stat = node('div', 'stat');
    const count = projectList().filter(item => filter(statusKey(item.state))).length;
    stat.append(node('strong', '', String(count)), node('span', '', label));
    statistics.append(stat);
  }
  const split = node('div', 'split');
  const left = node('div', 'stack');
  const right = node('div', 'stack');
  const projects = panel('プロジェクト');
  const list = node('ul', 'rows');
  const message = node('p', 'empty');
  const searchWrap = node('div', 'search-wrap');
  function filterProjects(query) {
    list.replaceChildren();
    const result = projectList().filter(item => matches(query, item.name, item.goal, item.summary));
    for (const item of result) {
      list.append(listItem(rowButton(text(item.name), item.summary ?? item.goal, item.id === ui.project,
        () => selectProject(item.id, matchMedia('(max-width: 870px)').matches), chip(item.state))));
    }
    message.hidden = result.length > 0;
    if (!message.hidden) message.textContent = query ? '一致するプロジェクトがありません。' : '取得できるプロジェクトがありません。';
  }
  const search = queryInput('dashboard', 'プロジェクトを検索', 'プロジェクトを検索', filterProjects);
  searchWrap.append(search);
  projects.body.remove();
  projects.root.append(searchWrap, message, list);
  filterProjects(search.value);
  left.append(projects.root);
  right.append(projectDetail());

  const devices = panel('実行端末');
  const rows = node('ul', 'rows');
  for (const device of asArray(ui.portfolio?.devices)) {
    const item = node('div', 'device-row');
    const block = node('span', 'strong', text(device.name));
    block.append(node('span', 'small muted', '観測 ' + time(device.observedAt)));
    item.append(block, chip(device.state, stateLabels[statusKey(device.state)] ?? text(device.state, '状態未確認')));
    rows.append(listItem(item));
  }
  if (rows.children.length) {
    devices.body.remove();
    devices.root.append(rows);
  } else devices.body.append(node('p', 'muted', '実行端末の状態を確認できません。'));
  right.append(devices.root);

  const recent = asArray(ui.portfolio?.artifacts).slice(0, 3);
  if (recent.length) {
    const artifactsPanel = panel('最近の成果物');
    const entries = node('ul', 'marked-list');
    for (const artifact of recent) {
      const anchor = link(text(artifact.title), artifact.href, true);
      entries.append(listItem(anchor ?? node('span', 'muted', text(artifact.title))));
    }
    artifactsPanel.body.append(entries);
    right.append(artifactsPanel.root);
  }
  split.append(left, right);
  dom.content.append(statistics, split);
  const limits = asArray(ui.portfolio?.limits);
  if (limits.length) {
    const findings = node('details', 'scope-info');
    findings.append(node('summary', '', '調査範囲と取得できなかった情報'));
    appendStrings(findings, limits);
    dom.content.append(findings);
  }
}

function fetchView(key, path, container, paint, isCurrent = () => true) {
  let entry = resources.get(key);
  if (!entry) {
    entry = {};
    resources.set(key, entry);
    if (resources.size > 60) resources.delete(resources.keys().next().value);
    entry.pending = api(path).then(value => { entry.value = value; }, error => { entry.error = error.message; })
      .finally(() => { entry.pending = null; });
  }
  function settle() {
    if (!container.isConnected || !isCurrent()) return;
    container.replaceChildren();
    if (entry.error) container.append(node('p', 'empty', entry.error));
    else paint(entry.value, container);
    restoreScroll();
  }
  if (entry.pending) {
    container.replaceChildren(node('p', 'empty', '読み込み中…'));
    void entry.pending.then(settle);
  } else {
    queueMicrotask(settle);
  }
}
function memoryKey(...parts) {
  return JSON.stringify(parts);
}
function messageBubble(item) {
  const user = item.role === 'user';
  const box = node('div', 'message' + (user ? ' user' : ''));
  const label = (user ? 'あなた' : 'AI') + (item.createdAt ? ' · ' + time(item.createdAt) : '');
  box.append(node('span', 'small muted strong', label), node('p', '', text(item.text, '')));
  return box;
}
function messagesInto(parent, items, onTop) {
  const payload = asArray(items).filter(item => ['user', 'assistant', 'agent'].includes(item?.role));
  const nodes = payload.map(messageBubble);
  if (onTop) parent.prepend(...nodes);
  else parent.append(...nodes);
  return nodes.length;
}
function importSection(project) {
  const box = node('div', 'import-box');
  const label = node('label', 'picker');
  label.append(node('span', '', 'ChatGPTの書き出し（conversations.json）'));
  const file = node('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  label.append(file);
  box.append(label);
  const start = button('選んだファイルを取り込む', async () => {
    const selected = file.files?.[0];
    if (!selected) {
      setNotice('取り込むJSONファイルを選んでください。', true);
      return;
    }
    if (selected.size > 16 * 1024 * 1024) {
      setNotice(httpMessages[413], true);
      return;
    }
    start.disabled = true;
    setNotice('会話を取り込んでいます。');
    try {
      const body = await selected.text();
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { throw new Error('ChatGPTの書き出しに含まれるJSONファイルを選んでください。'); }
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.conversations)) {
        throw new Error('会話一覧を含むJSONファイルを選んでください。');
      }
      await api(apiPath('/api/chat/import', {project}), {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body,
      });
      for (const key of resources.keys()) {
        const [kind, id] = JSON.parse(key);
        if (id === project && kind.startsWith('chat-')) resources.delete(key);
      }
      if (ui.view === 'chat' && ui.project === project) {
        const anchor = scrollY;
        render(false);
        scrollTo(0, anchor);
        setNotice('会話の取り込みが終わりました。');
      }
    } catch (error) {
      if (ui.view === 'chat' && ui.project === project) setNotice(error.message, true);
    } finally { start.disabled = false; }
  }, false);
  box.append(start);
  return box;
}
function chat() {
  const project = ui.project;
  if (!project) return emptyProject();
  const layout = node('div', 'split conversation-layout');
  const collection = panel('会話履歴');
  const thread = panel('会話');
  const readContainer = thread.body;
  const items = node('div');
  const searchWrap = node('div', 'search-wrap');
  let debounce;
  function showChatDetails() {
    const id = ui.chatIds.get(project);
    if (!id) {
      readContainer.replaceChildren(node('p', 'muted', '履歴から会話を選んでください。'));
      return;
    }
    const query = apiPath('/api/chat', {project, id, offset: 0});
    const key = memoryKey('chat-detail', project, id);
    fetchView(key, query, readContainer, (result, destination) => {
      const conversation = result?.conversation;
      if (!conversation) {
        destination.append(node('p', 'empty', '会話を読み込めませんでした。'));
        return;
      }
      thread.header.replaceChildren(node('h2', '', text(conversation.title, '会話')));
      const source = conversation.source === 'chatgpt-export' ? 'ChatGPTの書き出し' : text(conversation.source);
      destination.append(node('p', 'small muted', source + ' · 取り込み ' + time(conversation.importedAt)));
      const messages = node('div', 'messages messages-embedded');
      destination.append(messages);
      if (!messagesInto(messages, conversation.messages)) {
        messages.append(node('p', 'muted', '表示できる発言がありません。'));
      }
      let offset = result.nextOffset;
      const load = button('続きの発言を表示', async () => {
        load.disabled = true;
        try {
          const page = await api(apiPath('/api/chat', {project, id, offset}));
          if (!destination.isConnected || ui.chatIds.get(project) !== id) return;
          const added = asArray(page.conversation?.messages);
          messagesInto(messages, added);
          conversation.messages = [...asArray(conversation.messages), ...added];
          result.nextOffset = page.nextOffset;
          offset = page.nextOffset;
          load.hidden = !Number.isSafeInteger(offset);
          if (!load.hidden) messages.append(load);
        } catch (error) { setNotice(error.message, true); }
        finally { load.disabled = false; }
      });
      load.hidden = !Number.isSafeInteger(offset);
      messages.append(load);
    }, () => ui.chatIds.get(project) === id);
  }
  function searchChats(query) {
    const key = memoryKey('chat-index', project, query);
    const path = apiPath('/api/chat', {project, q: query});
    fetchView(key, path, items, (result, destination) => {
      const conversations = asArray(result?.conversations);
      if (!conversations.length) {
        destination.append(node('p', 'empty', query ? '一致する会話がありません。' : 'このプロジェクトの会話履歴はありません。'));
        if (!ui.chatIds.get(project)) showChatDetails();
        return;
      }
      if (!ui.chatIds.get(project) && !query) {
        ui.chatIds.set(project, conversations[0].id);
        storeTab();
        showChatDetails();
      }
      const rows = node('ul', 'rows');
      for (const conversation of conversations) {
        rows.append(listItem(rowButton(text(conversation.title, '無題の会話'),
          '取り込み ' + time(conversation.importedAt), ui.chatIds.get(project) === conversation.id, event => {
            ui.chatIds.set(project, conversation.id);
            storeTab();
            for (const row of rows.querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === event.currentTarget));
            showChatDetails();
          })));
      }
      destination.append(rows);
    }, () => search.value === query);
  }
  const search = queryInput(routeKey(), '会話を検索', 'タイトル・本文を検索', query => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (items.isConnected) searchChats(query); }, 180);
  });
  searchWrap.append(search);
  collection.body.remove();
  collection.root.append(searchWrap, items);
  if (ui.capabilities.chatImport === true) collection.root.append(importSection(project));
  layout.append(collection.root, thread.root);
  dom.content.append(layout);
  showChatDetails();
  searchChats(search.value);
}
const effortLabels = {
  minimal: '最小', low: '低', medium: '標準', high: '高', xhigh: '非常に高い', max: '最大', ultra: '最高',
};
const runPhases = {
  reserved: '受付済み',
  sending: 'Codexへ送信中',
  running: '実行中',
  interrupting: '中断を要求中',
  unconfirmed: '実行状態未確認',
  completed: 'Codexターン完了',
  interrupted: '中断済み',
  failed: '実行失敗',
};
const pollingPhases = new Set(['reserved', 'sending', 'running', 'interrupting', 'unconfirmed']);
const finishedPhases = new Set(['completed', 'interrupted', 'failed']);

function mountCodexRun(area, project, draft, draftKey, choices) {
  const run = runStates.get(project) ?? {operation: null, known: false, busy: false, checking: false, message: ''};
  runStates.set(project, run);
  const section = node('section', 'run-control');
  const caption = node('p', 'muted small', '指示は、このプロジェクト専用の分離作業先で実行されます。');
  const status = node('p', 'strong');
  status.setAttribute('role', 'status');
  const details = node('p', 'muted small');
  const warning = node('p', 'run-warning small');
  const output = node('pre', 'run-output');
  output.setAttribute('aria-label', 'Codexの実行中の出力');
  output.tabIndex = 0;
  const actions = node('div', 'run-actions');
  const send = button('分離作業先に送信', () => submitNew(), false);
  const resume = button('同じスレッドへ追加指示', () => submitNew(run.operation), true);
  const interrupt = button('中断を要求', async () => {
    if (run.busy || run.checking || !canInterrupt()) return;
    const id = run.operation.id;
    await mutate('/api/codex/interrupt', {id});
  }, true);
  const recover = button('同じ受付番号で再送', async () => {
    const intent = ui.runIntents.get(project);
    if (!run.busy && !run.checking && intent) await mutate('/api/codex/run', intent);
  }, true);
  const check = button('作業状態を確認', () => lookup(), true);
  actions.append(send, resume, interrupt, recover, check);
  section.append(node('h3', '', 'Codex操作'), caption, status, details, warning, actions, output);
  area.body.append(section);

  let timer;
  let disposed = false;
  function canInterrupt() {
    return run.known && ['running', 'interrupting', 'unconfirmed'].includes(run.operation?.phase) &&
      Boolean(run.operation.threadId && run.operation.turnId);
  }
  function hasRoom() {
    return run.known && !ui.runIntents.has(project) &&
      (!run.operation || finishedPhases.has(run.operation.phase));
  }
  function paint() {
    if (disposed || !section.isConnected) return;
    clearTimeout(timer);
    const phase = run.operation?.phase;
    const intention = ui.runIntents.get(project);
    status.textContent = run.busy && intention ? '受付を確認中…' :
      run.known ? runPhases[phase] ?? '実行記録なし' : run.checking ? '照合中…' : '実行状態未確認';
    const relevantOperation = !intention || intention.id === run.operation?.id ? run.operation : null;
    const timestamps = relevantOperation ? [
      '受付 ' + time(run.operation.createdAt),
      run.operation.startedAt ? '開始 ' + time(run.operation.startedAt) : '',
      run.operation.updatedAt ? '更新 ' + time(run.operation.updatedAt) : '',
    ].filter(Boolean) : [];
    details.textContent = timestamps.join(' · ');
    details.hidden = !timestamps.length;
    warning.textContent = run.message;
    warning.hidden = !run.message;
    send.hidden = !hasRoom();
    resume.hidden = !hasRoom() || !run.operation?.threadId || !run.operation?.turnId;
    resume.textContent = phase === 'interrupted' ? '中断した作業を再開' : '同じスレッドへ追加指示';
    interrupt.hidden = !canInterrupt();
    interrupt.textContent = phase === 'interrupting' ? '同じターンの中断を再要求' : '中断を要求';
    recover.hidden = !intention;
    for (const action of [send, resume, interrupt, recover, check]) action.disabled = run.busy || run.checking;
    const body = text(relevantOperation?.output, '');
    if (output.textContent !== body) {
      const atEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 20;
      output.textContent = body;
      if (atEnd) output.scrollTop = output.scrollHeight;
    }
    output.hidden = !body;
    if (run.clearDraft && draft.value.trim() === run.clearDraft) draft.value = '';
    run.clearDraft = '';
    if (run.known && pollingPhases.has(phase) && !run.busy && !run.checking) {
      timer = setTimeout(() => { if (section.isConnected) void lookup(); }, 1750);
    }
  }

  function accept(result, expected) {
    if (!result || !Object.hasOwn(result, 'operation')) throw new Error('作業状態を取得できませんでした。');
    const operation = result?.operation;
    if (operation && (operation.project !== project || !operation.id ||
      !Object.hasOwn(runPhases, operation.phase) || (expected && operation.id !== expected))) {
      throw new Error('対象の作業状態を照合できませんでした。');
    }
    if (operation) {
      const intent = ui.runIntents.get(project);
      if (intent?.id === operation.id) {
        ui.runIntents.delete(project);
        if (text(ui.drafts.get(draftKey), '').trim() === intent.prompt) {
          ui.drafts.delete(draftKey);
          run.clearDraft = intent.prompt;
        }
        storeTab();
      }
    }
    run.operation = operation ?? run.operation;
    run.known = Boolean(operation) || (!expected && !ui.runIntents.has(project));
    run.message = run.known ? '' : '受付を確認できません。再送する場合は同じ受付番号が使われます。';
  }

  async function lookup() {
    if (run.busy || run.checking || disposed) return;
    run.checking = true;
    run.onChange?.();
    const id = ui.runIntents.get(project)?.id ??
      (run.operation && !finishedPhases.has(run.operation.phase) ? run.operation.id : undefined);
    try {
      const response = await api(apiPath('/api/codex/run', {project, id}), {signal: AbortSignal.timeout(9000)});
      accept(response, id);
    } catch (error) {
      run.known = false;
      run.message = error.message;
    } finally {
      run.checking = false;
      run.onChange?.();
    }
  }

  async function mutate(path, payload) {
    if (run.busy || run.checking || disposed) return;
    run.busy = true;
    run.message = '';
    run.onChange?.();
    try {
      const result = await api(apiPath(path, {project}), {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12000),
      });
      if (!result?.operation) throw new Error('Codexの受付結果を照合できませんでした。');
      accept(result, payload.id);
    } catch (error) {
      if (path === '/api/codex/run' && [400, 403, 413].includes(error.status) &&
          ui.runIntents.get(project)?.id === payload.id) {
        ui.runIntents.delete(project);
        storeTab();
      }
      run.known = false;
      run.message = error.message + ' 作業状態を確認してください。';
    } finally {
      run.busy = false;
      run.onChange?.();
    }
  }

  function submitNew(previous) {
    if (run.busy || run.checking || !hasRoom()) return;
    const prompt = draft.value.trim() ||
      (previous?.phase === 'interrupted' ? 'このスレッドで中断した作業を再開してください。' : '');
    if (!prompt) {
      run.message = '送信する指示を下書きに入力してください。';
      paint();
      draft.focus();
      return;
    }
    const intent = {id: crypto.randomUUID(), prompt, ...choices()};
    if (previous) intent.resume = previous.id;
    ui.runIntents.set(project, intent);
    storeTab();
    void mutate('/api/codex/run', intent);
  }

  run.onChange = paint;
  stopRunView = () => {
    disposed = true;
    clearTimeout(timer);
    if (run.onChange === paint) run.onChange = null;
    stopRunView = null;
  };
  queueMicrotask(() => {
    if (section.isConnected) {
      paint();
      void lookup();
    }
  });
}

function modelSettings() {
  const project = ui.project;
  const canWrite = ui.capabilities.codexWrite === true && selectedProject()?.codexWrite === true;
  const area = panel('モデルと推論');
  const draftLabel = node('label', 'picker');
  draftLabel.append(node('span', '', '開発指示の下書き'));
  const draft = node('textarea', 'draft');
  draft.placeholder = '次の作業や確認したいことを書く';
  draft.maxLength = canWrite ? 16000 : 32000;
  const draftKey = memoryKey('codex-draft', project);
  draft.value = ui.drafts.get(draftKey) ?? '';
  draft.addEventListener('input', () => {
    ui.drafts.set(draftKey, draft.value);
    storeTab();
  });
  draftLabel.append(draft);
  const form = node('fieldset', 'model-pickers');
  area.body.append(form, node('h3', '', '下書き'), draftLabel);
  let runChoices = {};
  if (canWrite) mountCodexRun(area, project, draft, draftKey, () => runChoices);
  else {
    area.body.append(node('p', 'small muted draft-hint', '現在の接続では履歴を閲覧できます。下書きはこのタブに保存されます。'));
  }
  fetchView(memoryKey('models'), '/api/codex/models', form, (data, destination) => {
    const models = asArray(data?.data);
    if (!models.length) {
      const unavailable = node('p', 'muted', '利用可能なモデルを確認できません。');
      unavailable.className = 'muted model-status';
      destination.append(unavailable);
      return;
    }
    const model = node('select');
    const effort = node('select');
    const modelLabel = node('label', 'picker');
    const effortLabel = node('label', 'picker');
    modelLabel.append(node('span', '', 'モデル'), model);
    effortLabel.append(node('span', '', '推論レベル'), effort);
    const stored = ui.options.get(project) ?? {};
    for (const item of models) {
      const option = node('option', '', text(item.displayName, item.id));
      option.value = item.id;
      model.append(option);
    }
    model.value = models.find(item => item.id === stored.model)?.id ?? models.find(item => item.isDefault)?.id ?? models[0].id;
    function save({sendModel, sendEffort}) {
      ui.options.set(project, {model: model.value, effort: effort.value, sendModel, sendEffort});
      runChoices = {};
      if (sendModel && model.value) runChoices.model = model.value;
      if (sendEffort && effort.value) runChoices.effort = effort.value;
      storePreferences();
    }
    function populateEffort(modelChanged = false) {
      const entry = models.find(item => item.id === model.value);
      const values = asArray(entry?.reasoningEfforts).map(item => item.reasoningEffort).filter(item => typeof item === 'string');
      effort.replaceChildren();
      for (const item of values) {
        const option = node('option', '', effortLabels[item] ?? item);
        option.value = item;
        effort.append(option);
      }
      if (!values.length) {
        const option = node('option', '', '選択できません');
        option.value = '';
        effort.append(option);
      }
      const previous = ui.options.get(project);
      effort.disabled = !values.length;
      effort.value = previous?.model === model.value && values.includes(previous.effort) ? previous.effort :
        values.includes(entry?.defaultReasoningEffort) ? entry.defaultReasoningEffort : values[0] ?? '';
      const sameModel = previous?.model === model.value;
      save({sendModel: modelChanged || (sameModel && previous?.sendModel === true),
        sendEffort: sameModel && previous?.effort === effort.value && previous?.sendEffort === true});
    }
    model.addEventListener('change', () => populateEffort(true));
    effort.addEventListener('change', () => {
      const entry = models.find(item => item.id === model.value);
      save({sendModel: ui.options.get(project)?.sendModel === true || entry?.isDefault !== true, sendEffort: true});
    });
    populateEffort();
    destination.append(modelLabel, effortLabel);
  });
  return area.root;
}
function codex() {
  const project = ui.project;
  if (!project) return emptyProject();
  const layout = node('div', 'split conversation-layout');
  const collection = panel('スレッド');
  const thread = panel('スレッド詳細');
  const reading = thread.body;
  const items = node('div');
  const sidebar = node('div', 'stack');
  const current = node('div', 'stack');
  collection.body.remove();
  collection.root.append(items);
  sidebar.append(collection.root);
  current.append(thread.root, modelSettings());
  layout.append(sidebar, current);
  dom.content.append(layout);

  function showThread() {
    const id = ui.threadIds.get(project);
    if (!id) {
      thread.header.replaceChildren(node('h2', '', 'スレッド詳細'));
      reading.replaceChildren(node('p', 'muted', '一覧からスレッドを選んでください。'));
      return;
    }
    const path = apiPath('/api/codex/thread', {project, id});
    const key = memoryKey('codex-thread', project, id);
    fetchView(key, path, reading, (value, destination) => {
      if (ui.threadIds.get(project) !== id) return;
      const selected = value?.thread;
      thread.header.replaceChildren(node('h2', '', text(selected?.title, 'スレッド')), chip(selected?.status));
      destination.append(node('p', 'small muted', '更新 ' + time(selected?.updatedAt)));
      const messages = node('div', 'messages messages-embedded');
      destination.append(messages);
      function appendTurns(turns, prepend = false) {
        const rows = asArray(turns);
        const orderedMessages = rows.flatMap(turn => asArray(turn.messages));
        messagesInto(messages, orderedMessages, prepend);
        return rows.reduce((amount, turn) => amount + (Number.isInteger(turn.itemCount) ? turn.itemCount : 0), 0);
      }
      const itemCount = appendTurns(value?.turns);
      if (!messages.children.length) {
        messages.append(node('p', 'muted', itemCount ? 'このページに表示できる会話本文はありません。' : '表示できる発言がありません。'));
      }
      let cursor = value?.nextCursor;
      const more = button('以前のターンを表示', async () => {
        more.disabled = true;
        try {
          const page = await api(apiPath('/api/codex/thread', {project, id, cursor}));
          if (!destination.isConnected || ui.threadIds.get(project) !== id) return;
          const initialTop = messages.getBoundingClientRect().height;
          const added = asArray(page?.turns);
          appendTurns(added, true);
          value.turns = [...added, ...asArray(value.turns)];
          value.nextCursor = page?.nextCursor;
          cursor = page?.nextCursor;
          more.hidden = typeof cursor !== 'string' || !cursor;
          if (!more.hidden) messages.prepend(more);
          const growth = messages.getBoundingClientRect().height - initialTop;
          if (growth > 0) scrollBy(0, growth);
        } catch (error) { setNotice(error.message, true); }
        finally { more.disabled = false; }
      });
      more.hidden = typeof cursor !== 'string' || !cursor;
      messages.prepend(more);
    }, () => ui.threadIds.get(project) === id);
  }
  function showThreads(result, destination) {
    const threads = asArray(result?.data);
    if (!threads.length) {
      const detail = selectedProject()?.codexScopes ?
        'このプロジェクトのスレッドが見つかりません。' : 'このプロジェクトの端末・作業フォルダは未接続です。';
      destination.append(node('p', 'empty', detail));
      ui.threadIds.delete(project);
      storeTab();
      showThread();
      return;
    }
    if (!threads.some(item => item.id === ui.threadIds.get(project))) {
      ui.threadIds.set(project, threads[0].id);
      storeTab();
    }
    const rows = node('ul', 'rows');
    const seen = new Set();
    function addThreads(batch) {
      const added = [];
      for (const item of batch) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id);
        added.push(item);
        rows.append(listItem(rowButton(text(item.title, '無題のスレッド'), '更新 ' + time(item.updatedAt),
          ui.threadIds.get(project) === item.id, event => {
            ui.threadIds.set(project, item.id);
            storeTab();
            for (const row of rows.querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === event.currentTarget));
            showThread();
          }, chip(item.status))));
      }
      return added;
    }
    addThreads(threads);
    destination.append(rows);
    let cursor = result.nextCursor;
    const next = button('さらにスレッドを表示', async () => {
      next.disabled = true;
      try {
        const page = await api(apiPath('/api/codex/threads', {project, cursor}));
        if (!items.isConnected) return;
        const added = addThreads(asArray(page?.data));
        result.data = [...asArray(result.data), ...added];
        result.nextCursor = page.nextCursor !== cursor ? page.nextCursor : null;
        cursor = result.nextCursor;
        next.hidden = typeof cursor !== 'string' || !cursor;
      } catch (error) { setNotice(error.message, true); }
      finally { next.disabled = false; }
    });
    next.hidden = typeof cursor !== 'string' || !cursor;
    const pagination = node('div', 'pagination');
    pagination.append(next);
    destination.append(pagination);
    showThread();
  }
  fetchView(memoryKey('codex-index', project), apiPath('/api/codex/threads', {project}), items, showThreads);
  showThread();
}
function artifacts() {
  const all = asArray(ui.portfolio?.artifacts);
  const section = panel('確認済みの成果物');
  const scope = node('label', 'picker artifact-filter');
  const only = node('select');
  const every = node('option', '', 'すべてのプロジェクト');
  every.value = 'all';
  const one = node('option', '', selectedProject()?.name ?? '選択中のプロジェクト');
  one.value = 'project';
  only.append(every, one);
  only.disabled = !ui.project;
  only.value = ui.searches.get('artifact-filter') === 'project' && ui.project ? 'project' : 'all';
  only.setAttribute('aria-label', '成果物の表示対象');
  scope.append(only);
  section.header.append(scope);
  const list = node('ul', 'rows');
  const empty = node('p', 'empty');
  const searchWrap = node('div', 'search-wrap');
  function filter(query) {
    const visible = all.filter(item => (only.value !== 'project' || item.project === ui.project) &&
      matches(query, item.title, item.description, item.observedAt, time(item.observedAt),
        projectList().find(candidate => candidate.id === item.project)?.name));
    list.replaceChildren();
    for (const artifact of visible) {
      const item = node('div', 'artifact-row');
      const main = node('div');
      main.append(node('h3', '', text(artifact.title)));
      const project = projectList().find(candidate => candidate.id === artifact.project);
      main.append(node('p', 'muted small', (project?.name ?? 'プロジェクト不明') + ' · 確認 ' + time(artifact.observedAt)));
      if (artifact.description) main.append(node('p', '', artifact.description));
      item.append(main);
      const action = link(artifact.kind === 'file' ? '取得' : '開く', artifact.href, true, true);
      if (action) item.append(action);
      else item.append(chip('unknown', '取得先未確認'));
      list.append(listItem(item));
    }
    empty.hidden = visible.length > 0;
    empty.textContent = query ? '一致する成果物がありません。' : '表示できる確認済みの成果物はありません。';
  }
  const search = queryInput('artifact-search', '成果物を検索', '成果物を検索', filter);
  only.addEventListener('change', () => {
    ui.searches.set('artifact-filter', only.value);
    storeTab();
    filter(search.value);
  });
  searchWrap.append(search);
  section.body.remove();
  section.root.append(searchWrap, empty, list);
  dom.content.append(section.root);
  filter(search.value);
}
function emptyProject() {
  dom.content.append(node('p', 'empty panel', '上のプロジェクト欄から対象を選んでください。'));
}

const screens = {dashboard, chat, codex, artifacts};
function render(restore = true) {
  if (dom.shell.hidden) return;
  stopRunView?.();
  mounted++;
  const intended = ui.scroll.get(routeKey());
  pendingScroll = restore ? {epoch: mounted, y: Number.isFinite(intended) ? intended : 0} : null;
  setNotice();
  dom.content.replaceChildren();
  for (const anchor of dom.navigation.querySelectorAll('[data-view]')) {
    if (anchor.dataset.view === ui.view) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  const title = pages[ui.view];
  document.title = title + ' · Personal AI HQ';
  dom['page-title'].textContent = title;
  const summaries = {
    dashboard: '情報の取得時刻 ' + time(ui.portfolio?.observedAt),
    chat: 'プロジェクト別の会話履歴',
    codex: '端末から取得したスレッドと会話本文',
    artifacts: '確認された成果物を横断して検索',
  };
  dom['page-summary'].textContent = summaries[ui.view];
  screens[ui.view]();
  if (restore) restoreScroll();
}
async function refresh() {
  const id = ++requestSequence;
  dom['refresh-button'].disabled = true;
  const onPage = !dom.shell.hidden;
  if (onPage) setNotice('情報を取得しています。');
  try {
    const portfolio = await api('/api/portfolio');
    if (id !== requestSequence) return;
    if (onPage) rememberScroll();
    ui.portfolio = portfolio;
    resources.clear();
    updateProjectSelect();
    dom.gate.hidden = true;
    dom.shell.hidden = false;
    render();
  } catch (error) {
    if (id !== requestSequence) return;
    if (ui.portfolio) setNotice(error.message, true);
    else if (dom['gate-title'].textContent !== 'サインイン') gate('情報を取得できません', error.message, true);
  } finally {
    if (id === requestSequence) dom['refresh-button'].disabled = false;
  }
}
async function activate() {
  gate('接続を確認しています', '', false);
  try {
    const session = await api('/api/session');
    if (session?.authenticated !== true) {
      endSession();
      return;
    }
    ui.capabilities = session.capabilities ?? {};
    await refresh();
  } catch (error) {
    if (dom['gate-title'].textContent !== 'サインイン') gate('接続できません', error.message, true);
  }
}

dom['gate-retry'].addEventListener('click', activate);
dom['project-select'].addEventListener('change', event => selectProject(event.target.value));
dom['refresh-button'].addEventListener('click', refresh);
dom['theme-button'].addEventListener('click', () => {
  ui.theme = ui.theme === 'system' ? 'dark' : ui.theme === 'dark' ? 'light' : 'system';
  setTheme();
  storePreferences();
});
window.addEventListener('hashchange', changeView);
for (const input of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
  window.addEventListener(input, () => { pendingScroll = null; }, {passive: true});
}
window.addEventListener('pagehide', () => { if (!dom.shell.hidden) rememberScroll(); });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
setTheme();
void activate();
