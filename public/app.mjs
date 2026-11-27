const pages = {
  dashboard: 'ダッシュボード',
  chat: 'チャット',
  codex: 'Codex',
  artifacts: '成果物',
};
const workStageLabels = {consultation: '相談', design: '設計', implementation: '実装', test: 'テスト',
  verification: '実機検証', review: 'レビュー', delivery: '納品'};
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
  steerIntents: new Map(Object.entries(savedTab.steerIntents ?? {})),
  chatTurns: new Map(Object.entries(savedTab.chatTurns ?? {})),
  chatIntents: new Map(Object.entries(savedTab.chatIntents ?? {})),
};
const resources = new Map();
const runStates = new Map();
const runViewCleanups = new Set();
const chatStreams = new Map();
const activities = new Map();
const activityLabels = {
  reserved: '受付済み', sending: 'Codexへの送信を確認中', running: '実行中', interrupting: '中断を要求中',
  unconfirmed: '状態未確認', completed: 'ターン完了', interrupted: '中断済み', failed: '実行失敗',
};
let requestSequence = 0;
let mounted = 0;
let pendingScroll;
let activityTimer;
let activityPollRunning = false;
let activitySession;

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
    steerIntents: Object.fromEntries(ui.steerIntents),
    chatTurns: Object.fromEntries(ui.chatTurns),
    chatIntents: Object.fromEntries(ui.chatIntents),
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
function labeledSelect(label, options) {
  const field = node('label', 'picker');
  const input = node('select');
  input.setAttribute('aria-label', label);
  for (const [value, name] of Object.entries(options)) {
    const option = node('option', '', name);
    option.value = value;
    input.append(option);
  }
  field.append(node('span', '', label), input);
  return {field, input};
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
  if (next === 'dashboard') resources.delete(memoryKey('usage'));
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
  for (const stop of runViewCleanups) stop();
  clearTimeout(activityTimer);
  activities.clear();
  activitySession = undefined;
  resources.clear();
  ui.portfolio = null;
  dom.content.replaceChildren();
  gate('サインイン', 'この端末のサインイン用ファイルを開いてください。', true);
}
function activityPanel() {
  const section = node('section', 'stack');
  section.id = 'project-activity';
  section.hidden = true;
  return section;
}
function paintActivity() {
  const section = document.getElementById('project-activity');
  if (!section) return;
  const activity = activities.get(ui.project);
  if (!activity) {
    section.hidden = true;
    section.replaceChildren();
    return;
  }
  const status = node('p', 'small');
  const phase = !activity.terminal && Date.now() - Date.parse(activity.observedAt) > 30000 ? 'unconfirmed' : activity.phase;
  status.append(chip(phase, activityLabels[phase]),
    node('span', 'muted', '  最終確認 ' + time(activity.observedAt)));
  section.replaceChildren(node('h3', '', 'このアプリからのCodex実行'), status);
  section.hidden = false;
}
async function pollActivity() {
  if (ui.capabilities.executionActivity !== true || !ui.portfolio || !ui.project || activityPollRunning) return;
  clearTimeout(activityTimer);
  if (document.hidden) return;
  activityPollRunning = true;
  const session = activitySession ??= Symbol();
  const currentProject = ui.project;
  const selected = new Set([currentProject]);
  for (const [id, value] of activities) {
    if (value && !value.terminal && selected.size < 3 && projectList().some(project => project.id === id)) selected.add(id);
  }
  try {
    await Promise.allSettled([...selected].map(async project => {
      const previous = activities.get(project);
      let activity;
      try {
        ({activity} = await api(apiPath('/api/execution/activity', {project}), {signal: AbortSignal.timeout(6500)}));
      } catch {
        if (activitySession === session && previous && !previous.terminal) {
          activities.set(project, {...previous, phase: 'unconfirmed'});
        }
        return;
      }
      if (activitySession !== session || (activity !== null && (typeof activity?.id !== 'string' ||
          typeof activity.terminal !== 'boolean' || !Object.hasOwn(activityLabels, activity.phase)))) return;
      activities.set(project, activity);
      if (previous !== undefined && activity?.terminal &&
          (previous?.id !== activity.id || previous.phase !== activity.phase)) {
        const name = projectList().find(item => item.id === project)?.name;
        const messages = {completed: 'Codexのターンが完了しました。', interrupted: 'Codexの実行が中断されました。', failed: 'Codexの実行に失敗しました。'};
        if (name && messages[activity.phase]) setNotice(`${name} · ${messages[activity.phase]}`, activity.phase === 'failed');
      }
    }));
    paintActivity();
  } finally {
    activityPollRunning = false;
    if (activitySession === session && !document.hidden) {
      activityTimer = setTimeout(() => void pollActivity(), ui.project === currentProject ? 8000 : 0);
    }
  }
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
    const problem = await response.json().catch(() => null);
    const message = typeof problem?.error === 'string' && problem.error.length <= 240 ? problem.error : '';
    const error = new Error(message || httpMessages[response.status] || '読み込みに失敗しました。');
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
function executionSettings(project) {
  const details = node('details', 'scope-info');
  const content = node('div', 'stack');
  details.append(node('summary', '', '案件の実行経路'), content);
  const path = apiPath('/api/execution/settings', {project});
  const key = memoryKey('execution-settings', project);
  function mount() {
    fetchView(key, path, content, (initial, destination) => {
      let current = initial;
      const values = {'subscription-only': 'サブスク専用', 'api-only': 'API専用', auto: '自動選択', hybrid: '工程ごとに指定'};
      const routes = {subscription: 'サブスク', api: 'API'};
      const mode = labeledSelect('実行モード', values);
      const preference = labeledSelect('自動選択の優先順', {'subscription-first': 'サブスク優先', 'api-first': 'API優先', balanced: '実測をもとに選択'});
      const fallback = node('label', 'picker');
      const consent = node('input');
      consent.type = 'checkbox';
      fallback.append(consent, node('span', '', '自動選択時に許可済みの別経路を使う'));
      const budget = node('label', 'picker');
      const amount = node('input');
      amount.type = 'number';
      amount.min = '0';
      amount.step = '0.01';
      budget.append(node('span', '', 'API作業上限（USD）'), amount);
      const stages = node('div', 'stack');
      const choices = Object.entries(workStageLabels).map(([stage, label]) => {
        const entry = labeledSelect(label, {'': '未指定', ...routes});
        stages.append(entry.field);
        return [stage, entry.input];
      });
      const status = node('p', 'small muted');
      status.setAttribute('role', 'status');
      function fields() {
        preference.field.hidden = mode.input.value !== 'auto';
        fallback.hidden = preference.field.hidden;
        budget.hidden = mode.input.value === 'subscription-only';
        stages.hidden = mode.input.value !== 'hybrid';
      }
      function apply() {
        const s = current.settings;
        mode.input.value = s.mode;
        preference.input.value = s.preference;
        consent.checked = s.allowFallback === true;
        amount.value = s.apiBudgetUsd ?? '';
        for (const [stage, input] of choices) input.value = s.stageRoutes?.[stage] ?? '';
        fields();
      }
      mode.input.addEventListener('change', fields);
      const save = button('案件の実行設定を保存', async () => {
        if (!amount.validity.valid) { status.textContent = 'API作業上限を確認してください。'; return; }
        save.disabled = true;
        const chosen = mode.input.value;
        const settings = {mode: chosen, preference: preference.input.value, allowFallback: chosen === 'auto' && consent.checked,
          apiBudgetUsd: amount.value === '' ? null : Number(amount.value),
          stageRoutes: chosen === 'hybrid' ? Object.fromEntries(choices.filter(([, input]) => input.value)
            .map(([stage, input]) => [stage, input.value])) : {}};
        try {
          current = await api(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({revision: current.revision, settings})});
          resources.set(key, {value: current});
          apply();
          status.textContent = 'この案件の実行設定を保存しました。';
        } catch (error) { status.textContent = error.message; }
        finally { save.disabled = false; }
      }, false);
      destination.append(mode.field, preference.field, fallback, budget, stages,
        node('p', 'small muted', current.apiAvailable ? 'API実行経路を利用できます。' : 'API実行は認証と費用条件を確認できるまで待機します。'),
        save, status);
      apply();
    }, () => ui.view === 'dashboard' && ui.project === project);
  }
  details.addEventListener('toggle', () => { if (details.open && !content.hasChildNodes()) mount(); });
  return details;
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
  if (project.schedule?.originalDueAt) metric(facts, '当初の完成予定', time(project.schedule.originalDueAt));
  const remaining = project.schedule?.remainingMinutes;
  if (Number.isFinite(remaining?.standard)) {
    const minutes = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 1});
    metric(facts, '残りの目安', `${minutes.format(remaining.optimistic)}〜${minutes.format(remaining.cautious)}分（標準 ${minutes.format(remaining.standard)}分）`);
  }
  metric(facts, '累計実作業時間', Number.isFinite(m.activeMinutes) ? m.activeMinutes + '分' : null);
  metric(facts, '情報の取得時刻', time(project.observedAt ?? ui.portfolio?.observedAt));
  detail.body.append(facts);
  if (project.schedule?.delayed === true) detail.body.append(node('p', 'notice-chip chip', '当初予定に対して遅延しています'));
  if (ui.capabilities.executionActivity === true) detail.body.append(activityPanel());
  if (asArray(project.remaining).length) {
    detail.body.append(node('h3', '', '確認・作業が残っている項目'));
    appendStrings(detail.body, project.remaining);
  }
  sourceSection(detail.body, project.evidence);
  const source = link('GitHubの正本を開く', project.repository);
  if (source) {
    detail.body.append(node('h3', '', '関連リポジトリ'), source);
  }
  if (ui.capabilities.executionSettings === true) detail.body.append(executionSettings(project.id));
  return detail.root;
}
function usagePanel() {
  const area = panel('利用枠');
  const subscription = node('div', 'stack');
  area.body.append(node('h3', '', 'Codexの契約内利用枠'), subscription);
  fetchView(memoryKey('usage'), '/api/usage', subscription, (result, output) => {
    const observed = result?.subscription;
    const windows = asArray(observed?.windows);
    if (!windows.length) {
      output.append(node('p', 'small muted', 'この端末のCodexから利用枠を取得できません。'));
      return;
    }
    const facts = node('dl', 'properties');
    for (const entry of windows) {
      const duration = entry.durationMinutes;
      const label = Number.isFinite(duration) && duration > 0
        ? duration % 1440 === 0 ? `${duration / 1440}日枠` : duration % 60 === 0 ? `${duration / 60}時間枠` : `${duration}分枠`
        : entry.label === 'primary' ? '主な利用枠' : '追加の利用枠';
      if (Number.isFinite(entry.usedPercent)) metric(facts, label + 'の使用率', entry.usedPercent, true);
      if (entry.resetsAt) metric(facts, label + 'のリセット', time(entry.resetsAt));
    }
    if (observed.ordinaryUsageAllowed === false) output.append(node('p', 'small muted', 'Codexの通常利用は制限中です。'));
    output.append(facts, node('p', 'small muted', '観測 ' + time(observed.observedAt)));
  }, () => ui.view === 'dashboard');
  area.body.append(node('h3', '', '組織共通の別枠API特典'));
  const api = ui.portfolio?.apiCreditObservation;
  if (api) {
    const facts = node('dl', 'properties');
    const usd = new Intl.NumberFormat('ja-JP', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    metric(facts, '公式画面で確認した残高', `${usd.format(api.balanceUsd)} USD`);
    metric(facts, '付与分の期限', api.expiresOn);
    area.body.append(facts, node('p', 'small muted', `${time(api.observedFrom)}〜${time(api.observedUntil)}の確認値`));
  } else area.body.append(node('p', 'small muted', '公式画面での残高・期限の確認記録がありません。'));
  return area.root;
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
  right.append(projectDetail(), usagePanel());

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
function evictChats(project) {
  for (const key of resources.keys()) {
    const [kind, id] = JSON.parse(key);
    if (id === project && kind.startsWith('chat-')) resources.delete(key);
  }
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
function moveToDraft(project, kind, item, description) {
  if (ui.project !== project || !item?.text) return;
  const key = memoryKey(kind === 'codex' ? 'codex-draft' : 'chat-draft', project);
  const existing = ui.drafts.get(key) ?? '';
  const addition = existing ? `${existing}\n\n${description}\n${item.text}` : `${description}\n${item.text}`;
  if (addition.length > (kind === 'chat' ? 12000 : 16000)) {
    setNotice('下書きに追加できる長さを超えています。必要な部分を選んでください。', true);
    return;
  }
  ui.drafts.set(key, addition);
  storeTab();
  location.hash = kind;
}

async function chatEvents(response, visit) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      if (buffer.length > 1024 * 1024) throw new Error('応答が大きすぎます。');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('data: ')) visit(JSON.parse(frame.slice(6)));
      }
    }
  } finally { reader.releaseLock(); }
}

function planComposer(project, onConversation) {
  const area = panel('ChatGPTに相談');
  const status = node('p', 'muted small', 'ChatGPTプランの状態を確認中…');
  status.setAttribute('role', 'status');
  const picks = node('div', 'stack');
  const modelLabel = node('label', 'picker');
  const model = node('select');
  model.setAttribute('aria-label', 'ChatGPTのモデル');
  modelLabel.append(node('span', '', 'モデル'), model);
  const draftLabel = node('label', 'picker');
  const draft = node('textarea', 'draft');
  const draftKey = memoryKey('chat-draft', project);
  draft.placeholder = '相談内容や開発したいことを書く';
  draft.maxLength = 12000;
  draft.value = ui.drafts.get(draftKey) ?? '';
  draft.addEventListener('input', () => { ui.drafts.set(draftKey, draft.value); storeTab(); });
  draftLabel.append(node('span', '', 'メッセージ'), draft);
  const referenceLabel = node('label', 'picker');
  const reference = node('input');
  reference.type = 'checkbox';
  referenceLabel.append(reference, node('span', '', '選択中の会話から最近の発言を引き継ぐ'));
  const output = node('pre', 'run-output');
  output.setAttribute('aria-label', 'ChatGPTの応答');
  output.tabIndex = 0;
  const actions = node('div', 'run-actions');
  const send = button('ChatGPTに送る', () => sendMessage(), false);
  const stop = button('応答を中断', () => chatStreams.get(project)?.controller?.abort());
  const check = button('前の応答を確認', () => readPrevious());
  const retry = button('同じ受付番号を使う', () => submitIntent());
  const discard = button('保留中の受付を閉じる', () => {
    ui.chatIntents.delete(project);
    storeTab();
    status.textContent = '画面の保留を閉じました。保存された応答は履歴に残ります。';
    controls();
  });
  const signIn = button('ChatGPTでサインイン', async () => {
    signIn.disabled = true;
    try {
      const result = await api('/api/chat/plan/authorize', {method: 'POST'});
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://auth.openai.com') throw new Error('公式の認証先を確認できません。');
      location.assign(url.href);
    } catch (error) { status.textContent = error.message; signIn.disabled = false; }
  });
  actions.append(send, stop, check, retry, discard);
  picks.append(modelLabel, referenceLabel, draftLabel, actions, output);
  area.body.append(status, signIn, picks);
  signIn.hidden = true;
  picks.hidden = true;
  output.hidden = true;
  let canSend = false;

  const phaseText = {
    in_progress: 'ChatGPTが応答中です。', completed: '応答をこの案件の履歴に保存しました。',
    aborted: '応答を中断し、取得済みの部分を保存しました。', interrupted: '応答が途切れ、取得済みの部分を保存しました。',
    incomplete: '応答が完了せず、取得済みの部分を保存しました。', failed: '応答を確認できませんでした。接続と利用枠を確認してください。',
  };
  function controls() {
    const active = chatStreams.get(project)?.controller;
    const pending = ui.chatIntents.get(project);
    send.disabled = !canSend || Boolean(active) || Boolean(pending);
    stop.hidden = !active;
    check.hidden = !ui.chatTurns.has(project) || Boolean(active);
    retry.hidden = !pending || Boolean(active);
    discard.hidden = retry.hidden;
    output.hidden = !output.textContent;
  }
  function showTurn(turn, selectConversation = true) {
    if (!turn) { status.textContent = 'この受付番号の応答はまだ確認できません。'; return; }
    status.textContent = phaseText[turn.status] ?? '応答の状態を確認できません。';
    output.textContent = typeof turn.text === 'string' ? turn.text : '';
    const terminal = turn.status !== 'in_progress' && Object.hasOwn(phaseText, turn.status);
    if (terminal && ui.chatIntents.get(project)?.id === turn.id) {
      ui.chatIntents.delete(project);
      storeTab();
    }
    if (selectConversation && turn.conversationId && terminal) {
      reference.checked = true;
      onConversation(turn.conversationId);
    }
  }
  async function readPrevious() {
    const id = ui.chatTurns.get(project);
    if (!id) return;
    try { showTurn((await api(apiPath('/api/chat/live', {project, id}))).turn); }
    catch (error) { status.textContent = error.message; }
    controls();
  }
  function sendMessage() {
    const prompt = draft.value.trim();
    if (send.disabled || !prompt || !model.value) {
      if (!prompt) status.textContent = '相談する内容を入力してください。';
      return;
    }
    const id = crypto.randomUUID();
    const conversationId = reference.checked ? ui.chatIds.get(project) : undefined;
    ui.chatIntents.set(project, {id, conversationId, model: model.value, prompt});
    ui.chatTurns.set(project, id);
    storeTab();
    void submitIntent();
  }
  async function submitIntent() {
    const intent = ui.chatIntents.get(project);
    if (!intent || !canSend || chatStreams.has(project)) return;
    const controller = new AbortController();
    const selected = ui.chatIds.get(project);
    chatStreams.set(project, {controller});
    output.textContent = '';
    status.textContent = 'ChatGPTに送っています…';
    controls();
    try {
      const response = await fetch(apiPath('/api/chat/live', {project}), {method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(intent),
        signal: controller.signal});
      if (response.status === 401) endSession();
      if (!response.ok) {
        const message = (await response.json().catch(() => null))?.error;
        throw new Error(text(message, httpMessages[response.status] ?? '応答を開始できませんでした。'));
      }
      let done = false;
      await chatEvents(response, event => {
        if (event.type === 'started') {
          status.textContent = phaseText.in_progress;
          if (ui.drafts.get(draftKey)?.trim() === intent.prompt || draft.value.trim() === intent.prompt) {
            ui.drafts.delete(draftKey);
            draft.value = '';
            storeTab();
          }
        } else if (event.type === 'delta' && typeof event.text === 'string') {
          output.textContent += event.text;
          controls();
        } else if (event.type === 'done') {
          done = true;
          showTurn(event.turn, ui.chatIds.get(project) === selected);
        }
      });
      if (!done) status.textContent = '応答が途切れました。前の応答を確認してください。';
    } catch (error) {
      status.textContent = controller.signal.aborted ? '中断を要求しました。前の応答を確認できます。' : error.message;
    } finally {
      chatStreams.delete(project);
      controls();
    }
  }
  void (async () => {
    try {
      const account = await api('/api/chat/plan');
      if (!['connected', 'refresh_required'].includes(account.status)) {
        status.textContent = account.status === 'storage_unavailable' ? 'この端末でChatGPTプランの認証を保存できません。' :
          'ChatGPTプランで相談するには、このアプリの利用を承認してください。';
        signIn.hidden = account.status === 'storage_unavailable';
        return;
      }
      const {models} = await api('/api/chat/plan/models');
      for (const entry of asArray(models)) {
        const option = node('option', '', entry.displayName);
        option.value = entry.slug;
        model.append(option);
      }
      canSend = model.options.length > 0;
      status.textContent = canSend ? ui.chatIntents.has(project) ? '前の応答の受付を確認できます。' : 'ChatGPTプランに接続しています。' :
        'このアカウントの利用可能なモデルを確認できません。';
      picks.hidden = !canSend;
      controls();
    } catch (error) {
      status.textContent = error.status === 403 ? 'このアプリで使うChatGPTプランを再認証してください。' : error.message;
      if (error.status === 403) { signIn.textContent = 'ChatGPTで再認証'; signIn.hidden = false; }
    }
  })();
  return area.root;
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
      evictChats(project);
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
      const live = conversation.source === 'chatgpt-live';
      const source = live ? 'ChatGPTプラン · 開始 ' : 'ChatGPTの書き出し · 取り込み ';
      destination.append(node('p', 'small muted', source + time(conversation.importedAt)));
      const messages = node('div', 'messages messages-embedded');
      destination.append(messages);
      if (!messagesInto(messages, conversation.messages)) {
        messages.append(node('p', 'muted', '表示できる発言がありません。'));
      }
      let offset = result.nextOffset;
      const transfer = button('表示中のAI回答をCodexの下書きに追加', () => {
        const recent = asArray(conversation.messages).findLast(message => message.role === 'assistant');
        moveToDraft(project, 'codex', recent, 'この案件でのChatGPTの回答');
      });
      function updateTransfer() {
        transfer.hidden = !asArray(conversation.messages).some(message => message.role === 'assistant' && message.text);
      }
      const load = button('続きの発言を表示', async () => {
        load.disabled = true;
        try {
          const page = await api(apiPath('/api/chat', {project, id, offset}));
          if (!destination.isConnected || ui.chatIds.get(project) !== id) return;
          const added = asArray(page.conversation?.messages);
          messagesInto(messages, added);
          conversation.messages = [...asArray(conversation.messages), ...added];
          updateTransfer();
          result.nextOffset = page.nextOffset;
          offset = page.nextOffset;
          load.hidden = !Number.isSafeInteger(offset);
          if (!load.hidden) messages.append(load);
        } catch (error) { setNotice(error.message, true); }
        finally { load.disabled = false; }
      });
      load.hidden = !Number.isSafeInteger(offset);
      messages.append(load);
      updateTransfer();
      destination.append(transfer);
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
          (conversation.source === 'chatgpt-live' ? 'ChatGPTプラン · ' : '取り込み ') + time(conversation.importedAt),
          ui.chatIds.get(project) === conversation.id, event => {
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
  const current = node('div', 'stack');
  current.append(thread.root);
  if (ui.capabilities.chatgptPlan === true) current.append(planComposer(project, id => {
    if (ui.view !== 'chat' || ui.project !== project || !layout.isConnected) return;
    ui.chatIds.set(project, id);
    storeTab();
    evictChats(project);
    showChatDetails();
    searchChats(search.value);
  }));
  layout.append(collection.root, current);
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

const apiWorkMessages = {
  API_AUTHORIZATION_REQUIRED: 'この端末の通常API認証を確認できません。',
  API_AUTHORITY_MISSING: '本人が確認したAPIの組織・費用設定がありません。',
  API_AUTHORITY_UNSAFE: '通常APIの設定ファイルの所有権とアクセス権を確認してください。',
  API_AUTHORITY_UNBOUND: '通常APIを許可する組織の予算管理先を確認できません。',
  API_AUTHORITY_CHANGED: 'この作業の実行許可または対象ファイルの設定が変わりました。',
  API_CREDIT_UNVERIFIED: '追加費用ゼロの条件と有効な組織残高の確認が必要です。',
  API_WORKSPACE_NOT_ENROLLED: 'この案件のAPI用分離作業先を確認できません。',
  ROUTE_NOT_ALLOWED: '案件設定で通常APIを選択できる状態にしてください。',
  EXECUTION_HELD: '案件の停止条件を確認してください。',
  API_CANDIDATE_HANDOVER_REQUIRED: '前回の検証済み成果物と今回の作業先を照合してください。',
  API_SETTLEMENT_UNKNOWN: 'API応答と費用が未確認です。同じ作業の追加実行は保留中です。',
  API_VERIFICATION_FAILED: '隔離環境の検証を通過しませんでした。',
  API_WORKSPACE_FAILED: '分離作業先または検証条件を確認してください。',
  API_OUTPUT_UNUSABLE: 'API応答から適用可能な変更を確認できませんでした。',
  API_NO_WORKSPACE_CHANGE: '検証対象に変更がありませんでした。',
  INTERRUPTED: 'API作業を中断しました。',
};

function mountCodexRun(area, project, draft, draftKey, choices, apiReady) {
  const apiMode = Boolean(apiReady);
  const runKey = apiMode ? memoryKey('api-work', project) : project;
  const path = apiMode ? '/api/execution/api' : '/api/codex/run';
  const run = runStates.get(runKey) ?? {operation: null, known: false, busy: false, checking: false, message: ''};
  runStates.set(runKey, run);
  const section = node('section', 'run-control');
  const caption = node('p', 'muted small', apiMode ? '許可済みのファイルを分離作業先で編集し、テストを実行します。'
    : '指示は、このプロジェクト専用の分離作業先で実行されます。');
  const status = node('p', 'strong');
  status.setAttribute('role', 'status');
  const details = node('p', 'muted small');
  const warning = node('p', 'run-warning small');
  const steeringStatus = node('p', 'muted small');
  steeringStatus.setAttribute('role', 'status');
  const output = node('pre', 'run-output');
  output.setAttribute('aria-label', apiMode ? 'API作業の検証結果' : 'Codexの実行中の出力');
  output.tabIndex = 0;
  const artifacts = node('ul', 'marked-list');
  const actions = node('div', 'run-actions');
  const send = button(apiMode ? '通常APIで開発を開始' : '分離作業先に送信', () => submitNew(), false);
  const resume = button('同じスレッドへ追加指示', () => submitNew(run.operation), true);
  const interrupt = button('中断を要求', async () => {
    if (run.busy || run.checking || !canInterrupt()) return;
    const id = run.operation.id;
    await mutate(apiMode ? `${path}/interrupt` : '/api/codex/interrupt', {id});
  }, true);
  const steer = button('実行中のターンに追加指示', () => sendSteering(), true);
  const checkSteer = button('追加指示の状態を照合', () => requestSteering(false), true);
  const closeSteer = button('この確認を閉じる', () => {
    ui.steerIntents.delete(project);
    storeTab();
    run.steerMessage = '';
    paint();
  });
  const recover = button('同じ受付番号で再送', async () => {
    const intent = ui.runIntents.get(runKey);
    if (!run.busy && !run.checking && intent) await mutate(path, intent);
  }, true);
  const check = button('作業状態を確認', () => lookup(), true);
  actions.append(send, resume, steer, interrupt, recover, check, checkSteer, closeSteer);
  section.append(node('h3', '', apiMode ? '通常APIの開発操作' : 'Codex操作'), caption, status, details, warning,
    steeringStatus, actions, output, artifacts);
  area.body.append(section);

  let timer;
  let disposed = false;
  function canInterrupt() {
    if (apiMode) return run.known && ['reserved', 'running', 'interrupting'].includes(run.operation?.phase);
    return run.known && ['running', 'interrupting', 'unconfirmed'].includes(run.operation?.phase) &&
      Boolean(run.operation.threadId && run.operation.turnId);
  }
  function hasRoom() {
    return run.known && (!apiMode || apiReady()?.available === true) && !ui.runIntents.has(runKey) &&
      (!run.operation || finishedPhases.has(run.operation.phase));
  }
  function paint() {
    if (disposed || !section.isConnected) return;
    clearTimeout(timer);
    const phase = run.operation?.phase;
    const intention = ui.runIntents.get(runKey);
    status.textContent = run.busy && intention ? '受付を確認中…' :
      run.known ? apiMode && phase === 'completed' ? '成果物の検証完了' : runPhases[phase] ?? '実行記録なし'
        : run.checking ? '照合中…' : '実行状態未確認';
    const relevantOperation = !intention || intention.id === run.operation?.id ? run.operation : null;
    const timestamps = relevantOperation ? [
      '受付 ' + time(run.operation.createdAt),
      run.operation.startedAt ? '開始 ' + time(run.operation.startedAt) : '',
      run.operation.updatedAt ? '更新 ' + time(run.operation.updatedAt) : '',
    ].filter(Boolean) : [];
    details.textContent = timestamps.join(' · ');
    details.hidden = !timestamps.length;
    const apiNotice = apiMode && (apiWorkMessages[relevantOperation?.result] ||
      (apiReady() && !apiReady().available && (apiWorkMessages[apiReady().reason] || '通常APIの実行条件を確認できません。')));
    warning.textContent = run.message || apiNotice || '';
    warning.hidden = !warning.textContent;
    const pendingSteering = apiMode ? null : ui.steerIntents.get(project);
    steeringStatus.textContent = run.steerMessage || (pendingSteering ? '追加指示の受付を照合できます。' : '');
    steeringStatus.hidden = apiMode || !steeringStatus.textContent;
    send.hidden = !hasRoom();
    resume.hidden = apiMode || !hasRoom() || !run.operation?.threadId || !run.operation?.turnId;
    resume.textContent = phase === 'interrupted' ? '中断した作業を再開' : '同じスレッドへ追加指示';
    interrupt.hidden = !canInterrupt();
    interrupt.textContent = !apiMode && phase === 'interrupting' ? '同じターンの中断を再要求' : '中断を要求';
    steer.hidden = apiMode || !run.known || phase !== 'running' || !run.operation?.turnId || Boolean(pendingSteering);
    checkSteer.hidden = !pendingSteering;
    closeSteer.hidden = !pendingSteering || !run.known || !finishedPhases.has(phase);
    recover.hidden = !intention;
    for (const action of [send, resume, steer, interrupt, recover, check, checkSteer, closeSteer]) {
      action.disabled = run.busy || run.checking;
    }
    const body = text(apiMode ? relevantOperation?.verification?.output : relevantOperation?.output, '');
    if (output.textContent !== body) {
      const atEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 20;
      output.textContent = body;
      if (atEnd) output.scrollTop = output.scrollHeight;
    }
    output.hidden = !body;
    const changes = apiMode && phase === 'completed' ? asArray(relevantOperation?.changes) : [];
    artifacts.replaceChildren(...changes.map((change, index) => {
      const anchor = node('a', '', `検証済み ${text(change.path, '成果物')}`);
      anchor.href = apiPath(`${path}/artifact`, {project, id: relevantOperation.id, index});
      anchor.download = '';
      return listItem(anchor);
    }));
    artifacts.hidden = !changes.length;
    if (run.clearDraft && draft.value.trim() === run.clearDraft) draft.value = '';
    run.clearDraft = '';
    if (run.known && pollingPhases.has(phase) && !(apiMode && phase === 'unconfirmed') && !run.busy && !run.checking) {
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
      const intent = ui.runIntents.get(runKey);
      if (intent?.id === operation.id) {
        ui.runIntents.delete(runKey);
        if (text(ui.drafts.get(draftKey), '').trim() === intent.prompt) {
          ui.drafts.delete(draftKey);
          run.clearDraft = intent.prompt;
        }
        storeTab();
      }
    }
    run.operation = operation ?? run.operation;
    run.known = Boolean(operation) || (!expected && !ui.runIntents.has(runKey));
    run.message = run.known ? '' : '受付を確認できません。再送する場合は同じ受付番号が使われます。';
  }

  async function lookup() {
    if (run.busy || run.checking || disposed) return;
    run.checking = true;
    run.onChange?.();
    const id = ui.runIntents.get(runKey)?.id ??
      (run.operation && !finishedPhases.has(run.operation.phase) ? run.operation.id : undefined);
    try {
      const response = await api(apiPath(path, {project, id}), {signal: AbortSignal.timeout(9000)});
      accept(response, id);
    } catch (error) {
      run.known = false;
      run.message = error.message;
    } finally {
      run.checking = false;
      run.onChange?.();
    }
  }

  async function mutate(endpoint, payload) {
    if (run.busy || run.checking || disposed) return;
    run.busy = true;
    run.message = '';
    run.onChange?.();
    try {
      const result = await api(apiPath(endpoint, {project}), {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12000),
      });
      if (!result?.operation) throw new Error('作業の受付結果を照合できませんでした。');
      accept(result, payload.id);
    } catch (error) {
      const confirmedRejection = [400, 403, 413].includes(error.status) || apiMode && error.status === 409;
      if (endpoint === path && confirmedRejection && ui.runIntents.get(runKey)?.id === payload.id) {
        ui.runIntents.delete(runKey);
        storeTab();
      }
      run.known = apiMode && confirmedRejection;
      run.message = error.message + ' 作業状態を確認してください。';
    } finally {
      run.busy = false;
      run.onChange?.();
    }
  }

  async function requestSteering(submit) {
    const intent = ui.steerIntents.get(project);
    if (!intent || run.busy || run.checking || disposed) return;
    run.busy = true;
    run.steerMessage = '追加指示の受付を照合中…';
    paint();
    try {
      const path = apiPath('/api/codex/steer', {project, id: submit ? undefined : intent.id});
      const options = submit ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(intent)} : {};
      const {steering} = await api(path, {...options, signal: AbortSignal.timeout(14000)});
      const matchesIntent = steering?.id === intent.id && steering.project === project && steering.operationId === intent.operationId;
      if (matchesIntent && steering.phase === 'accepted') {
        ui.steerIntents.delete(project);
        if (draft.value.trim() === intent.prompt) {
          ui.drafts.delete(draftKey);
          draft.value = '';
        }
        storeTab();
        run.steerMessage = '実行中の同じターンで追加指示が受理されました。';
      } else if (matchesIntent && steering.phase === 'rejected') {
        ui.steerIntents.delete(project);
        storeTab();
        run.steerMessage = '元のターンの状態が変わったため、追加指示を送信しませんでした。';
      } else run.steerMessage = '追加指示の受理をまだ確認できません。作業状態を照合できます。';
    } catch (error) {
      if (submit && [400, 403, 409, 413].includes(error.status)) {
        ui.steerIntents.delete(project);
        storeTab();
      }
      run.steerMessage = error.message;
    } finally {
      run.busy = false;
      run.onChange?.();
    }
  }

  function sendSteering() {
    if (steer.hidden || run.busy || run.checking) return;
    const prompt = draft.value.trim();
    if (!prompt) {
      run.steerMessage = '追加する指示を下書きに入力してください。';
      paint();
      draft.focus();
      return;
    }
    ui.steerIntents.set(project, {id: crypto.randomUUID(), operationId: run.operation.id, prompt});
    storeTab();
    void requestSteering(true);
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
    ui.runIntents.set(runKey, intent);
    storeTab();
    void mutate(path, intent);
  }

  run.onChange = paint;
  const cleanup = () => {
    disposed = true;
    clearTimeout(timer);
    if (run.onChange === paint) run.onChange = null;
    runViewCleanups.delete(cleanup);
  };
  runViewCleanups.add(cleanup);
  queueMicrotask(() => {
    if (section.isConnected) {
      paint();
      void lookup();
    }
  });
  return paint;
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
  if (canWrite) {
    const details = node('details', 'scope-info');
    const fields = node('div', 'stack');
    const route = labeledSelect('作業別の利用経路', {'': '案件設定を使う', subscription: 'サブスク',
      ...(ui.capabilities.apiDevelopment !== true ? {api: 'API'} : {})});
    const stage = labeledSelect('作業の工程', {'': '標準設定を使う', ...workStageLabels});
    fields.append(route.field, stage.field);
    details.append(node('summary', '', 'この作業の経路を指定'), fields);
    if (ui.capabilities.executionSettings === true) area.body.append(details);
    mountCodexRun(area, project, draft, draftKey, () => ({...runChoices,
      ...(route.input.value ? {route: route.input.value} : {}), ...(stage.input.value ? {stage: stage.input.value} : {})}));
  }
  else if (ui.capabilities.apiDevelopment !== true) {
    area.body.append(node('p', 'small muted draft-hint', '現在の接続では履歴を閲覧できます。下書きはこのタブに保存されます。'));
  }
  if (ui.capabilities.apiDevelopment === true) {
    const options = node('fieldset', 'model-pickers');
    const stage = labeledSelect('通常APIの工程', {implementation: '実装', ...workStageLabels});
    const model = labeledSelect('通常APIのモデル', {'': '案件設定を使う'});
    const effort = labeledSelect('通常APIの推論レベル', {'': '案件設定を使う'});
    options.append(stage.field, model.field, effort.field);
    area.body.append(options);
    let capability;
    const paint = mountCodexRun(area, project, draft, draftKey, () => ({stage: stage.input.value,
      ...(model.input.value ? {model: model.input.value} : {}), ...(effort.input.value ? {effort: effort.input.value} : {})}), () => capability);
    options.hidden = true;
    void api(apiPath('/api/execution/api/capabilities', {project})).then(value => {
      if (!area.root.isConnected) return;
      capability = value;
      options.hidden = !value.available;
      for (const item of asArray(value.models)) {
        const option = node('option', '', item.id);
        option.value = item.id;
        model.input.append(option);
      }
      function populate() {
        effort.input.replaceChildren(node('option', '', '案件設定を使う'));
        effort.input.firstChild.value = '';
        const entry = asArray(value.models).find(item => item.id === (model.input.value || value.defaultModel));
        for (const code of asArray(entry?.reasoningEfforts)) {
          const option = node('option', '', effortLabels[code] ?? code);
          option.value = code;
          effort.input.append(option);
        }
      }
      model.input.addEventListener('change', populate);
      populate();
      paint();
    }).catch(() => {
      capability = {available: false, reason: 'API_AUTHORIZATION_REQUIRED'};
      paint();
    });
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
      if (ui.capabilities.chatgptPlan === true) {
        const recent = asArray(value?.turns).flatMap(turn => asArray(turn.messages)).findLast(message => message.role === 'assistant');
        if (recent?.text) destination.append(button('Codexの回答をチャットの下書きに追加', () => {
          moveToDraft(project, 'chat', recent, 'この案件でのCodexの回答');
        }));
      }
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
  for (const stop of runViewCleanups) stop();
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
  paintActivity();
  void pollActivity();
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollActivity(); });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
setTheme();
void activate();
