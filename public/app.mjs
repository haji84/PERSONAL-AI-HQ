import {abortLocalDictation, createLocalDictation} from './dictation.mjs';
import {createCodexCamera} from './codex-camera.mjs';
import {openRealtimeAudio} from './realtime-audio.mjs';

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
  'gate', 'gate-title', 'gate-description', 'gate-retry', 'gate-tailnet', 'gate-code', 'gate-connect', 'shell', 'navigation',
  'project-select', 'theme-button', 'page-title', 'page-summary', 'chat-development-toggle', 'refresh-button', 'notice', 'content',
  'connection-status', 'connection-message', 'connection-retry',
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
const chatDevelopmentWidth = window.matchMedia('(min-width: 1160px)');
const view = () => {
  const name = location.hash.slice(1);
  return Object.hasOwn(pages, name) ? name : 'dashboard';
};
const ui = {
  view: view(), portfolio: null, capabilities: {},
  project: typeof saved.project === 'string' ? saved.project : '',
  theme: ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : 'system',
  showChatDevelopment: savedTab.showChatDevelopment === true,
  chatIds: new Map(Object.entries(savedTab.chatIds ?? {})),
  threadIds: new Map(Object.entries(savedTab.threadIds ?? {})),
  options: new Map(Object.entries(saved.modelOptions ?? {})),
  scroll: new Map(Object.entries(savedTab.scroll ?? {})),
  drafts: new Map(Object.entries(savedTab.drafts ?? {})),
  attachmentDrafts: new Map(),
  searches: new Map(Object.entries(savedTab.searches ?? {})),
  runIntents: new Map(Object.entries(savedTab.runIntents ?? {})),
  steerIntents: new Map(Object.entries(savedTab.steerIntents ?? {})),
  chatTurns: new Map(Object.entries(savedTab.chatTurns ?? {})),
  realtimeTurns: new Map(Object.entries(savedTab.realtimeTurns ?? {})),
  chatIntents: new Map(Object.entries(savedTab.chatIntents ?? {})),
  registrationIntents: new Map(Object.entries(savedTab.registrationIntents ?? {})),
};
const resources = new Map();
const registrationFlights = new Map();
const runStates = new Map();
const runViewCleanups = new Set();
const chatStreams = new Map();
const activities = new Map();
const nativeActivities = new Map();
const nativeNotices = new Map();
const dashboardExecutionGenerations = new WeakMap();
const activityLabels = {
  reserved: '受付済み', sending: 'Codexへの送信を確認中', running: '実行中', interrupting: '中断を要求中', cancelling: '中止を照合中',
  unconfirmed: '状態未確認', completed: 'ターン完了', interrupted: '中断済み', cancelled: '中止済み', failed: '実行失敗',
};
const nativeActivityLabels = {
  running: '稼働中', approval: '承認待ち', input: '入力待ち', 'approval-and-input': '承認・入力待ち',
};
const nativeOutcomeLabels = {completed: '完了', failed: '失敗', interrupted: '中断'};
const codexRecordId = /^[a-z0-9_-]{1,160}$/i;
const nativeWatchLimit = 3;
const nativeWatchAge = 60000;
const chatSourceLabels = {'chatgpt-export': 'ChatGPTの書き出し', 'chatgpt-live': 'ChatGPTプラン',
  'api-development': '通常APIの開発', 'openai-realtime': '音声会話（通常API）', 'codex-history': 'Codex'};
let requestSequence = 0;
let portfolioPollRunning = false;
let dashboardExecutionVersion = 0;
let mounted = 0;
let pendingScroll;
let activityTimer;
let activityPollRunning = false;
let activitySession;
let activeSpeech;
let connectionState = 'connected';
let connectionGeneration = 0;

function storePreferences() {
  writeStorage(localStorage, prefsKey, {
    project: ui.project, theme: ui.theme, modelOptions: Object.fromEntries(ui.options),
  });
}
function storeTab() {
  writeStorage(sessionStorage, tabKey, {
    showChatDevelopment: ui.showChatDevelopment,
    chatIds: Object.fromEntries(ui.chatIds), threadIds: Object.fromEntries(ui.threadIds),
    scroll: Object.fromEntries(ui.scroll), drafts: Object.fromEntries(ui.drafts),
    searches: Object.fromEntries(ui.searches),
    runIntents: Object.fromEntries(ui.runIntents),
    steerIntents: Object.fromEntries(ui.steerIntents),
    chatTurns: Object.fromEntries(ui.chatTurns),
    realtimeTurns: Object.fromEntries(ui.realtimeTurns),
    chatIntents: Object.fromEntries(ui.chatIntents),
    registrationIntents: Object.fromEntries(ui.registrationIntents),
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
  if (next === 'dashboard') void refreshVisibleDashboard();
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
const connectionMessages = {
  offline: 'このブラウザーはオフラインです。表示中の情報は前回取得したものです。',
  unreachable: 'アプリとの通信を確認できません。表示中の情報は前回取得したものです。',
  checking: 'アプリへの再接続を確認しています。',
};
let appHostObservation;
function paintAppHostConnection(indicator = document.getElementById('app-host-connection')) {
  if (!indicator) return;
  const connected = connectionState === 'connected' && appHostObservation?.generation === connectionGeneration &&
    performance.now() - appHostObservation.receivedAt < 60000;
  indicator.textContent = connected ? '応答あり' : '応答未確認';
  indicator.classList.toggle('positive', connected);
}
function forgetAppHostObservation() {
  appHostObservation = undefined;
  paintAppHostConnection();
}
function showConnection(state) {
  if (connectionState === state) return;
  connectionState = state;
  connectionGeneration++;
  const status = dom['connection-status'];
  const retry = dom['connection-retry'];
  dom['connection-message'].textContent = connectionMessages[state] ?? '';
  retry.disabled = state !== 'unreachable';
  status.classList.toggle('error', state === 'offline' || state === 'unreachable');
  if (state !== 'connected' && state !== 'checking') {
    for (const [project, activity] of activities) {
      if (activity && !activity.terminal && activity.phase !== 'cancelling') {
        activities.set(project, {...activity, phase: 'unconfirmed'});
      }
    }
    for (const [project, snapshot] of nativeActivities) {
      if (snapshot.status === 'observed') nativeActivities.set(project, {...snapshot, status: 'unavailable'});
    }
    paintActivity();
    repaintDashboardExecutions();
  }
  if (state === 'connected' && document.activeElement === retry) dom['refresh-button'].focus({preventScroll: true});
  status.hidden = state === 'connected';
  paintAppHostConnection();
}
function gate(title, description, canRetry) {
  dom.shell.hidden = true;
  dom.gate.hidden = false;
  dom['gate-title'].textContent = title;
  dom['gate-description'].textContent = description;
  dom['gate-tailnet'].hidden = true;
  dom['gate-retry'].hidden = !canRetry;
}
function endSession() {
  requestSequence++;
  connectionGeneration++;
  abortLocalDictation();
  stopSpeech();
  for (const stop of runViewCleanups) stop();
  clearTimeout(activityTimer);
  activities.clear();
  nativeActivities.clear();
  nativeNotices.clear();
  activitySession = undefined;
  resources.clear();
  ui.attachmentDrafts.clear();
  ui.portfolio = null;
  appHostObservation = undefined;
  dom.content.replaceChildren();
  syncChatDevelopment();
  if (ui.capabilities.tailnetSignIn === true) {
    gate('遠隔サインイン', 'ホスト端末のダッシュボードで発行した接続コードを入力してください。', false);
    dom['gate-tailnet'].hidden = false;
  } else gate('サインイン', 'この端末のサインイン用ファイルを開いてください。', true);
}
function activityPanel() {
  const group = node('div', 'stack');
  const local = node('section', 'stack');
  local.id = 'project-activity';
  local.hidden = true;
  const native = node('section', 'stack');
  native.id = 'native-codex-activity';
  native.hidden = true;
  native.append(node('h3', '', '接続先Codexの稼働'), node('p', 'small muted'), node('ul', 'rows'));
  group.append(local, native);
  return group;
}
function paintNativeActivity() {
  const section = document.getElementById('native-codex-activity');
  if (!section) return;
  const project = ui.project;
  const snapshot = nativeActivities.get(project);
  section.hidden = !snapshot;
  if (!snapshot) return;
  const info = section.querySelector('p');
  const list = section.querySelector('ul');
  const current = connectionState === 'connected' && snapshot.status === 'observed' && performance.now() - snapshot.receivedAt <= 30000;
  const rows = current ? snapshot.live : [];
  const scopes = current ? [
    rows.length ? '接続先で稼働中のスレッドを' + rows.length + '件確認' : '稼働中と確認できたスレッドは0件',
    snapshot.unconfirmed ? snapshot.unconfirmed + '件は状態未確認' : '',
    snapshot.truncated ? '直近の一覧の一部' : '',
  ].filter(Boolean) : [snapshot.status === 'unconfigured' ? '稼働を確認できるCodex接続が未設定です。' : '現在の稼働状態を確認できません。'];
  if (snapshot.observedAt) scopes.push((current ? '確認 ' : '前回確認 ') + time(snapshot.observedAt));
  if (snapshot.lastOutcome) {
    const {title, phase, endedAt} = snapshot.lastOutcome;
    scopes.push(title + ' ' + nativeOutcomeLabels[phase] + (endedAt ? ' ' + time(endedAt) : ''));
  }
  const summary = scopes.join(' · ');
  if (info.textContent !== summary) info.textContent = summary;
  const signature = JSON.stringify(rows.map(row => [row.id, row.title, row.phase, row.subagent, row.role]));
  if (list.dataset.snapshot === signature) return;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.nativeThread : null;
  list.dataset.snapshot = signature;
  list.hidden = rows.length === 0;
  list.replaceChildren(...rows.map(row => {
    const role = row.subagent ? text(row.role, 'サブエージェント') : '';
    const select = rowButton(row.title, role, false, () => {
      if (ui.project !== project) return;
      ui.threadIds.set(project, row.id);
      storeTab();
      location.hash = 'codex';
    }, chip(row.phase === 'approval-and-input' ? 'approval' : row.phase, nativeActivityLabels[row.phase]));
    select.removeAttribute('aria-pressed');
    select.dataset.nativeThread = row.id;
    if (row.id === focused) queueMicrotask(() => select.isConnected && select.focus({preventScroll: true}));
    return listItem(select);
  }));
}
function recordNativeActivity(project, result, watched, trackNewTurns) {
  const previous = nativeActivities.get(project);
  if (!['observed', 'unconfigured', 'unavailable'].includes(result?.status) ||
      (result.status === 'observed' && (!Number.isFinite(Date.parse(result.observedAt)) ||
        !Array.isArray(result.live) || result.live.some(row => typeof row?.id !== 'string' ||
          !codexRecordId.test(row.id) || typeof row.title !== 'string' || !Object.hasOwn(nativeActivityLabels, row.phase))))) {
    result = {status: 'unavailable'};
  }
  if (result.status === 'unconfigured') {
    nativeActivities.set(project, {status: result.status});
    return;
  }
  if (result.status !== 'observed') {
    nativeActivities.set(project, {...previous, status: result.status, watched});
    return;
  }
  const receivedAt = performance.now();
  for (const [key, expires] of nativeNotices) if (expires <= receivedAt) nativeNotices.delete(key);
  const expires = receivedAt + nativeWatchAge;
  let lastOutcome = previous?.lastOutcome;
  const completed = [];
  for (const outcome of asArray(result.transitions)) {
    const key = outcome?.id + ':' + outcome?.turnId;
    if (!watched.has(key) || !Object.hasOwn(nativeOutcomeLabels, outcome.phase) || typeof outcome.title !== 'string') continue;
    watched.delete(key);
    lastOutcome = outcome;
    if (!nativeNotices.has(key)) completed.push(outcome);
    nativeNotices.set(key, expires);
  }
  for (const row of result.live) {
    if (typeof row.turnId !== 'string' || !codexRecordId.test(row.turnId)) continue;
    const key = row.id + ':' + row.turnId;
    if (!nativeNotices.has(key) && (watched.has(key) || (trackNewTurns && watched.size < nativeWatchLimit))) watched.set(key, expires);
  }
  nativeActivities.set(project, {...result, receivedAt, watched, lastOutcome});
  const name = projectList().find(item => item.id === project)?.name;
  if (name && completed.length) {
    const outcomes = completed.map(item => item.title + 'が' + nativeOutcomeLabels[item.phase] + 'しました').join(' / ');
    setNotice(name + ' · Codex ' + outcomes, completed.some(item => item.phase === 'failed'));
  }
}
function paintActivity() {
  paintNativeActivity();
  const section = document.getElementById('project-activity');
  if (!section) return;
  const activity = activities.get(ui.project);
  if (!activity) {
    section.hidden = true;
    section.replaceChildren();
    return;
  }
  const status = node('p', 'small');
  const stale = !activity.terminal && activity.phase !== 'cancelling' &&
    (connectionState !== 'connected' || Date.now() - Date.parse(activity.observedAt) > 30000);
  const phase = stale ? 'unconfirmed' : activity.phase;
  status.append(chip(phase, activityLabels[phase]),
    node('span', 'muted', '  最終確認 ' + time(activity.observedAt)));
  const route = activity.kind === 'api' ? '通常API' : 'Codex';
  section.replaceChildren(node('h3', '', `このアプリからの${route}実行`), status);
  const details = [text(activity.model, ''), workStageLabels[activity.stage]].filter(Boolean);
  if (details.length) section.append(node('p', 'small muted', details.join(' · ')));
  section.hidden = false;
}
async function pollActivity() {
  if (ui.capabilities.executionActivity !== true || !ui.portfolio || !ui.project || activityPollRunning) return;
  clearTimeout(activityTimer);
  if (document.hidden || connectionState === 'offline' || connectionState === 'checking') return;
  activityPollRunning = true;
  const session = activitySession ??= Symbol();
  const generation = connectionGeneration;
  const isCurrent = () => activitySession === session && generation === connectionGeneration;
  const currentProject = ui.project;
  const selected = new Set(selectedProject()?.registration === 'github' ? [] : [currentProject]);
  const now = performance.now();
  for (const project of projectList()) {
    const local = activities.get(project.id);
    const watched = nativeActivities.get(project.id)?.watched;
    if (selected.size < 3 && ((local && !local.terminal) || [...(watched?.values() ?? [])].some(expires => expires > now))) {
      selected.add(project.id);
    }
  }
  try {
    await Promise.allSettled([...selected].map(async project => {
      const previous = activities.get(project);
      const watched = new Map([...(nativeActivities.get(project)?.watched ?? [])].filter(([, expires]) => expires > now));
      const trackNewTurns = watched.size > 0 || (project === currentProject && ui.view === 'dashboard');
      const observeNative = trackNewTurns || (project === currentProject && document.getElementById('chat-development')?.hidden === false);
      let activity;
      let observedNative;
      try {
        const path = apiPath('/api/execution/activity', {project, native: observeNative ? 1 : undefined});
        const params = new URLSearchParams();
        for (const key of watched.keys()) params.append('watch', key);
        ({activity, nativeActivity: observedNative} = await api(params.size ? path + '&' + params : path, {signal: AbortSignal.timeout(6500)}));
      } catch {
        if (isCurrent()) {
          if (previous && !previous.terminal && previous.phase !== 'cancelling') {
            activities.set(project, {...previous, phase: 'unconfirmed'});
          }
          if (observeNative) recordNativeActivity(project, null, watched, trackNewTurns);
        }
        return;
      }
      if (!isCurrent() || (activity !== null && (typeof activity?.id !== 'string' ||
          typeof activity.terminal !== 'boolean' || !Object.hasOwn(activityLabels, activity.phase)))) return;
      activities.set(project, activity);
      if (observeNative) recordNativeActivity(project, observedNative, watched, trackNewTurns);
      if (activity?.kind === 'api' && (previous?.id !== activity.id || previous.phase !== activity.phase)) evictChats(project);
      if (previous !== undefined && activity?.terminal &&
          (previous?.id !== activity.id || previous.phase !== activity.phase)) {
        const name = projectList().find(item => item.id === project)?.name;
        const route = activity.kind === 'api' ? '通常API' : 'Codex';
        const messages = {completed: `${route}の作業が完了しました。`, interrupted: `${route}の実行が中断されました。`,
          cancelled: `${route}の作業を中止しました。`, failed: `${route}の実行に失敗しました。`};
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
function transportFailed(generation, signal) {
  if (generation === connectionGeneration && !signal?.aborted && !dom.shell.hidden && connectionState !== 'checking') {
    showConnection(navigator.onLine ? 'unreachable' : 'offline');
  }
}
async function requestOwner(path, options = {}) {
  const generation = connectionGeneration;
  let response;
  try { response = await fetch(path, {...options, credentials: 'same-origin'}); }
  catch {
    transportFailed(generation, options.signal);
    throw new Error('通信できませんでした。接続してから更新してください。');
  }
  return response;
}
async function api(path, options = {}) {
  const generation = connectionGeneration;
  const response = await requestOwner(path, {...options, cache: 'no-store'});
  if (response.status === 401) endSession();
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    const message = typeof problem?.error === 'string' && problem.error.length <= 240 ? problem.error : '';
    const error = new Error(message || httpMessages[response.status] || '読み込みに失敗しました。');
    error.status = response.status;
    error.code = problem?.code;
    throw error;
  }
  try {
    const data = await response.json();
    if (generation === connectionGeneration && connectionState === 'unreachable') void recheckConnection();
    return data;
  } catch (error) {
    if (error instanceof TypeError) transportFailed(generation, options.signal);
    throw new Error('対応するデータを読み込めませんでした。');
  }
}
async function recheckConnection() {
  if (dom.shell.hidden || connectionState === 'checking') return;
  if (!navigator.onLine) { showConnection('offline'); return; }
  showConnection('checking');
  const generation = connectionGeneration;
  const isCurrent = () => generation === connectionGeneration && !dom.shell.hidden;
  try {
    const response = await requestOwner('/api/session', {cache: 'no-store', signal: AbortSignal.timeout(6500)});
    if (!isCurrent()) return;
    if (response.status === 401) { endSession(); return; }
    if (!response.ok) throw new Error();
    const session = await response.json();
    if (!isCurrent()) return;
    if (session?.authenticated === false) {
      ui.capabilities = session.capabilities ?? {};
      endSession();
      return;
    }
    if (session?.authenticated !== true) throw new Error();
    showConnection('connected');
    void refreshVisibleDashboard();
    void pollActivity();
  } catch {
    if (isCurrent()) showConnection(navigator.onLine ? 'unreachable' : 'offline');
  }
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
  return row;
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
const executionModeLabels = {'subscription-only': 'サブスク専用', 'api-only': 'API専用', auto: '自動選択', hybrid: '工程ごとに指定'};

function executionSettingsFields() {
  const root = node('div', 'stack');
  const mode = labeledSelect('実行モード', executionModeLabels);
  const preference = labeledSelect('自動選択の優先順', {'subscription-first': 'サブスク優先', 'api-first': 'API優先', balanced: '実測をもとに選択'});
  const routeFields = node('fieldset', 'stack');
  routeFields.append(node('legend', 'small muted', '許可する実行経路'));
  const routeChecks = Object.entries({subscription:'サブスク', api:'API'}).map(([route, text]) => {
    const field = node('label', 'speech-control');
    const input = node('input');
    input.type = 'checkbox';
    field.append(input, node('span', '', text));
    routeFields.append(field);
    return [route, input];
  });
  const fallback = node('label', 'speech-control');
  const consent = node('input');
  consent.type = 'checkbox';
  fallback.append(consent, node('span', '', '自動選択時に許可済みの別経路を使う'));
  const budget = node('label', 'picker');
  const amount = node('input');
  amount.type = 'number';
  amount.min = '0';
  amount.max = '1000000';
  amount.step = 'any';
  budget.append(node('span', '', 'API作業上限（USD）'), amount);
  const stages = node('div', 'stack');
  const choices = Object.entries(workStageLabels).map(([stage, label]) => {
    const entry = labeledSelect(label, {'': '未指定', subscription: 'サブスク', api: 'API'});
    stages.append(entry.field);
    return [stage, entry.input];
  });
  function optionalText(title) {
    const field = node('label', 'picker');
    const input = node('input', 'search');
    input.maxLength = 160;
    input.placeholder = '自動';
    field.append(node('span', '', title), input);
    return {field, input};
  }
  const model = optionalText('モデルID');
  const effort = optionalText('推論レベル');
  root.append(mode.field, routeFields, preference.field, fallback, budget, stages, model.field, effort.field);

  function fields() {
    const selected = mode.input.value;
    routeFields.hidden = selected !== 'auto' && selected !== 'hybrid';
    preference.field.hidden = selected !== 'auto';
    fallback.hidden = preference.field.hidden;
    budget.hidden = mode.input.value === 'subscription-only';
    stages.hidden = mode.input.value !== 'hybrid';
  }

  mode.input.addEventListener('change', fields);
  return {root, problem() {
    if (!budget.hidden && !amount.validity.valid) return 'API作業上限を確認してください。';
    if (!routeFields.hidden && !routeChecks.some(([, input]) => input.checked)) return '実行経路を一つ以上選んでください。';
    if (!stages.hidden && choices.some(([, input]) => input.value &&
      !routeChecks.some(([route, check]) => route === input.value && check.checked))) return '工程の経路を許可する実行経路から選んでください。';
    return null;
  }, apply(settings) {
    mode.input.value = settings.mode;
    const routes = ['auto', 'hybrid'].includes(settings.mode) ? settings.allowedRoutes : ['subscription', 'api'];
    for (const [route, input] of routeChecks) input.checked = routes.includes(route);
    model.input.value = settings.model ?? '';
    effort.input.value = settings.reasoningEffort ?? '';
    preference.input.value = settings.preference;
    consent.checked = settings.allowFallback === true;
    amount.value = settings.apiBudgetUsd ?? '';
    for (const [stage, input] of choices) input.value = settings.stageRoutes?.[stage] ?? '';
    fields();
  }, value() {
    const chosen = mode.input.value;
    return {mode: chosen, preference: preference.input.value, allowFallback: chosen === 'auto' && consent.checked,
      apiBudgetUsd: amount.validity.valid && amount.value !== '' ? Number(amount.value) : null,
      stageRoutes: chosen === 'hybrid' ? Object.fromEntries(choices.filter(([, input]) => input.value)
        .map(([stage, input]) => [stage, input.value])) : {},
      model: model.input.value.trim() || null, reasoningEffort: effort.input.value.trim() || null,
      ...(!routeFields.hidden && {allowedRoutes:routeChecks.filter(([, input]) => input.checked).map(([route]) => route)})};
  }};
}

function executionEstimateDetails(estimate, held) {
  const section = node('div', 'stack');
  const facts = node('dl', 'properties');
  const format = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 6});
  const prediction = range => {
    const values = [range?.optimistic, range?.standard, range?.cautious];
    if (!values.every(value => Number.isFinite(value) && value >= 0)) return null;
    const [shortest, standard, cautious] = values.map(value => format.format(value));
    return `${shortest}〜${cautious}分（標準 ${standard}分）`;
  };
  const quantity = (value, unit) => Number.isFinite(value) && value >= 0
    ? (value > 0 && value < 0.000001 ? '0.000001未満' : format.format(value)) + unit : null;
  const completion = estimate.target === 'project' ? '案件全体の完成予定' : '対象工程の完了予定';
  metric(facts, '見積もりの記録日時', time(estimate.recordedAt));
  if (estimate.model) metric(facts, '見積もりで指定したモデル', estimate.model);
  if (estimate.reasoningEffort) metric(facts, '見積もりで指定した推論レベル', estimate.reasoningEffort);
  metric(facts, '初回利用までの見込み', prediction(estimate.firstUsableMinutes));
  metric(facts, '記録時点の残り時間', prediction(estimate.remainingMinutes));
  metric(facts, '初回利用の予定', held ? '保留中' : time(estimate.firstUsableAt));
  metric(facts, completion, held ? '保留中' : time(estimate.estimatedFinish));
  metric(facts, 'API費用の予測', quantity(estimate.apiCostUsd, ' USD'));
  metric(facts, 'サブスク利用の予測', quantity(estimate.subscriptionTurns, 'ターン'));
  section.append(facts);
  if (estimate.basis) section.append(node('h4', '', '根拠'), node('p', '', estimate.basis));
  const assumptions = asArray(estimate.assumptions).filter(value => typeof value === 'string' && value);
  if (assumptions.length) {
    section.append(node('h4', '', '前提条件'));
    appendStrings(section, assumptions);
  }
  const links = node('ul', 'marked-list');
  for (const item of asArray(estimate.links)) {
    const source = item?.label && link(item.label, item.url);
    if (source) links.append(listItem(source));
  }
  if (links.children.length) section.append(links);
  return section;
}

function executionEstimates(project, isCurrent) {
  const root = node('section', 'stack');
  const status = node('p', 'small muted');
  status.setAttribute('role', 'status');
  const records = node('div', 'stack');
  root.append(node('h3', '', '保存済み設定の見積もり'), status, records);
  const path = apiPath('/api/execution/estimates', {project});
  let request;

  function clear(message) {
    request?.abort();
    request = null;
    records.replaceChildren();
    status.textContent = message;
  }

  function paint(result, settings) {
    if (result?.settingsRevision !== settings.revision || result.mode !== settings.settings.mode) {
      status.textContent = '実行設定を更新してから見積もりを確認してください。';
      return;
    }
    if (result.status === 'missing') {
      status.textContent = 'この実行経路の見積もりは未記録です。';
      return;
    }
    const selected = result.selected;
    if (result.status !== 'available' || selected?.mode !== result.mode ||
        !Object.hasOwn(executionModeLabels, selected?.mode) ||
        !['milestone', 'project'].includes(selected?.target) || !text(selected.scope, '')) {
      status.textContent = '現在の見積もりを取得できません。';
      return;
    }
    const held = result.held === true;
    status.textContent = result.holdReason === 'api' ? 'APIの実行条件を確認できるまで、予定時刻は未確定です。'
      : held ? '案件の状態により予定時刻は表示していません。'
      : selected.stale ? '記録済みの予定時刻を過ぎたため、再見積もりが必要です。' : '';
    records.append(node('p', 'small muted', '対象 ' + (selected.target === 'project' ? '案件全体' : 'マイルストーン') + ' · ' + selected.scope),
      node('h4', '', executionModeLabels[selected.mode]), executionEstimateDetails(selected, held),
      node('p', 'small muted', '利用量は見積もりです。API作業上限と請求額は別に管理されます。'));
    const alternatives = new Map();
    for (const estimate of asArray(result.alternatives)) {
      if (estimate?.mode === selected.mode || !Object.hasOwn(executionModeLabels, estimate?.mode) ||
          estimate.target !== selected.target || estimate.scope !== selected.scope || alternatives.has(estimate.mode)) continue;
      alternatives.set(estimate.mode, estimate);
    }
    if (alternatives.size) records.append(node('h4', '', '同じ範囲の比較'),
      node('p', 'small muted', '各見積もりの経路・モデルなどの前提と根拠を確認できます。'));
    for (const estimate of alternatives.values()) {
      const detail = node('details', 'scope-info');
      detail.append(node('summary', '', executionModeLabels[estimate.mode]), executionEstimateDetails(estimate, held));
      records.append(detail);
    }
  }

  return {root, clear, async load(settings) {
    if (!isCurrent()) return;
    clear('見積もりを取得中…');
    const pending = new AbortController();
    request = pending;
    const current = () => isCurrent() && request === pending;
    try {
      const result = await api(path, {signal: AbortSignal.any([pending.signal, AbortSignal.timeout(10000)])});
      if (current()) paint(result, settings);
    } catch {
      if (current()) status.textContent = '現在の見積もりを取得できません。';
    } finally {
      if (request === pending) request = null;
    }
  }};
}

function executionSettings(project) {
  const details = node('details', 'scope-info');
  const content = node('div', 'stack');
  details.append(node('summary', '', '案件の実行経路'), content);
  const path = apiPath('/api/execution/settings', {project});
  const key = memoryKey('execution-settings', project);
  const isCurrent = () => details.isConnected && ui.view === 'dashboard' && ui.project === project;
  function mount() {
    fetchView(key, path, content, (initial, destination) => {
      let current = initial;
      const editor = executionSettingsFields();
      const estimates = executionEstimates(project, isCurrent);
      const status = node('p', 'small muted');
      status.setAttribute('role', 'status');
      const save = button('案件の実行設定を保存', async () => {
        const problem = editor.problem();
        if (problem) { status.textContent = problem; return; }
        save.disabled = true;
        estimates.clear('実行設定の保存を確認中…');
        try {
          const generation = connectionGeneration;
          const saved = await api(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({revision: current.revision, settings: editor.value()})});
          if (resources.get(key)?.value?.revision > saved.revision || !ui.portfolio) return;
          current = saved;
          resources.set(key, {value: current});
          applyDashboardExecution(project, current.executionSummary, generation);
          if (!isCurrent()) return;
          editor.apply(current.settings);
          status.textContent = 'この案件の実行設定を保存しました。';
        } catch (error) { if (isCurrent()) status.textContent = error.message; }
        finally {
          if (isCurrent()) {
            save.disabled = false;
            void estimates.load(current);
          }
        }
      }, false);
      destination.append(editor.root,
        node('p', 'small muted', current.apiAvailable ? 'API実行経路を利用できます。' : 'API実行は認証と費用条件を確認できるまで待機します。'),
        save, status, estimates.root);
      editor.apply(current.settings);
      void estimates.load(current);
    }, isCurrent);
  }
  details.addEventListener('toggle', () => { if (details.open && !content.hasChildNodes()) mount(); });
  return details;
}

function registrationRejected(error) {
  return [400, 403, 404, 409, 413, 422].includes(error.status);
}

function sendProjectRegistration(key, payload) {
  if (registrationFlights.has(key)) return registrationFlights.get(key);
  ui.registrationIntents.set(key, payload);
  storeTab();
  const sent = api('/api/portfolio/projects', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)}).then(result => {
    if (typeof result?.id !== 'string' || !result.id) throw new Error('案件の受付結果を取得できませんでした。');
    ui.registrationIntents.delete(key);
    storeTab();
    return result.id;
  }).catch(error => {
    if (registrationRejected(error)) {
      ui.registrationIntents.delete(key);
      storeTab();
    }
    throw error;
  }).finally(() => { registrationFlights.delete(key); });
  registrationFlights.set(key, sent);
  return sent;
}

function projectRegistrationForm(github, pendingKey = null) {
  const defaults = ui.portfolio?.newProjectExecutionSettings;
  const key = pendingKey ?? github?.id ?? '';
  let intent = ui.registrationIntents.get(key);
  if (ui.capabilities.projectRegistration !== true || !defaults ||
      (pendingKey && !intent) ||
      (github && (github.registration !== 'github' || github.registrationAvailable !== true))) return null;

  const selected = ui.project;
  const details = node('details', 'scope-info');
  const form = node('form', 'stack');
  const fields = node('fieldset', 'stack');
  const heading = pendingKey ? 'GitHub案件の登録受付' : github ? 'このGitHub案件を登録' : '新規案件を登録';
  details.append(node('summary', '', heading), form);
  const current = () => details.isConnected && ui.view === 'dashboard' && ui.project === selected;
  const name = node('input', 'search');
  name.maxLength = 100;
  name.required = !key;
  const goal = node('textarea', 'draft');
  goal.maxLength = 1500;
  function field(label, control) {
    const item = node('label', 'picker');
    item.append(node('span', '', label), control);
    return item;
  }
  if (github) fields.append(node('p', 'strong', github.name));
  else if (!pendingKey) fields.append(field('案件名', name));
  fields.append(field('GOAL（任意）', goal));

  const editor = executionSettingsFields();
  editor.apply(intent?.settings ?? defaults);
  fields.append(editor.root);
  if (intent) {
    name.value = intent.name ?? '';
    goal.value = intent.goal ?? '';
    details.open = true;
  }

  let busy = false;
  let registeredId;
  const status = node('p', 'small muted', intent ? '受付結果を照合できます。' : '');
  status.setAttribute('role', 'status');
  const submit = node('button', 'button', '案件を登録');
  submit.type = 'submit';
  function update() {
    fields.disabled = busy || Boolean(intent || registeredId);
    submit.disabled = busy || Boolean(pendingKey && !intent && !registeredId);
    submit.textContent = registeredId ? '案件一覧を再取得' : intent ? '同じ受付で照合' : '案件を登録';
  }

  const actions = node('div', 'run-actions');
  actions.append(submit);
  form.append(fields, node('p', 'small muted', '登録前の見積もりは不明です。'),
    node('p', 'small muted', '登録時は待機中になります。作業先と実行権限はホスト側で登録します。'), actions, status);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !current() || pendingKey && !intent && !registeredId) return;
    if (!intent && !registeredId) {
      const title = name.value.trim();
      if (!github && !title) { status.textContent = '案件名を入力してください。'; name.focus(); return; }
      const problem = editor.problem();
      if (problem) { status.textContent = problem; return; }
      intent = {requestId: crypto.randomUUID(), ...(github ? {githubProject: github.id} : {name: title}),
        ...(goal.value.trim() ? {goal: goal.value.trim()} : {}), settings: editor.value()};
    }

    busy = true;
    update();
    status.textContent = registeredId ? '案件一覧を取得中…' : '受付を確認中…';
    try {
      registeredId ??= await sendProjectRegistration(key, intent);
      intent = null;
      if (!current()) return;
      const sequence = requestSequence;
      const generation = connectionGeneration;
      const latest = await api('/api/portfolio', {signal: AbortSignal.timeout(10000)});
      if (!current() || sequence !== requestSequence) return;
      if (generation !== connectionGeneration) {
        status.textContent = '登録した案件の一覧をもう一度取得できます。';
        return;
      }
      if (!asArray(latest?.projects).some(project => project.id === registeredId)) {
        throw new Error('登録した案件が一覧に表示されるまで、もう一度取得してください。');
      }
      rememberScroll();
      setObservedPortfolio(latest, generation);
      ui.project = registeredId;
      updateProjectSelect();
      setNotice('案件を登録しました。');
      render(true, true);
    } catch (error) {
      if (registrationRejected(error)) intent = null;
      if (current()) status.textContent = error.message + (intent ? ' 同じ受付で照合できます。' : '');
    } finally {
      busy = false;
      if (current()) update();
    }
  });
  update();
  return details;
}

function deliveryRecordDetails(record) {
  const section = node('section', 'stack');
  section.append(node('h3', '', '進捗の観測記録'));
  if (record.scope) section.append(node('p', 'small muted', '対象 ' + record.scope));
  if (Number.isFinite(Date.parse(record.observedAt))) {
    section.append(node('p', 'small muted', '記録日時 ' + time(record.observedAt)));
  }
  if (record.status === 'current') {
    const audit = record.audit;
    if (audit?.unit === '節' && Number.isSafeInteger(audit.accepted) && Number.isSafeInteger(audit.total) &&
        audit.accepted >= 0 && audit.total > 0 && audit.accepted <= audit.total) {
      const facts = node('dl', 'properties');
      metric(facts, '対象範囲で受入済み', audit.accepted + ' / ' + audit.total + audit.unit);
      section.append(facts);
    }
    const first = record.firstUsable;
    if (first) {
      const facts = node('dl', 'properties');
      const minutes = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 1});
      const assumptions = [['最短', first.baselineMinutes?.optimistic], ['標準', first.baselineMinutes?.standard],
        ['慎重', first.baselineMinutes?.cautious]]
        .filter(([, value]) => Number.isFinite(value) && value >= 0)
        .map(([label, value]) => label + ' ' + minutes.format(value) + '分');
      if (Number.isFinite(Date.parse(first.baselineRecordedAt))) metric(facts, '当初見込みの記録時刻', time(first.baselineRecordedAt));
      if (assumptions.length) metric(facts, '当初の所要時間', assumptions.join(' ／ '));
      if (Number.isFinite(Date.parse(first.actualAt))) metric(facts, '初回利用の確認時刻', time(first.actualAt));
      if (Number.isSafeInteger(first.elapsedSeconds) && first.elapsedSeconds >= 0) {
        metric(facts, '実際の経過時間', deliveryDuration(first.elapsedSeconds));
      }
      if (Number.isSafeInteger(first.varianceSeconds)) {
        const sign = first.varianceSeconds > 0 ? '+' : first.varianceSeconds < 0 ? '−' : '±';
        metric(facts, '標準見込みとの差', sign + deliveryDuration(Math.abs(first.varianceSeconds)));
      }
      if (facts.children.length) section.append(node('h3', '', '初回利用まで'), facts);
    }
    if (record.originalFullForecast) section.append(node('h3', '', '当初の全要求完成見込み（条件付き）'),
      node('p', 'small', record.originalFullForecast));
    if (record.nextAction) section.append(node('h3', '', '記録済みの次工程'), node('p', '', record.nextAction));
  } else section.append(node('p', 'small muted', '原本記録を取得できません。'));
  sourceSection(section, record.links);
  return section;
}

function deliveryDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return (hours ? hours + '時間' : '') + (minutes ? minutes + '分' : '') +
    (remainder || seconds === 0 ? remainder + '秒' : '');
}

function estimateLabel(estimate) {
  if (!Number.isFinite(estimate?.standard)) return '見積もり未登録';
  const duration = minutes => deliveryDuration(Math.round(minutes * 60));
  return estimate.optimistic === estimate.cautious ? duration(estimate.standard) :
    duration(estimate.optimistic) + '〜' + duration(estimate.cautious) + '（標準 ' + duration(estimate.standard) + '）';
}

function updateEstimateReadout(readout, now) {
  if (now < Number(readout.dataset.estimateExpires)) return;
  readout.textContent = '再見積もり待ち（記録時 ' + readout.textContent + '）';
  delete readout.dataset.estimateExpires;
}

function markEstimateExpiry(readout, deadline) {
  if (!Number.isFinite(deadline)) return;
  readout.dataset.estimateExpires = String(deadline);
  updateEstimateReadout(readout, Date.now());
}

function markProjectEstimateExpiry(readout, project, finish) {
  if (project.measurements?.formalCompletion === 100 && project.schedule?.remainingMinutes?.cautious === 0) return;
  markEstimateExpiry(readout, Date.parse(finish));
}

function refreshEstimateReadouts() {
  if (document.hidden || dom.shell.hidden) return;
  const scope = ui.view === 'dashboard' ? dom.content : dom.content.querySelector('#chat-development:not([hidden])');
  if (!scope) return;
  const now = Date.now();
  for (const readout of scope.querySelectorAll('[data-estimate-expires]')) updateEstimateReadout(readout, now);
}

function taskEstimateReadout(task) {
  const estimate = task.remainingMinutes;
  const label = estimateLabel(estimate);
  if (!Number.isFinite(estimate?.standard) || task.status === 'verified') return node('dd', 'strong', label);
  if (task.status === 'pending') return node('dd', 'strong', '着手後の見込み ' + label);
  if (task.externalWait || ['waiting', 'paused', 'blocked', 'approval', 'limit'].includes(task.status)) {
    return node('dd', 'strong', '再開後の見込み ' + label);
  }
  const observedAt = Date.parse(task.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > Date.now()) return node('dd', 'strong', '記録時点の見込み ' + label);
  const readout = node('dd', 'strong', label);
  markEstimateExpiry(readout, observedAt + estimate.standard * 60000);
  return readout;
}

function taskStatus(task) {
  const age = Date.now() - Date.parse(task.observedAt);
  if (task.status === 'active') return age >= 0 && age <= 15 * 60 * 1000
    ? chip('developing') : chip('unknown', '前回は開発中');
  if (task.status === 'pending') return chip('waiting', '未着手');
  if (task.status === 'verified') return chip('completed', '確認済み');
  return chip(task.status);
}

function taskProgressLabel(progress) {
  return progress && Number.isFinite(progress.percent)
    ? progress.percent + '%（' + progress.accepted + '/' + progress.total + '件確認・残り' +
      (progress.total - progress.accepted) + '件）' : '算定待ち';
}

function progressRow(task) {
  const row = node('li', 'task-progress-row');
  const work = node('div');
  if (task.title) {
    const title = node('p', 'task-title');
    title.append(node('strong', '', task.title), taskStatus(task));
    work.append(title);
  }
  if (!appendStrings(work, task.remaining)) {
    work.append(node('p', 'small muted', task.status === 'verified' ? '残作業なし' : '残作業の記録なし'));
  }
  if (task.blocker) work.append(node('p', 'small', task.blocker));
  const metrics = node('dl', 'task-progress-facts');
  const progressValue = taskProgressLabel(task.progress);
  const remaining = taskEstimateReadout(task);
  for (const [label, value] of [['進捗率', node('dd', 'strong', progressValue)], ['残り作業時間', remaining]]) {
    const entry = node('div');
    entry.append(node('dt', 'small muted', label), value);
    metrics.append(entry);
  }
  const context = node('p', 'small muted');
  const notes = [];
  if (task.device) notes.push(task.device);
  if (task.externalWait === true) notes.push('待ち時間は未定');
  if (task.observedAt) notes.push('記録 ' + time(task.observedAt));
  if (notes.length) context.append(node('span', '', notes.join(' · ')));
  for (const proof of asArray(task.evidence)) {
    const source = link(proof.label, proof.url);
    if (source) context.append(source);
  }
  row.append(work, metrics);
  if (context.hasChildNodes()) row.append(context);
  return row;
}

function developmentTasks() {
  const area = panel('開発タスク');
  const list = node('div', 'development-tasks');
  const source = ui.portfolio?.taskProgressSource;
  const development = new Set(['developing', 'researching', 'designing', 'verifying', 'fixing', 'integrating',
    'waiting', 'approval', 'blocked', 'limit', 'delayed']);
  for (const project of projectList()) {
    const tasks = asArray(project.tasks).filter(task => task.status !== 'verified');
    if (!tasks.length && !development.has(project.state)) continue;
    const group = node('section', 'task-project');
    const heading = node('div', 'task-project-heading');
    const projectButton = button(project.name, () => selectProject(project.id, true));
    const scopedState = project.stateScope && project.stateScope + ' · ' + stateLabels[statusKey(project.state)];
    heading.append(projectButton, chip(project.state, scopedState || undefined));
    const formal = project.measurements?.formalCompletion;
    heading.append(node('span', 'small muted', Number.isFinite(formal) ? '案件全体 ' + formal + '%' : '案件全体の達成率は未確定'));
    group.append(heading);
    const entries = node('ul', 'task-progress-list');
    if (tasks.length) for (const task of tasks) entries.append(progressRow(task));
    else entries.append(progressRow({remaining: project.remaining,
      blocker: 'タスク別の受入記録を取得できていません。', observedAt: project.observedAt,
      remainingMinutes: project.schedule?.remainingMinutes}));
    group.append(entries);
    list.append(group);
  }
  if (list.children.length) area.body.append(list);
  else if (source?.status !== 'unavailable') {
    area.body.append(node('p', 'muted', '進行中または未完了と確認できた開発タスクはありません。'));
  }
  if (source?.status === 'current') {
    const record = link(source.evidence?.label, source.evidence?.url);
    if (record) area.body.append(node('p', 'small muted', '案件の観測 ' + time(source.observedAt) + ' '), record);
    if (source.unmatched > 0) area.body.append(node('p', 'small muted',
      '登録案件と照合できない進捗記録 ' + source.unmatched + '件'));
  } else if (source?.status === 'unavailable') {
    area.body.append(node('p', 'small muted', list.children.length
      ? '案件の観測記録を取得できません。取得できた作業だけ表示しています。'
      : '案件の観測記録を取得できないため、開発タスクを確認できません。'));
  }
  return area.root;
}

const reviewStatuses = {
  verified: ['確認済み', 'completed'], partial: ['一部確認', 'approval'],
  open: ['未確認', 'unknown'], blocked: ['保留', 'blocked'], reference: ['参照', 'unknown'],
};

function requirementsReview(project) {
  const details = node('details', 'scope-info');
  const content = node('div', 'stack');
  details.append(node('summary', '', '要求ごとの照合'), content);
  const current = () => ui.view === 'dashboard' && ui.project === project.id && details.isConnected;
  const path = apiPath('/api/portfolio/requirements', {project: project.id});
  const key = memoryKey('requirements-review', project.id, project.deliveryRecord.requirementsRevision);
  let started = false;

  function paint(result, destination) {
    const source = link('利用者の要求原文', result?.ownerUrl);
    if (source) destination.append(source);
    if (result?.status !== 'current') {
      destination.append(node('p', 'muted', '現在の要求照合記録を取得できません。'));
      return;
    }
    const counts = result.counts;
    if (Number.isSafeInteger(counts?.total) && counts.total >= 0) {
      destination.append(node('p', 'strong', '原文の照合行 ' + counts.total + '件'));
      const breakdown = ['verified', 'partial', 'open', 'blocked']
        .filter(status => Number.isSafeInteger(counts[status]) && counts[status] >= 0)
        .map(status => reviewStatuses[status][0] + ' ' + counts[status] + '件');
      if (breakdown.length) destination.append(node('p', '', breakdown.join(' · ')));
      if (Number.isSafeInteger(counts.reference) && counts.reference >= 0) {
        destination.append(node('p', 'muted', '参照 ' + counts.reference + '件'));
      }
    }
    const label = node('label', 'speech-control');
    const filter = node('input');
    filter.type = 'checkbox';
    label.append(filter, node('span', '', '確認が残る行だけ表示'));
    const sections = node('div', 'stack');
    function showRows() {
      sections.replaceChildren();
      for (const group of asArray(result.sections)) {
        const rows = node('ul', 'marked-list');
        for (const row of asArray(group?.rows)) {
          if (!Object.hasOwn(reviewStatuses, row?.status) ||
              (filter.checked && ['verified', 'reference'].includes(row.status))) continue;
          const item = node('div');
          const [statusLabel, statusStyle] = reviewStatuses[row.status];
          const heading = node('p', 'run-actions');
          heading.append(chip(statusStyle, statusLabel));
          const line = Number.isSafeInteger(row.line) && row.line > 0 ? '原文 ' + row.line + '行' : '';
          if (line) heading.append(link(line, row.sourceUrl) ?? node('span', '', line));
          item.append(heading);
          if (row.note) item.append(node('p', '', row.note));
          const evidence = asArray(row.evidence).flatMap(entry => {
            const label = text(entry?.label, '');
            const source = label && link(label, entry?.url);
            return source ? [listItem(source)] : [];
          });
          if (evidence.length) {
            const links = node('ul', 'marked-list');
            links.append(...evidence);
            item.append(links);
          }
          rows.append(listItem(item));
        }
        if (rows.children.length) sections.append(node('h4', '', text(group.title)), rows);
      }
      if (!sections.children.length) sections.append(node('p', 'muted',
        filter.checked ? '確認が残る行はありません。' : '表示できる照合行がありません。'));
    }
    filter.addEventListener('change', showRows);
    destination.append(label, sections);
    showRows();
  }

  details.addEventListener('toggle', () => {
    if (!details.open || !current() || started) return;
    started = true;
    fetchView(key, path, content, paint, current);
  });
  return details;
}

function forecastDateLabel(dates) {
  if (!dates) return '確定待ち';
  if (dates.optimistic === dates.cautious) return time(dates.standard);
  return '最短 ' + time(dates.optimistic) + ' ／ 標準 ' + time(dates.standard) + ' ／ 慎重 ' + time(dates.cautious);
}

function projectForecastPanel(project) {
  const forecast=project.forecast;
  if (!forecast) return null;
  const details=node('section','stack');
  details.id='project-forecast';
  details.append(node('h3','','完成までの見通し'));
  const {schedule,actual,baseline}=forecast;
  const facts=node('dl','properties');
  const checks=forecast.checkpoints;
  if (checks) metric(facts,'記録済みの受入チェック',taskProgressLabel(checks));
  if (forecast.progress) {
    metric(facts,'実装完成率',forecast.progress.implementationCompletion,true);
    metric(facts,'正式な要求達成率',forecast.progress.formalCompletion,true);
    metric(facts,'実用完成率',forecast.progress.usableCompletion,true);
  }
  if (forecast.stage) metric(facts,'現在の工程',forecast.stage);
  const work=schedule.workMinutes??schedule.recordedWorkMinutes;
  if (work) metric(facts,'記録のある工程の残工数',estimateLabel(work));
  if (schedule.elapsedMinutes) metric(facts,'条件がそろった後の所要時間',estimateLabel(schedule.elapsedMinutes));
  metric(facts,'全要求の完成予定（日本時間）',forecastDateLabel(schedule.completionDates));
  if (actual.firstUsableAt) metric(facts,'初回の実用版を提供した日時',time(actual.firstUsableAt));
  else if (schedule.firstUsableDates) metric(facts,'最初の実用成果物の予定',forecastDateLabel(schedule.firstUsableDates));
  if (forecast.nextAction) metric(facts,'次に実行する作業',forecast.nextAction);
  if (forecast.ownerAction) metric(facts,'利用者の対応',forecast.ownerAction);
  const blocking=asArray(forecast.tasks).find(task=>task.blocker||task.ownerAction);
  if (blocking?.blocker) metric(facts,'現在の障害',blocking.blocker);
  if (blocking?.cause) metric(facts,'障害の原因',blocking.cause);
  if (blocking?.resolution) metric(facts,'解消方法',blocking.resolution);
  if (!schedule.completionDates) {
    const gaps=asArray(forecast.gaps);
    const condition=gaps.find(gap=>gap.code==='workspace-observation') ??
      gaps.find(gap=>['scope','external-wait','calendar'].includes(gap.code));
    if (condition) metric(facts,'完成予定を更新できる条件',condition.action);
  }
  details.append(facts);
  const source=forecast.source && link(forecast.source.label,forecast.source.url);
  if (source) details.append(source);
  else if (forecast.source?.revision) {
    details.append(node('p','small muted',forecast.source.label+' · '+forecast.source.revision.slice(0,12)));
  }
  const expanded=node('details','scope-info forecast-details');
  expanded.dataset.dashboardDetail = 'forecast';
  expanded.append(node('summary','','残工程・見積もりの根拠'));
  const timings=node('dl','properties');
  const original=baseline.original??baseline.retrospective;
  const originalLabel=baseline.kind==='retrospective'?'開始後の事後推定':'開始時の見積もり';
  if (original?.minutes && original.target!=='requirements-readback') metric(timings,originalLabel,estimateLabel(original.minutes));
  const intake=baseline.intake??(original?.target==='requirements-readback'?original:null);
  if (intake?.minutes) metric(timings,'登録時の要件確認の見積もり',estimateLabel(intake.minutes));
  if (original?.basis) metric(timings,'見積もりの根拠',original.basis);
  if (baseline.revisionReason) metric(timings,'見積もりの変更理由',baseline.revisionReason);
  if (schedule.criticalPathMinutes) metric(timings,'依存工程の最長経路',estimateLabel(schedule.criticalPathMinutes));
  const variance=schedule.forecastDeltaMinutes;
  if (Number.isFinite(variance)) metric(timings,'当初予定との差',variance===0?'差なし':
    estimateLabel({optimistic:Math.abs(variance),standard:Math.abs(variance),cautious:Math.abs(variance)}) + (variance>0?'遅れ':'前倒し'));
  else if (schedule.delayed===true) metric(timings,'当初予定との差','期日超過、差分の見積もり待ち');
  for (const [label,minutes] of [['累計実作業時間',actual.activeMinutes],['担当別の作業時間合計',actual.agentMinutes],
    ['累計経過時間',actual.elapsedMinutes],['停止・待機時間',actual.waitingMinutes]]) {
    if (Number.isFinite(minutes)) metric(timings,label,deliveryDuration(Math.round(minutes*60)));
  }
  if (forecast.observedAt) metric(timings,'最終観測',time(forecast.observedAt));
  metric(timings,'次回の確認',forecast.nextUpdate.at ? time(forecast.nextUpdate.at) :
    {'owner-resume':'再開時','owner-action':'利用者の対応が済んだとき'}[forecast.nextUpdate.trigger]??
    '正本に次の作業・観測が記録されたとき');
  expanded.append(timings);
  const byId=new Map(asArray(forecast.tasks).map(task=>[task.id,task]));
  const taskIds=asArray(schedule.orderedTaskIds);
  const tasks=taskIds.length?taskIds.map(id=>byId.get(id)).filter(Boolean):[...byId.values()];
  if (tasks.length) {
    const list=node('ol','task-progress-list');
    for (const task of tasks) {
      const item=node('li','stack');
      item.append(node('strong','',task.title),taskStatus(task));
      const work=node('dl','properties');
      metric(work,'残り作業時間',task.expired?'再見積もり待ち':estimateLabel(task.remainingMinutes));
      const predecessor=asArray(task.dependencies).map(id=>byId.get(id)?.title).filter(Boolean);
      if (predecessor.length) metric(work,'先に完了する工程',predecessor.join('、'));
      const owners=[task.owner,task.device].filter(Boolean);
      if (owners.length) metric(work,'担当AI・端末',owners.join(' ／ '));
      if (task.cause) metric(work,'障害の原因',task.cause);
      if (task.resolution) metric(work,'解消方法',task.resolution);
      if (task.ownerAction) metric(work,'利用者の対応',task.ownerAction);
      if (task.nextAction) metric(work,'次の作業',task.nextAction);
      if (task.estimate?.basis) metric(work,'根拠',task.estimate.basis);
      if (task.estimate?.confidence) metric(work,'確度',{low:'低',medium:'中',high:'高'}[task.estimate.confidence]);
      item.append(work);
      appendStrings(item,[...asArray(task.remaining),...asArray(task.estimate?.assumptions),...asArray(task.estimate?.evidence)]);
      list.append(item);
    }
    expanded.append(list);
  }
  const gaps=[...asArray(forecast.gaps),...asArray(forecast.diagnostics)];
  if (gaps.length) {
    const list=node('ul','rows');
    for (const gap of gaps) {
      const item=node('li','stack');
      item.append(node('strong','',gap.reason),node('p','muted',gap.action));
      if (gap.investigationMinutes) item.append(node('p','small muted','確認に必要な時間の目安 '+estimateLabel(gap.investigationMinutes)));
      list.append(item);
    }
    expanded.append(node('h4','','確認が必要な情報と対応'),list);
  }
  details.append(expanded);
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
  if (project.scopeRequired) detail.body.append(node('p', 'muted', '実行を始めるには、ホスト側で作業先と実行権限を設定してください。'));
  const facts = node('dl', 'properties');
  const forecast = projectForecastPanel(project);
  if (project.registration === 'github') {
    metric(facts, 'GitHubでの取得時刻', time(project.observedAt));
    detail.body.append(facts);
    if (forecast) detail.body.append(forecast);
    const source = link('GitHubでリポジトリを開く', project.repository);
    if (source) detail.body.append(source);
    const registration = !ui.registrationIntents.has(project.id) && projectRegistrationForm(project);
    if (registration) detail.body.append(registration);
    return detail.root;
  }
  const m = project.measurements ?? {};
  const record = project.deliveryRecord;
  const wholeProgress = ['implementationCompletion', 'formalCompletion', 'verifiedCompletion', 'usableCompletion']
    .some(key => Number.isFinite(m[key]));
  if (record && !wholeProgress) metric(facts, '案件全体の完成率', '不明');
  else {
    metric(facts, '実装完成率', m.implementationCompletion, true);
    metric(facts, '正式な要求達成率', m.formalCompletion, true);
    metric(facts, '動作検証済み割合', m.verifiedCompletion, true);
    metric(facts, '実用完成率', m.usableCompletion, true);
  }
  if (!record || m.estimateFinish || record.firstUsable) {
    const finish = metric(facts, '完成予定', time(m.estimateFinish));
    markProjectEstimateExpiry(finish, project, m.estimateFinish);
  }
  if (project.schedule?.originalDueAt) metric(facts, '当初の完成予定', time(project.schedule.originalDueAt));
  const wholeTime = metric(facts, '案件全体の残り作業時間', estimateLabel(project.schedule?.remainingMinutes));
  markProjectEstimateExpiry(wholeTime, project, project.schedule?.estimatedFinish);
  if (!record || Number.isFinite(m.activeMinutes)) {
    metric(facts, '累計実作業時間', Number.isFinite(m.activeMinutes) ? m.activeMinutes + '分' : null);
  }
  metric(facts, '情報の取得時刻', time(project.observedAt ?? ui.portfolio?.observedAt));
  if (forecast) detail.body.append(forecast);
  detail.body.append(facts);
  if (record) detail.body.append(deliveryRecordDetails(record));
  if (record?.requirementsReview === true) detail.body.append(requirementsReview(project));
  if (asArray(project.tasks).length) {
    const tasks = node('details', 'scope-info');
    tasks.dataset.dashboardDetail = 'tasks';
    const rows = node('ul', 'task-progress-list');
    rows.append(...project.tasks.map(progressRow));
    tasks.append(node('summary', '', 'この案件の開発タスク'), rows);
    detail.body.append(tasks);
  }
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
function tailnetPanel() {
  const area = panel('遠隔接続');
  const status = node('p', 'small muted');
  status.setAttribute('role', 'status');
  const actions = node('div', 'run-actions');
  const paired = node('div', 'stack');
  const remote = ui.capabilities.tailnetSignIn === true;
  const run = async (path, accept) => {
    const buttons = actions.querySelectorAll('button');
    for (const control of buttons) control.disabled = true;
    status.textContent = '';
    paired.replaceChildren();
    delete paired.dataset.pairExpiresAt;
    try { accept(await api(path, {method: 'POST'})); }
    catch (error) { status.textContent = error.message; }
    finally { for (const control of buttons) control.disabled = false; }
  };
  if (remote) {
    actions.append(button('この端末からサインアウト', () => run('/api/access/end', endSession)));
  } else {
    actions.append(button('接続コードを発行', () => run('/api/access/pair', result => {
      const address = link(result.url, result.url);
      if (address) paired.append(address);
      paired.append(node('p', 'small muted', '接続コード'), node('code', '', result.code));
      paired.dataset.pairExpiresAt = result.expiresAt;
      status.textContent = '有効期限 ' + time(result.expiresAt);
    }), false), button('すべての遠隔接続を終了', () => run('/api/access/revoke', () => {
      status.textContent = '遠隔接続と未使用の接続コードを無効にしました。';
    })));
  }
  area.body.append(actions, paired, status);
  return area.root;
}
const dashboardExecutionTimers = new WeakMap();
const executionRouteLabels = {subscription: 'Codex', api: '通常API'};
const executionStopLabels = {
  paused: stateLabels.paused, approval: stateLabels.approval, limit: stateLabels.limit,
  blocked: '障害の確認が必要', offline: stateLabels.offline, waiting: stateLabels.waiting,
  completed: stateLabels.completed, 'scope-required': '作業先の登録待ち', 'api-disabled': 'API経路を利用できません',
  unconfirmed: '実行状況の確認が必要', interrupted: activityLabels.interrupted,
  cancelled: activityLabels.cancelled, failed: activityLabels.failed, 'settings-unavailable': '実行設定の確認が必要',
};

function dashboardProjectRow(projectId) {
  return [...dom.content.querySelectorAll('[data-dashboard-project]')].find(row => row.dataset.dashboardProject === projectId);
}

function setObservedPortfolio(portfolio, generation) {
  ui.portfolio = portfolio;
  appHostObservation = {generation, receivedAt: performance.now()};
  paintAppHostConnection();
  let newlyConfirmed = false;
  for (const {executionSummary} of projectList()) {
    if (!executionSummary || typeof executionSummary !== 'object' ||
        dashboardExecutionGenerations.get(executionSummary) === generation) continue;
    dashboardExecutionGenerations.set(executionSummary, generation);
    newlyConfirmed = true;
  }
  return newlyConfirmed;
}

function repaintDashboardExecutions() {
  if (ui.view !== 'dashboard') return;
  const projects = new Map(projectList().map(project => [project.id, project]));
  for (const row of dom.content.querySelectorAll('[data-dashboard-project]')) {
    const summary = row.querySelector('[data-execution-summary]');
    const project = projects.get(row.dataset.dashboardProject);
    if (summary && project) paintDashboardExecution(summary, project);
  }
}

function paintDashboardExecution(element, project) {
  clearTimeout(dashboardExecutionTimers.get(element));
  if (project.registration === 'github' || !project.executionSummary) {
    element.hidden = true;
    return;
  }
  const summary = project.executionSummary;
  const mode = Object.hasOwn(executionModeLabels, summary.mode) && executionModeLabels[summary.mode];
  const source = summary.modeSource === 'default' ? '（共通既定）' : '';
  const modeLabel = mode && ['saved', 'default'].includes(summary.modeSource) ? mode + source : '不明';
  const route = Object.hasOwn(executionRouteLabels, summary.route) && executionRouteLabels[summary.route];
  const now = Date.now();
  const observed = Date.parse(summary.observedAt);
  const lastConfirmed = Date.parse(summary.observedUntil);
  const activeUntil = Date.parse(summary.activeUntil);
  const verified = connectionState === 'connected' && dashboardExecutionGenerations.get(summary) === connectionGeneration &&
    route && ['active','observed'].includes(summary.routeState) && observed <= now && now < lastConfirmed;
  const active = verified && summary.routeState === 'active' && now < activeUntil;
  const routeLabel = active ? route + ' · 実行中' : verified ? route + ' · 確認 ' + time(summary.observedAt) : '不明';
  const reason = Object.hasOwn(executionStopLabels, summary.stopReason) && executionStopLabels[summary.stopReason];
  const execution = ['設定 ' + modeLabel, '経路 ' + routeLabel, reason !== statusLabel(project.state) && reason].filter(Boolean);
  element.replaceChildren(node('span', '', execution.join(' · ')));

  const formal = project.measurements?.formalCompletion;
  const remaining = project.schedule?.remainingMinutes;
  if (Number.isFinite(formal) && formal >= 0 && formal <= 100) {
    element.append(node('span', '', '正式達成率 ' +
      new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 1}).format(formal) + '%'));
  }
  if (remaining && [remaining.optimistic, remaining.standard, remaining.cautious]
    .every(value => Number.isFinite(value) && value >= 0)) {
    const readout = node('span', '', '全体の残り ' + estimateLabel(remaining));
    markProjectEstimateExpiry(readout, project, project.schedule?.estimatedFinish);
    element.append(readout);
  }
  element.hidden = false;

  if (verified) {
    const until = active ? Math.min(activeUntil, lastConfirmed) : lastConfirmed;
    const timer = setTimeout(() => {
      if (element.isConnected) paintDashboardExecution(element, project);
    }, until - now);
    dashboardExecutionTimers.set(element, timer);
  }
}

function applyDashboardExecution(projectId, summary, generation) {
  const project = projectList().find(item => item.id === projectId);
  if (!project || project.registration === 'github' || !summary || typeof summary !== 'object') return;
  project.executionSummary = summary;
  dashboardExecutionGenerations.set(summary, generation);
  dashboardExecutionVersion++;
  const element = dashboardProjectRow(projectId)?.querySelector('[data-execution-summary]');
  if (element) paintDashboardExecution(element, project);
}

function recentWorkOutcomesPanel() {
  const projects = new Map(projectList().filter(project => project.registration !== 'github').map(project => [project.id, project]));
  const rows = node('ul', 'rows');
  for (const outcome of asArray(ui.portfolio?.recentWorkOutcomes).slice(0, 8)) {
    const project = projects.get(outcome?.projectId);
    if (!project || !['codex', 'api'].includes(outcome.kind) || !['completed', 'failed'].includes(outcome.phase) ||
        typeof outcome.observedAt !== 'string' || !Number.isFinite(Date.parse(outcome.observedAt))) continue;
    const route = outcome.kind === 'api' ? '通常API' : 'Codex';
    const openThread = outcome.kind === 'codex' && typeof outcome.threadId === 'string' && codexRecordId.test(outcome.threadId);
    const open = () => {
      if (openThread) {
        selectProject(project.id);
        ui.threadIds.set(project.id, outcome.threadId);
        storeTab();
        location.hash = 'codex';
      } else if (ui.project === project.id) {
        document.getElementById('active-project')?.scrollIntoView({block: 'nearest'});
      } else selectProject(project.id, true);
    };
    const target = rowButton(project.name, route + ' · ' + time(outcome.observedAt), false, open,
      chip(outcome.phase, outcome.phase === 'completed' ? '作業完了' : '作業失敗'));
    target.removeAttribute('aria-pressed');
    rows.append(listItem(target));
  }
  if (!rows.children.length) return null;
  const section = panel('最近の完了・障害');
  section.body.remove();
  section.root.append(rows);
  return section.root;
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
      const row = rowButton(text(item.name), item.summary ?? item.goal, item.id === ui.project,
        () => selectProject(item.id, matchMedia('(max-width: 870px)').matches), chip(item.state));
      row.dataset.dashboardProject = item.id;
      if (item.registration !== 'github') {
        const execution = node('span', 'property-value small muted');
        execution.dataset.executionSummary = '';
        row.firstElementChild.append(execution);
        paintDashboardExecution(execution, item);
        const checks=item.forecast?.checkpoints;
        if (checks) row.firstElementChild.append(node('span','small muted','記録済みの受入 '+checks.accepted+'/'+checks.total+'件'));
      }
      list.append(listItem(row));
    }
    message.hidden = result.length > 0;
    if (!message.hidden) message.textContent = query ? '一致するプロジェクトがありません。' : '取得できるプロジェクトがありません。';
  }
  const search = queryInput('dashboard', 'プロジェクトを検索', 'プロジェクトを検索', filterProjects);
  searchWrap.append(search);
  const registration = projectRegistrationForm();
  if (registration) searchWrap.append(registration);
  for (const [key, intent] of ui.registrationIntents) {
    if (!key || intent.githubProject !== key) continue;
    const pending = projectRegistrationForm(null, key);
    if (pending) searchWrap.append(pending);
  }
  projects.body.remove();
  projects.root.append(searchWrap);
  const github = ui.portfolio?.githubRegistration;
  if (github) {
    const checked = github.observedAt && `GitHubで${github.count}件確認 · ${time(github.observedAt)}`;
    const label = {ready: checked, stale: checked && checked + ' · 前回の情報',
      pending: 'GitHubの案件を確認しています。',
      unavailable: 'GitHubの案件を取得できません。',
      'account-mismatch': 'GitHubの認証アカウントが登録先と一致しません。'}[github.status];
    if (label) projects.root.append(node('p', 'small muted', label));
  }
  projects.root.append(message, list);
  filterProjects(search.value);
  left.append(projects.root);
  if (ui.capabilities.tailnetPairing === true || ui.capabilities.tailnetSignIn === true) left.append(tailnetPanel());
  right.append(projectDetail());
  const outcomes = recentWorkOutcomesPanel();
  if (outcomes) right.append(outcomes);
  right.append(usagePanel());

  const devices = panel('実行端末');
  devices.root.id = 'execution-devices';
  const systems = {darwin:'macOS', win32:'Windows', linux:'Linux'};
  const platform = ui.portfolio?.appHostPlatform;
  if (Object.hasOwn(systems, platform)) {
    const host = node('div', 'device-row');
    const indicator = node('span', 'chip');
    indicator.id = 'app-host-connection';
    paintAppHostConnection(indicator);
    host.append(node('span', 'strong', 'アプリ接続先 · ' + systems[platform]), indicator);
    devices.body.append(host);
  }
  const rows = node('ul', 'rows');
  for (const device of asArray(ui.portfolio?.devices)) {
    const item = node('div', 'device-row');
    const block = node('span', 'strong', text(device.name));
    const observed = '前回の観測 ' + time(device.observedAt);
    const note = stateLabels[statusKey(device.state)] ?? text(device.state, '');
    block.append(node('span', 'small muted', note ? observed + ' · ' + note : observed));
    item.append(block, chip('unknown', '現在の端末状態は未確認'));
    rows.append(listItem(item));
  }
  if (rows.children.length) devices.body.append(rows);
  else devices.body.append(node('p', 'muted', '実行端末の観測記録を取得できません。'));
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
  dom.content.append(statistics, developmentTasks(), split);
  const limits = asArray(ui.portfolio?.limits);
  if (limits.length) {
    const findings = node('details', 'scope-info');
    findings.append(node('summary', '', '調査範囲と取得できなかった情報'));
    appendStrings(findings, limits);
    dom.content.append(findings);
  }
}

function viewResource(key, path) {
  let entry = resources.get(key);
  if (!entry) {
    entry = {};
    resources.set(key, entry);
    if (resources.size > 60) resources.delete(resources.keys().next().value);
    entry.pending = api(path).then(value => { entry.value = value; }, error => { entry.error = error.message; })
      .finally(() => { entry.pending = null; });
  }
  return entry;
}

function fetchView(key, path, container, paint, isCurrent = () => true) {
  const entry = viewResource(key, path);
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
function stopSpeech() {
  const current = activeSpeech;
  if (!current) return;
  activeSpeech = null;
  current.controller.abort();
  current.audio.pause();
  current.audio.removeAttribute('src');
  current.audio.hidden = true;
  if (current.url) URL.revokeObjectURL(current.url);
  current.toggle.textContent = '読み上げ';
  current.status.textContent = '';
}
function addDictation(area, draft) {
  const control = createLocalDictation(draft, {beforeStart: stopSpeech});
  if (control) area.append(control);
}
function speechChunks(text) {
  const speakable = text.replaceAll('[[', '[ [').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, ' ');
  const chunks = [];
  let current = '';
  for (const character of speakable) {
    if (current.length + character.length > 2000) {
      if (current.trim()) chunks.push(current);
      current = '';
    }
    current += character;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
function speechControls(project, text) {
  const control = node('div', 'speech-control');
  const status = node('span', 'small muted');
  status.setAttribute('role', 'status');
  const audio = node('audio', 'speech-audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.hidden = true;
  audio.setAttribute('aria-label', '回答の音声');
  const toggle = button('読み上げ', () => {
    if (activeSpeech?.audio === audio) {
      stopSpeech();
      return;
    }
    abortLocalDictation();
    const replacing = Boolean(activeSpeech);
    stopSpeech();
    const playback = {audio, status, toggle, controller: new AbortController(), chunks: speechChunks(text), next: 0, url: '', replacing};
    activeSpeech = playback;
    toggle.textContent = '読み上げを停止';
    void nextSpeech(playback);
  });
  function isCurrent(playback) {
    return activeSpeech === playback && control.isConnected && ui.project === project && ui.view === 'chat';
  }
  async function nextSpeech(playback) {
    if (!isCurrent(playback)) return;
    const content = playback.chunks[playback.next++];
    if (content === undefined) { stopSpeech(); return; }
    status.textContent = '音声を準備しています。';
    audio.hidden = true;
    try {
      const request = () => requestOwner(apiPath('/api/chat/speech', {project}), {method: 'POST', cache: 'no-store',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text: content}), signal: playback.controller.signal});
      let response = await request();
      if (response.status === 409 && playback.replacing && isCurrent(playback)) {
        playback.replacing = false;
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!isCurrent(playback)) return;
        response = await request();
      }
      playback.replacing = false;
      if (!isCurrent(playback)) return;
      if (response.status === 401) { endSession(); return; }
      if (!response.ok) {
        const reason = await response.json().catch(() => null);
        throw new Error(typeof reason?.error === 'string' ? reason.error : '読み上げの音声を取得できませんでした。');
      }
      const wave = await response.blob();
      if (!isCurrent(playback)) return;
      if (wave.type !== 'audio/wav' || !wave.size) throw new Error('音声形式を確認できませんでした。');
      if (playback.url) URL.revokeObjectURL(playback.url);
      playback.url = URL.createObjectURL(wave);
      audio.src = playback.url;
      audio.hidden = false;
      status.textContent = '';
      try { await audio.play(); }
      catch { if (isCurrent(playback)) status.textContent = '音声の再生を押してください。'; }
    } catch (error) {
      if (!isCurrent(playback)) return;
      stopSpeech();
      status.textContent = error.message;
    }
  }
  audio.addEventListener('ended', () => { if (activeSpeech?.audio === audio) void nextSpeech(activeSpeech); });
  audio.addEventListener('error', () => {
    if (activeSpeech?.audio !== audio) return;
    stopSpeech();
    status.textContent = '音声を再生できませんでした。';
  });
  control.append(toggle, status, audio);
  return control;
}
function chatHistoryImage(item, scope) {
  const image = item.image;
  if (!scope || !codexImageTypes.includes(image?.mime) || !Number.isSafeInteger(image.size) ||
      image.size < 1 || image.size > codexImageLimit || !/^[a-f0-9]{64}$/.test(image.sha256 ?? '') ||
      typeof item.turnId !== 'string' || !/^[a-z0-9_.:-]{1,160}$/i.test(item.turnId)) return null;
  const {project, id} = scope;
  const details = node('details', 'scope-info');
  details.append(node('summary', '', `添付画像（${Math.ceil(image.size / 1024)} KiB）`));
  details.addEventListener('toggle', () => {
    if (!details.open || !details.isConnected || ui.view !== 'chat' || ui.project !== project ||
        ui.chatIds.get(project) !== id || details.children.length !== 1) return;
    const photo = node('img', 'camera-preview');
    photo.alt = '会話に添付された画像';
    photo.referrerPolicy = 'no-referrer';
    photo.addEventListener('error', () => {
      if (photo.isConnected) photo.replaceWith(node('p', 'small muted', '添付画像を取得できませんでした。'));
    }, {once: true});
    const path = apiPath('/api/chat/live/image', {project, id, turn: item.turnId});
    details.append(photo);
    if (scope.reuseImage) {
      details.append(button('この画像を下書きに添付', () => scope.reuseImage(path, image, id)));
    }
    photo.src = path;
  });
  return details;
}
function messageBubble(item, imageScope) {
  const user = item.role === 'user';
  const box = node('div', 'message' + (user ? ' user' : ''));
  const label = (user ? 'あなた' : 'AI') + (item.createdAt ? ' · ' + time(item.createdAt) : '');
  box.append(node('span', 'small muted strong', label), node('p', '', text(item.text, '')));
  const attachment = item.document ?? item.reference;
  if (user && typeof attachment?.name === 'string' && typeof attachment.text === 'string') {
    const reference = node('details', 'scope-info');
    const original = node('pre', 'run-output', attachment.text);
    original.tabIndex = 0;
    reference.append(node('summary', '', attachment.name), original);
    box.append(reference);
  }
  if (user) {
    const image = chatHistoryImage(item, imageScope);
    if (image) box.append(image);
  }
  if (!user && ui.view === 'chat' && ui.capabilities.localSpeech === true && typeof item.text === 'string' && item.text.trim()) {
    box.append(speechControls(ui.project, item.text));
  }
  return box;
}
function apiReceiptSummary(receipts) {
  if (!receipts.length) return '';
  const input = receipts.reduce((total, item) => total + BigInt(item.inputTokens), 0n);
  const output = receipts.reduce((total, item) => total + BigInt(item.outputTokens), 0n);
  return `API応答 ${receipts.length}件 · 入力 ${input.toLocaleString('ja-JP')} · 出力 ${output.toLocaleString('ja-JP')} トークン`;
}
function showApiReceipts(destination, receipts) {
  if (!receipts.length) return;
  const details = node('details', 'scope-info');
  const responses = node('ul', 'marked-list');
  for (const item of receipts) {
    const identifier = node('code', '', text(item.id, '応答ID未取得'));
    const row = node('li');
    const details = [time(item.observedAt)];
    if (receipts.length > 1) details.push(`入力 ${item.inputTokens.toLocaleString('ja-JP')} · 出力 ${item.outputTokens.toLocaleString('ja-JP')}`);
    row.append(identifier, node('span', 'small muted', ' · ' + details.join(' · ')));
    responses.append(row);
  }
  details.append(node('summary', '', apiReceiptSummary(receipts)), responses);
  destination.append(details);
}
function messagesInto(parent, items, onTop, imageScope) {
  const payload = asArray(items).filter(item => ['user', 'assistant', 'agent'].includes(item?.role));
  const nodes = payload.map(item => messageBubble(item, imageScope));
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

function chatCodexHandoff(project, conversation, isCurrent) {
  const details = node('details', 'scope-info');
  details.append(node('summary', '', '会話と資料をCodexへ'));
  const status = node('p', 'small muted');
  status.setAttribute('role', 'status');
  const preview = node('pre', 'run-output');
  preview.tabIndex = 0;
  preview.hidden = true;
  const endPicker = node('input');
  endPicker.type = 'number';
  endPicker.min = '1';
  endPicker.step = '1';
  const label = node('label', 'picker');
  label.append(node('span', '', '最後に含める発言番号'), endPicker);
  const refresh = button('収録範囲を確認', () => void prepare());
  const attach = button('Codexの下書きに添付', stage);
  attach.disabled = true;
  let prepared;
  let loading = false;
  const draftKey = memoryKey('codex-draft', project);

  async function prepare() {
    if (loading || !details.open || !isCurrent()) return;
    prepared = undefined;
    preview.hidden = true;
    attach.disabled = true;
    const displayed = asArray(conversation.messages).length;
    const through = Number(endPicker.value);
    endPicker.max = String(displayed);
    if (!Number.isSafeInteger(through) || through < 1 || through > displayed) {
      status.textContent = '表示した発言の番号を指定してください。';
      return;
    }
    loading = true;
    refresh.disabled = true;
    status.textContent = '会話と資料を照合しています…';
    try {
      const viewed = asArray(conversation.messages).slice(Math.max(0, through - 40), through);
      const viewSha256 = await attachmentDigest(new TextEncoder().encode(JSON.stringify(viewed)));
      if (!isCurrent() || !details.open || Number(endPicker.value) !== through) return;
      const result = await api(apiPath('/api/chat/handoff',
        {project, id: conversation.id, through, observedAt: conversation.importedAt, viewSha256}),
        {signal: AbortSignal.timeout(8000)});
      const {document, range, sha256, imageCount} = result ?? {};
      if (document?.name !== 'chatgpt-handoff.json' || typeof document.text !== 'string' ||
          !Number.isSafeInteger(range?.start) || range.start < 0 || range.start >= through || range.end !== through ||
          !Number.isSafeInteger(imageCount) || imageCount < 0 || imageCount > range.end - range.start) {
        throw new Error('収録範囲を確認できませんでした。');
      }
      const bytes = new TextEncoder().encode(document.text);
      if (bytes.length > textDocumentLimit || await attachmentDigest(bytes) !== sha256) {
        throw new Error('添付資料が照合結果と一致しません。');
      }
      const packet = JSON.parse(document.text);
      if (packet.project?.id !== project || packet.source?.id !== conversation.id ||
          packet.source?.observedAt !== conversation.importedAt || packet.source?.viewSha256 !== viewSha256 ||
          packet.range?.start !== range.start || packet.range?.end !== through ||
          asArray(packet.messages).length !== range.end - range.start) {
        throw new Error('対象の会話と収録範囲を確認できませんでした。');
      }
      const digest = await attachmentDigest(bytes, document.name);
      if (!isCurrent() || !details.open || Number(endPicker.value) !== through) return;
      const rangeLabel = '発言 ' + (range.start + 1) + '〜' + range.end + ' を収録';
      status.textContent = [rangeLabel, (range.hasEarlier || range.hasLater) && 'ほかの発言は会話履歴で確認',
        imageCount && '画像' + imageCount + '件の参照を収録'].filter(Boolean).join(' · ');
      preview.textContent = document.text;
      preview.hidden = false;
      prepared = {file: new File([bytes], document.name, {type: 'application/json'}), digest, rangeLabel};
      attach.disabled = false;
    } catch (error) {
      if (isCurrent() && details.open) status.textContent = error.message;
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  }

  function stage() {
    if (!prepared || !details.open || !isCurrent() || selectedProject()?.codexWrite !== true ||
        ui.capabilities.codexWrite !== true) return;
    if (ui.runIntents.has(project) || ui.steerIntents.has(project)) {
      status.textContent = 'Codexで保留中の受付を照合してから添付してください。';
      return;
    }
    if (ui.attachmentDrafts.has(draftKey)) {
      status.textContent = 'Codexの下書きで現在の添付を確認してください。';
      return;
    }
    ui.attachmentDrafts.set(draftKey, {kind: 'document', file: prepared.file, digest: prepared.digest,
      chatHandoffLabel: prepared.rangeLabel});
    location.hash = 'codex';
  }

  endPicker.addEventListener('input', () => {
    prepared = undefined;
    attach.disabled = true;
    preview.hidden = true;
  });
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    endPicker.value = String(asArray(conversation.messages).length);
    void prepare();
  });
  details.append(label, refresh, status, preview, attach);
  return details;
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

const realtimeConversationId = /^realtime\/[a-f0-9-]{36}$/;
const realtimeContinueLabel = 'この音声会話を続ける';
const realtimeCodexLabel = 'このCodex結果を音声で相談';
const realtimeProof = /^[a-f0-9]{64}$/;
const realtimeTextLimit = 12000;
let realtimeCodexIntent;

function realtimeComposer(project, onConversation, openFromCodex = false) {
  const area = panel('音声会話（API）');
  const readOnly = ui.capabilities.realtimeVoice !== true;
  const status = node('p', 'small muted', readOnly ? '保存済みの音声受付を確認できます。' : '音声APIの利用条件を確認しています。');
  status.setAttribute('role', 'status');
  const actions = node('div', 'run-actions');
  const record = button('録音を開始', () => void (phase === 'recording' ? finish() : start()));
  const discard = button('録音を破棄', () => {
    discardAudio();
    phase = 'idle';
    status.textContent = '録音を破棄しました。';
    paint();
  });
  const submit = button('音声をAPIに送る', () => void send(), false);
  const stop = button('音声応答を中断', () => void interrupt());
  const refresh = button('利用条件を確認', () => void sync());
  const check = button('前の音声の受付を確認', () => void checkReceipt());
  const openHistory = button('音声の履歴を開く', () => { if (archive) onConversation(archive); });
  const continueHistory = button(realtimeContinueLabel, () => continueConversation(archive));
  const newConversation = button('新しい音声会話に切り替える', () => {
    if (active() && phase === 'idle' && !checking && context) changeContext(undefined);
  });
  const contextStatus = node('p', 'small muted');
  const inputMethod = labeledSelect('入力方法', {audio: '音声で入力', text: '文字で入力'});
  const textDraft = node('textarea', 'draft');
  textDraft.maxLength = realtimeTextLimit;
  const textEntry = node('label', 'picker');
  textEntry.append(node('span', '', '相談する内容'), textDraft);
  textDraft.addEventListener('input', () => {
    if (!active() || readOnly || !draftKey || phase !== 'idle') return;
    if (textDraft.value) ui.drafts.set(draftKey, textDraft.value);
    else ui.drafts.delete(draftKey);
    storeTab();
    paint();
  });
  inputMethod.input.addEventListener('change', () => {
    const selected = inputMethod.input.value;
    if (!active() || readOnly || phase !== 'idle' || checking || !['audio', 'text'].includes(selected)) {
      inputMethod.input.value = inputMode;
      return;
    }
    if (selected === inputMode) return;
    inputMode = selected;
    permission = undefined;
    status.textContent = contextNeedsSelection ? '続ける会話を選んでください。' : '音声APIの利用条件を確認しています。';
    paint();
    void sync();
  });
  const outputMode = node('select');
  for (const [value, label] of [['audio', '音声と文字'], ['text', '文字のみ']]) {
    const option = node('option', '', label);
    option.value = value;
    outputMode.append(option);
  }
  const mode = node('label', 'picker');
  mode.append(node('span', '', '応答の表示'), outputMode);
  const inputText = node('pre', 'run-output');
  inputText.setAttribute('aria-label', '入力の文字起こし');
  const answer = node('pre', 'run-output');
  answer.setAttribute('aria-label', '音声応答の文字起こし');
  actions.append(record, submit, stop, discard, check, openHistory, continueHistory, newConversation, refresh);
  area.body.append(status, contextStatus, inputMethod.field, textEntry, mode, actions, inputText, answer);

  const base = '/api/chat/realtime';
  const lifetime = new AbortController();
  const usd = new Intl.NumberFormat('ja-JP', {style: 'currency', currency: 'USD', maximumFractionDigits: 6});
  const active = () => !lifetime.signal.aborted && area.root.isConnected && ui.project === project && ui.view === 'chat';
  let permission;
  let inputMode = 'audio';
  let phase = 'idle';
  let audio;
  let mic;
  let upload;
  let pcm;
  let turnId;
  let archive;
  let archiveCanContinue = false;
  let context;
  let contextNeedsSelection = false;
  let draftKey;
  let permissionCheck;
  let checking = false;
  let interrupting = false;
  const contextReasons = {
    HANDOVER_REQUIRED: '音声相談に使う前の開発経路と共有条件を照合してください。',
    HANDOVER_RECEIPT_STALE: 'Codexの実行記録または共有条件が変わりました。スレッドを読み直して結果を選び直してください。',
    NATIVE_HANDOVER_CHECKPOINT_REQUIRED: 'Codex結果の確認済みの実行記録と共有許可が必要です。',
    NATIVE_HANDOVER_GIT_CHANGED: 'Codexが使った要求や成果物が変わりました。Gitの記録を照合してください。',
    HANDOVER_CONVERSATION_UNVERIFIED: 'Codexの完了結果と共有対象の発言を照合できません。',
    REALTIME_VOICE_HISTORY_NOT_FOUND: '選んだ音声会話が見つかりません。履歴を確認してください。',
    REALTIME_VOICE_HISTORY_CHANGED: '音声会話の履歴が変わりました。利用条件を確認し直してください。',
    REALTIME_VOICE_HISTORY_UNVERIFIED: '選んだ音声会話の履歴を照合できません。',
    REALTIME_VOICE_HISTORY_LIMIT: '音声APIに引き継げる発言数の上限に達しました。',
    REALTIME_VOICE_CONTEXT_UNVERIFIED: '過去の発言を音声APIに引き継げたことを確認できません。',
    REALTIME_VOICE_TRANSCRIPT_UNAVAILABLE: '音声と応答の確定字幕が揃っていないため、続きには引き継げません。',
  };
  const reasons = {
    ...contextReasons,
    REALTIME_VOICE_AUTHORITY_REQUIRED: 'この案件の音声APIの利用条件を確認してください。',
    REALTIME_VOICE_TARIFF_UNVERIFIED: '公式モデルと料金の上限を確認できません。',
    REALTIME_VOICE_INPUT_MODE_UNVERIFIED: '選んだ入力方法を確認できません。利用条件を確認し直してください。',
    REALTIME_TEXT_MODE_UNVERIFIED: '文字応答で想定外の音声処理を検出しました。使用量の照合までAPI実行を保留しています。',
    API_CREDIT_UNVERIFIED: '追加費用ゼロの条件と有効な組織残高を確認できません。',
    ROUTE_NOT_ALLOWED: 'この案件の実行設定では、音声APIを利用できません。',
    PROJECT_BUSY: '進行中の作業または確認待ちの使用量があります。',
    PROJECT_BUDGET_REQUIRED: 'この案件のAPI上限を設定してください。',
    PROJECT_BUDGET_EXCEEDED: 'この案件の予算内に音声を予約できません。',
    SHARED_CREDIT_INSUFFICIENT: '組織のAPI特典残高内に音声を予約できません。',
    BUDGET_RECONCILIATION_REQUIRED: '組織のAPI使用量の照合が必要です。',
    EXECUTION_HELD: 'この案件の実行は保留中です。',
  };

  function paint() {
    const typing = inputMode === 'text';
    const preparing = ['opening', 'recording', 'finishing', 'prepared'].includes(phase);
    const receiving = ['sending', 'playing'].includes(phase);
    const checkingConditions = checking || Boolean(permissionCheck);
    inputMethod.field.hidden = readOnly;
    inputMethod.input.value = inputMode;
    inputMethod.input.disabled = phase !== 'idle' || checking;
    textEntry.hidden = readOnly || !typing;
    textDraft.disabled = phase !== 'idle' || contextNeedsSelection;
    record.textContent = phase === 'recording' ? '録音を止める' : '録音を開始';
    record.hidden = typing || !permission?.available || (!['idle', 'recording'].includes(phase));
    record.disabled = checkingConditions;
    discard.hidden = !preparing;
    submit.textContent = typing ? '文字をAPIに送る' : '音声をAPIに送る';
    submit.hidden = readOnly || (typing ? phase !== 'idle' : phase !== 'prepared');
    submit.disabled = checkingConditions || !permission?.available ||
      (typing ? !textDraft.value.trim() || textDraft.value.length > realtimeTextLimit : !pcm?.byteLength);
    stop.textContent = typing ? '文字応答を中断' : '音声応答を中断';
    stop.hidden = !receiving;
    stop.disabled = interrupting;
    mode.hidden = typing || !permission?.available;
    outputMode.disabled = receiving;
    refresh.hidden = readOnly || phase !== 'idle' || contextNeedsSelection;
    refresh.disabled = checking || Boolean(permissionCheck);
    check.hidden = !ui.realtimeTurns.has(project) || phase !== 'idle';
    check.disabled = checking || Boolean(permissionCheck);
    openHistory.hidden = !archive || receiving;
    continueHistory.hidden = readOnly || phase !== 'idle' || !archiveCanContinue ||
      (archive === context?.conversation && !contextNeedsSelection);
    continueHistory.disabled = checking;
    newConversation.hidden = readOnly || phase !== 'idle' || !context;
    newConversation.disabled = checking;
    contextStatus.hidden = !context;
    const source = context?.thread ? `選んだCodex結果「${context.title}」を使います。` : '選んだ音声会話を続けます。';
    let contextDetail = typing ? '文字を送信する前に利用条件を確認してください。' : '録音の前に利用条件を確認してください。';
    if (permission?.continuation) {
      const native = permission.nativeContextCount ? `（Codexの発言${permission.nativeContextCount}件を含む）` : '';
      contextDetail = `送信すると過去の発言${permission.contextCount}件${native}も音声APIに渡ります。`;
    } else if (permission?.nativeOrigin) {
      contextDetail = `送信するとCodexの発言${permission.nativeContextCount}件も音声APIに渡ります。`;
    }
    contextStatus.textContent = contextNeedsSelection ?
      '続ける音声会話や相談するCodex結果を選ぶか、新しい音声会話に切り替えてください。' : source + contextDetail;
    inputText.hidden = !inputText.textContent;
    answer.hidden = !answer.textContent;
  }

  function discardAudio() {
    mic?.abort();
    audio?.close();
    mic = undefined;
    audio = undefined;
    pcm = undefined;
  }

  function allowedText() {
    if (!permission?.available) return reasons[permission?.reason] ?? apiWorkMessages[permission?.reason] ?? '音声APIを利用できません。';
    const limit = inputMode === 'text' ? `最大${permission.maxInputCharacters}文字` : `最大${permission.maxInputSeconds}秒`;
    return `${permission.model} · ${limit} · 1回の予約上限 ${usd.format(permission.reservedMicros / 1e6)}`;
  }

  function keyForDraft(selection) {
    if (selection?.conversation) return memoryKey('realtime-draft', project, 'archive', selection.conversation);
    if (selection?.thread) return memoryKey('realtime-draft', project, 'codex', selection.thread, selection.turn);
    return memoryKey('realtime-draft', project, 'new');
  }

  function showDraft(key) {
    if (key === draftKey) return;
    draftKey = key;
    textDraft.value = key ? ui.drafts.get(key) ?? '' : '';
  }

  function changeContext(next) {
    showDraft(keyForDraft(next));
    context = next;
    contextNeedsSelection = false;
    permission = undefined;
    status.textContent = '音声APIの利用条件を確認しています。';
    void sync();
  }

  function selectContext(id, next) {
    if (!active() || readOnly) return;
    if (phase !== 'idle' || checking) {
      setNotice('現在の応答や録音を終えてから、続ける会話を選んでください。', true);
      return;
    }
    if (ui.chatIds.get(project) !== id) onConversation(id);
    changeContext(next);
    area.root.scrollIntoView({block: 'nearest'});
  }

  function continueConversation(conversation) {
    if (realtimeConversationId.test(conversation ?? '')) selectContext(conversation, {conversation});
  }

  function consultCodex(thread, turn, title) {
    if (thread && typeof turn === 'string' && turn) {
      selectContext(`codex/${thread}`, {thread, turn, title: text(title, '完了結果')});
    }
  }

  function conversationChanged(id) {
    if (!context || id === (context.conversation ?? `codex/${context.thread}`)) { paint(); return; }
    showDraft(undefined);
    contextNeedsSelection = true;
    permission = undefined;
    permissionCheck?.abort();
    permissionCheck = undefined;
    if (['sending', 'playing'].includes(phase)) { paint(); return; }
    const wasPreparing = phase !== 'idle';
    if (wasPreparing) {
      discardAudio();
      phase = 'idle';
      status.textContent = '別の会話を選んだため、未送信の録音を破棄しました。';
    }
    paint();
  }

  async function sync(report = true) {
    if (readOnly || phase !== 'idle' || contextNeedsSelection) return;
    permissionCheck?.abort();
    const controller = new AbortController();
    permissionCheck = controller;
    const {conversation, thread, turn} = context ?? {};
    const mode = inputMode;
    paint();
    try {
      const next = await api(apiPath(base, {project, conversation, thread, turn, input: mode === 'text' ? 'text' : undefined}),
        {signal: AbortSignal.any([controller.signal, lifetime.signal])});
      if (!active() || permissionCheck !== controller) return;
      const validContext = Number.isSafeInteger(next.contextCount) && next.contextCount >= 0;
      const nativeCount = next.nativeContextCount;
      const validNativeCount = Number.isSafeInteger(nativeCount) && nativeCount > 0 && nativeCount <= next.contextCount;
      const validReview = thread ? !next.continuation && next.nativeOrigin?.threadId === thread && next.nativeTurnId === turn &&
        typeof next.nativeOrigin.operationId === 'string' && next.nativeOrigin.operationId.length > 0 &&
        realtimeProof.test(next.nativeOrigin.review ?? '') && validContext && validNativeCount && nativeCount === next.contextCount :
        !next.nativeOrigin && (conversation ? next.continuation?.id === conversation &&
          realtimeProof.test(next.continuation.review ?? '') && validContext && next.contextCount > 0 &&
          (nativeCount === undefined || validNativeCount) : !next.continuation);
      const invalidReason = !thread ? 'REALTIME_VOICE_HISTORY_UNVERIFIED' :
        next.nativeTurnId === turn ? 'HANDOVER_CONVERSATION_UNVERIFIED' : 'HANDOVER_RECEIPT_STALE';
      const validInput = mode === 'text' ? next.inputMode === 'text' && next.maxInputCharacters === realtimeTextLimit :
        next.inputMode === undefined || next.inputMode === 'audio';
      permission = next.available && (!validReview || !validInput) ? {available: false,
        reason: validInput ? invalidReason : 'REALTIME_VOICE_INPUT_MODE_UNVERIFIED'} : next;
      if (report || (context && !permission.available)) status.textContent = allowedText();
    } catch (error) {
      if (permissionCheck !== controller) return;
      permission = undefined;
      if (active() && (report || context)) status.textContent = reasons[error.code] ?? reasons[error.message] ?? error.message;
    } finally {
      if (permissionCheck === controller) {
        permissionCheck = undefined;
        if (active()) paint();
      }
    }
  }

  async function start() {
    if (!active() || inputMode !== 'audio' || phase !== 'idle' || checking || permissionCheck || !permission?.available || document.hidden) return;
    const controller = new AbortController();
    mic = controller;
    phase = 'opening';
    inputText.setAttribute('aria-label', '入力の文字起こし');
    answer.setAttribute('aria-label', '音声応答の文字起こし');
    status.textContent = 'マイクの利用を確認しています。';
    inputText.textContent = '';
    answer.textContent = '';
    archive = undefined;
    archiveCanContinue = false;
    stopSpeech();
    abortLocalDictation();
    paint();
    try {
      const opened = await openRealtimeAudio({maxSeconds: permission.maxInputSeconds, signal: controller.signal,
        onLimit: () => { if (mic === controller) void finish(); }});
      if (!active() || mic !== controller || document.hidden) { opened.close(); return; }
      audio = opened;
      phase = 'recording';
      status.textContent = '録音中です。話し終えたら録音を止めてください。';
    } catch (error) {
      if (!active() || mic !== controller) return;
      discardAudio();
      phase = 'idle';
      status.textContent = error.message;
    }
    paint();
  }

  async function finish() {
    if (!active() || phase !== 'recording' || !audio) return;
    const recording = audio;
    phase = 'finishing';
    paint();
    try {
      const captured = await recording.finish();
      if (!active() || audio !== recording) return;
      pcm = captured;
      phase = 'prepared';
      status.textContent = `${(captured.byteLength / 48000).toFixed(1)}秒の音声を録音しました。送信を押すと音声APIに渡します。`;
    } catch (error) {
      if (!active() || audio !== recording) return;
      discardAudio();
      phase = 'idle';
      status.textContent = error.message;
    }
    paint();
  }

  function showTurn(turn, wasText = turn?.inputMode === 'text') {
    archive = realtimeConversationId.test(turn?.conversationId ?? '') ? turn.conversationId : undefined;
    archiveCanContinue = Boolean(archive && turn?.continuationAvailable === true);
    const reason = reasons[turn?.reason] ?? apiWorkMessages[turn?.reason];
    const notes = {completed: archive ? (wasText ? '文字の相談をこの案件の履歴に保存しました。' : '文字起こしをこの案件の履歴に保存しました。') :
      (wasText ? '文字の応答が完了しました。履歴の保存は確認できません。' : '音声応答が完了しました。文字履歴の保存は確認できません。'),
      cancelled: '開始前に中止しました。', interrupted: wasText ? '文字応答を中断しました。' : '音声応答を中断しました。',
      failed: wasText ? '文字応答を確認できませんでした。' : '音声応答を確認できませんでした。',
      unconfirmed: wasText ? '使用量の確認待ちです。同じ文章の再送は行いません。' : '使用量の確認待ちです。同じ音声の再送は行いません。',
      running: wasText ? '文字の応答を作成中です。' : '音声APIが応答中です。', interrupting: '音声APIに中断を要求しました。'};
    status.textContent = (notes[turn?.phase] ?? '音声の状態を確認できません。') + (reason ? ' ' + reason : '');
    if (Number.isSafeInteger(turn?.accountedMicros)) status.textContent += ` 予算への計上 ${usd.format(turn.accountedMicros / 1e6)}`;
  }

  async function checkReceipt() {
    const id = ui.realtimeTurns.get(project);
    if (!active() || !id || phase !== 'idle' || checking || permissionCheck) return;
    checking = true;
    paint();
    try {
      const {turn} = await api(apiPath(base, {project, id}), {signal: lifetime.signal});
      if (active()) showTurn(turn);
    } catch (error) { if (active()) status.textContent = error.message; }
    finally { checking = false; if (active()) paint(); }
  }

  async function send() {
    const typing = inputMode === 'text';
    const message = typing ? textDraft.value : '';
    const submittedDraft = draftKey;
    if (!active() || checking || permissionCheck || !permission?.available || document.hidden ||
        (typing ? phase !== 'idle' || !submittedDraft || !message.trim() || message.length > permission.maxInputCharacters :
          phase !== 'prepared' || !pcm)) return;
    const selectedContext = context;
    const {continuation, nativeOrigin} = permission;
    if (selectedContext?.conversation !== continuation?.id || selectedContext?.thread !== nativeOrigin?.threadId ||
        (nativeOrigin && permission.nativeTurnId !== selectedContext.turn)) return;
    const controller = new AbortController();
    upload = controller;
    const playback = audio;
    const withAudio = !typing && outputMode.value === 'audio';
    phase = 'sending';
    const submittedTurn = crypto.randomUUID();
    turnId = submittedTurn;
    ui.realtimeTurns.set(project, submittedTurn);
    storeTab();
    const payload = JSON.stringify({id: submittedTurn, revision: permission.revision, ...(typing ? {text: message} : {pcm: bytesBase64(pcm)}),
      ...(continuation && {continuation: {id: continuation.id, review: continuation.review}}),
      ...(nativeOrigin && {nativeOrigin: {threadId: nativeOrigin.threadId, operationId: nativeOrigin.operationId, review: nativeOrigin.review}})});
    let contextRecheckRequired = false;
    if (typing) {
      inputText.setAttribute('aria-label', '入力した文字');
      answer.setAttribute('aria-label', '文字の応答');
      inputText.textContent = message;
      answer.textContent = '';
      archive = undefined;
      archiveCanContinue = false;
    }
    pcm = undefined;
    status.textContent = '音声APIの受付を確認しています。';
    paint();
    try {
      const response = await requestOwner(apiPath(base, {project}), {method: 'POST', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: payload, cache: 'no-store'});
      if (response.status === 401) endSession();
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        const reason = problem?.code ?? problem?.error;
        contextRecheckRequired = Object.hasOwn(contextReasons, reason);
        throw new Error(reasons[reason] ?? problem?.error ?? (typing ? '文字の応答を開始できませんでした。' : '音声応答を開始できませんでした。'));
      }
      let done = false;
      await chatEvents(response, event => {
        if (typing && event.turn?.id === submittedTurn &&
            (event.type === 'started' || (event.type === 'done' && event.replayed === true)) &&
            ui.drafts.get(submittedDraft) === message) {
          ui.drafts.delete(submittedDraft);
          if (active() && draftKey === submittedDraft && textDraft.value === message) textDraft.value = '';
          storeTab();
        }
        if (!active() || upload !== controller) return;
        if (event.type === 'started') status.textContent = typing ? '文字の応答を作成中です。' : '音声APIが応答中です。';
        if (event.type === 'audio' && withAudio && !interrupting) playback.play(event.pcm);
        if (event.type === 'transcript' && !interrupting && typeof event.text === 'string') answer.textContent += event.text;
        if (event.type === 'done') {
          done = true;
          contextRecheckRequired = Object.hasOwn(contextReasons, event.turn?.reason);
          if (!typing && typeof event.inputTranscript === 'string') inputText.textContent = event.inputTranscript;
          if (typeof event.outputTranscript === 'string') answer.textContent = event.outputTranscript;
          showTurn(event.turn, typing);
          if (archive && archive === selectedContext?.conversation && ui.chatIds.get(project) === archive) onConversation(archive);
          if (event.turn?.phase === 'completed' && selectedContext?.thread && selectedContext === context) {
            permission = undefined;
            contextNeedsSelection = true;
          }
          if (event.turn?.phase !== 'completed') playback?.stopPlayback();
        }
        paint();
      });
      if (!active() || upload !== controller) return;
      if (!done) throw new Error(typing ? '文字応答の接続が途切れました。前の受付から使用量を確認できます。' :
        '音声の接続が途切れました。前の受付から使用量を確認できます。');
      if (withAudio) {
        phase = 'playing';
        paint();
        await playback.waitForPlayback();
      }
    } catch (error) {
      if (active() && upload === controller) status.textContent = controller.signal.aborted ?
        (typing ? '文字応答の受信を終了しました。前の受付から状態を確認できます。' :
          '音声の受信を終了しました。前の受付から状態を確認できます。') : error.message;
    } finally {
      controller.abort();
      if (upload === controller) {
        upload = undefined;
        interrupting = false;
        discardAudio();
        phase = 'idle';
        const recheck = contextRecheckRequired && selectedContext && selectedContext === context;
        if (recheck) permission = undefined;
        if (active()) {
          paint();
          if (!recheck) void sync(false);
        }
      }
    }
  }

  async function interrupt() {
    if (!active() || interrupting || !['sending', 'playing'].includes(phase)) return;
    interrupting = true;
    const heardMs = audio?.stopPlayback() ?? 0;
    if (phase === 'playing') return;
    const controller = upload;
    status.textContent = '音声APIに中断を要求しています。';
    paint();
    try {
      const {turn} = await api(apiPath(base + '/interrupt', {project}), {method: 'POST', signal: lifetime.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: turnId, heardMs})});
      if (active() && upload === controller) showTurn(turn, inputMode === 'text');
    } catch {
      controller?.abort();
    }
  }

  function leaveAudio() {
    if (phase === 'idle') return;
    if (upload) {
      upload.abort();
      discardAudio();
    }
    else {
      discardAudio();
      phase = 'idle';
      status.textContent = '画面を離れたため、録音を破棄しました。';
      paint();
    }
  }
  function visibility() { if (document.hidden) leaveAudio(); }
  function cleanup() {
    lifetime.abort();
    upload?.abort();
    discardAudio();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', leaveAudio);
    runViewCleanups.delete(cleanup);
  }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', leaveAudio);
  runViewCleanups.add(cleanup);
  if (!readOnly) showDraft(keyForDraft());
  paint();
  if (!openFromCodex) void sync();
  return {root: area.root, continueConversation, consultCodex, conversationChanged};
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
  referenceLabel.append(reference, node('span', '', '選択中の会話から最近の発言とテキスト資料を引き継ぐ'));
  const attachmentField = node('div', 'stack');
  const attachmentLabel = node('label', 'picker');
  const attachmentInput = node('input');
  attachmentInput.type = 'file';
  const attachmentTitle = node('span');
  attachmentLabel.append(attachmentTitle, attachmentInput);
  const attachmentStatus = node('span', 'small muted');
  attachmentStatus.setAttribute('role', 'status');
  const imageModels = new Set();
  let consultationSettings;
  let readingAttachment = false;
  let attachmentError = '';
  let attachmentSelection = 0;
  let photoGeneration = 0;
  let disposed = false;
  const attached = () => ui.attachmentDrafts.get(draftKey);
  const draftConversationId = () => reference.checked ? ui.chatIds.get(project) ?? null : null;
  const matchesAttachmentConversation = (attachment, conversationId) =>
    !attachment || !Object.hasOwn(attachment, 'sourceConversationId') || attachment.sourceConversationId === (conversationId ?? null);
  const savedSource = attached()?.sourceConversationId;
  if (savedSource && ui.chatIds.get(project) === savedSource) reference.checked = true;
  reference.addEventListener('change', () => { closeCamera(); controls(); });
  const currentAttachmentField = () => !disposed && attachmentInput.isConnected && ui.view === 'chat' && ui.project === project;
  const imageAllowed = slug => imageModels.has(slug) &&
    !['paused', 'approval', 'limit', 'blocked', 'offline', 'waiting', 'completed'].includes(selectedProject()?.state) &&
    codexCameraRouteAllowed(consultationSettings?.value?.settings, 'consultation');
  const camera = createCodexCamera({maxBytes: codexImageLimit, onCapture: file => stageAttachment(file, true),
    onActiveChange: () => queueMicrotask(controls)});
  function closeCamera() {
    photoGeneration++;
    camera?.close();
  }
  function onVisibility() { if (document.hidden) closeCamera(); }
  if (camera) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', closeCamera);
  }
  const cleanup = () => {
    disposed = true;
    photoGeneration++;
    if (camera) {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', closeCamera);
      camera.dispose();
    }
    runViewCleanups.delete(cleanup);
  };
  runViewCleanups.add(cleanup);
  model.addEventListener('change', () => { closeCamera(); controls(); });
  const clearAttachment = button('添付を外す', () => {
    closeCamera();
    attachmentSelection++;
    readingAttachment = false;
    attachmentError = '';
    ui.attachmentDrafts.delete(draftKey);
    controls();
  });
  async function stageAttachment(file, captured = false) {
    if (!file || !currentAttachmentField()) return;
    if (!captured) closeCamera();
    const isImage = codexImageTypes.includes(file.type);
    const selectedModel = model.value;
    const sourceConversationId = draftConversationId();
    const pending = ui.chatIntents.get(project);
    if (captured && (document.hidden || pending || chatStreams.has(project) || !imageAllowed(selectedModel))) return;
    const generation = photoGeneration;
    const selection = ++attachmentSelection;
    readingAttachment = true;
    attachmentError = '';
    controls();
    const checkSelection = () => selection === attachmentSelection && currentAttachmentField();
    try {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (isImage) {
        if (!imageAllowed(selectedModel)) throw new Error('画像入力に対応する相談経路とモデルを確認してください。');
        if (!file.size || file.size > codexImageLimit) throw new Error('512 KiB以下の画像を選んでください。');
      } else if (!file.size || file.size > textDocumentLimit || !textDocumentExtensions.includes(ext)) {
        throw new Error('16 KiB以下のテキスト、Markdown、CSV、JSONを選んでください。');
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let document;
      if (!isImage) {
        try { document = {name: file.name, text: documentDecoder.decode(bytes)}; }
        catch { throw new Error('UTF-8で保存した資料を選んでください。'); }
      }
      const digest = await attachmentDigest(bytes, isImage ? '' : file.name);
      if (!checkSelection() || (captured && (generation !== photoGeneration ||
          sourceConversationId !== draftConversationId() || !imageAllowed(model.value)))) return;
      ui.attachmentDrafts.set(draftKey, isImage ? {file, digest, ...(captured && {sourceConversationId})} : {document, digest});
    } catch (error) {
      if (checkSelection()) attachmentError = error.message;
    } finally {
      if (checkSelection()) { readingAttachment = false; controls(); }
    }
  }
  attachmentInput.addEventListener('change', () => {
    const file = attachmentInput.files?.[0];
    attachmentInput.value = '';
    void stageAttachment(file);
  });
  async function reuseImage(path, expected, conversationId) {
    if (!currentAttachmentField() || ui.chatIds.get(project) !== conversationId) return;
    if (!imageAllowed(model.value) || readingAttachment || ui.chatIntents.has(project) || chatStreams.has(project)) {
      setNotice('画像に対応するモデルを選び、保留中の応答を確認してから添付してください。', true);
      return;
    }
    closeCamera();
    const generation = photoGeneration;
    const selection = ++attachmentSelection;
    const isCurrent = () => selection === attachmentSelection && currentAttachmentField();
    const sameConversation = () => generation === photoGeneration && ui.chatIds.get(project) === conversationId;
    readingAttachment = true;
    attachmentError = '';
    controls();
    try {
      const response = await requestOwner(path);
      if (response.status === 401) { endSession(); return; }
      if (!response.ok || response.headers.get('content-type') !== expected.mime) {
        throw new Error('添付画像を取得できませんでした。');
      }
      const bytes = await response.arrayBuffer();
      const digest = await attachmentDigest(new Uint8Array(bytes));
      if (!isCurrent() || !sameConversation()) return;
      if (bytes.byteLength !== expected.size || digest !== expected.sha256) {
        throw new Error('保存した画像と一致しません。');
      }
      const suffix = expected.mime === 'image/jpeg' ? 'jpg' : expected.mime.slice(6);
      ui.attachmentDrafts.set(draftKey, {file: new File([bytes], '添付画像.' + suffix, {type: expected.mime}),
        digest, sourceConversationId: conversationId});
      reference.checked = true;
      draft.focus();
    } catch (error) {
      if (isCurrent() && sameConversation()) attachmentError = error.message;
    } finally {
      if (isCurrent()) { readingAttachment = false; controls(); }
    }
  }
  attachmentField.append(attachmentLabel);
  if (camera) attachmentField.append(camera.root);
  attachmentField.append(attachmentStatus, clearAttachment);
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
  picks.append(modelLabel, referenceLabel, draftLabel);
  addDictation(picks, draft);
  picks.append(attachmentField, actions, output);
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
  function matchesAttachment(intent, attachment) {
    if (intent?.imageSha256) return Boolean(attachment?.file && attachment.digest === intent.imageSha256);
    if (intent?.documentDigest) return Boolean(attachment?.document && attachment.digest === intent.documentDigest);
    return true;
  }
  function controls() {
    if (!currentAttachmentField()) return;
    const active = chatStreams.get(project)?.controller;
    const pending = ui.chatIntents.get(project);
    const attachment = attached();
    const allowsImage = imageAllowed(model.value);
    const imageBlocked = Boolean((attachment?.file || pending?.imageSha256) &&
      (!allowsImage || (pending?.imageSha256 && !imageAllowed(pending.model))));
    const wrongConversation = !matchesAttachmentConversation(attachment, draftConversationId());
    const needsFile = !matchesAttachment(pending, attachment);
    camera?.setAvailable(canSend && allowsImage && !active && !pending && !readingAttachment);
    send.disabled = !canSend || Boolean(active || pending || camera?.active) || readingAttachment ||
      Boolean(attachmentError) || imageBlocked || wrongConversation;
    stop.hidden = !active;
    check.hidden = !ui.chatTurns.has(project) || Boolean(active);
    retry.hidden = !pending || Boolean(active);
    retry.disabled = readingAttachment || needsFile || imageBlocked || wrongConversation || Boolean(camera?.active || attachmentError);
    discard.hidden = retry.hidden;
    output.hidden = !output.textContent;
    attachmentInput.accept = [...textDocumentExtensions, ...(allowsImage ? codexImageTypes : [])].join(',');
    attachmentTitle.textContent = allowsImage ? '画像・テキスト資料を添付（画像512 KiB、資料16 KiBまで）'
      : 'テキスト資料を添付（16 KiBまで）';
    attachmentInput.disabled = Boolean(active || camera?.active) || (Boolean(pending) && !pending.documentDigest && !pending.imageSha256);
    clearAttachment.hidden = !attachment && !attachmentError && !readingAttachment;
    clearAttachment.disabled = Boolean(active);
    attachmentStatus.textContent = readingAttachment ? '添付を照合しています。' : attachmentError ||
      (wrongConversation ? '元の会話を引き継ぐか、添付を外してください。' :
        imageBlocked ? '画像に対応する相談経路とモデルを確認してください。' :
          needsFile ? (pending.imageSha256 ? '再送するには最初と同じ画像を選んでください。' : '再送するには最初と同じ資料を選んでください。') :
            attachment?.file?.name ?? attachment?.document?.name ?? '');
  }
  function showTurn(turn, selectConversation = true) {
    if (!turn) { status.textContent = 'この受付番号の応答はまだ確認できません。'; return; }
    status.textContent = phaseText[turn.status] ?? '応答の状態を確認できません。';
    output.textContent = typeof turn.text === 'string' ? turn.text : '';
    const terminal = turn.status !== 'in_progress' && Object.hasOwn(phaseText, turn.status);
    const intent = ui.chatIntents.get(project);
    if (terminal && intent?.id === turn.id) {
      ui.chatIntents.delete(project);
      if ((intent.documentDigest || intent.imageSha256) && matchesAttachment(intent, attached())) ui.attachmentDrafts.delete(draftKey);
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
    if (!currentAttachmentField() || camera?.active || send.disabled || !prompt || !model.value) {
      if (!prompt) status.textContent = '相談する内容を入力してください。';
      return;
    }
    const conversationId = draftConversationId() ?? undefined;
    if (conversationId && /^(?:api|codex|realtime)\//.test(conversationId)) {
      status.textContent = '別の経路の記録をChatGPTプランに引き継ぐには、作業の照合が必要です。';
      return;
    }
    abortLocalDictation(draft);
    const id = crypto.randomUUID();
    const attachment = attached();
    ui.chatIntents.set(project, {id, conversationId, model: model.value, prompt,
      ...(attachment?.file ? {imageSha256: attachment.digest} : attachment ? {documentDigest: attachment.digest} : {})});
    ui.chatTurns.set(project, id);
    storeTab();
    void submitIntent();
  }
  async function submitIntent() {
    const intent = ui.chatIntents.get(project);
    if (!currentAttachmentField() || !intent || !canSend || chatStreams.has(project) || readingAttachment || camera?.active || attachmentError) return;
    const {documentDigest, imageSha256, ...payload} = intent;
    const attachment = attached();
    if (!matchesAttachment(intent, attachment)) {
      status.textContent = imageSha256 ? '最初と同じ画像を選んでから再送してください。' : '最初と同じ資料を選んでから再送してください。';
      return;
    }
    if (!matchesAttachmentConversation(attachment, intent.conversationId) ||
        !matchesAttachmentConversation(attachment, draftConversationId())) return;
    if (imageSha256 && (!imageAllowed(model.value) || !imageAllowed(intent.model))) {
      status.textContent = '画像入力に対応する相談経路とモデルを確認してください。';
      return;
    }
    const controller = new AbortController();
    const selected = ui.chatIds.get(project);
    chatStreams.set(project, {controller});
    output.textContent = '';
    status.textContent = 'ChatGPTに送っています…';
    controls();
    try {
      if (documentDigest) payload.document = attachment.document;
      if (imageSha256) {
        const bytes = new Uint8Array(await attachment.file.arrayBuffer());
        if (!currentAttachmentField()) return;
        if (document.hidden || controller.signal.aborted || ui.chatIntents.get(project) !== intent ||
            ui.chatIds.get(project) !== selected || !matchesAttachmentConversation(attachment, draftConversationId()) ||
            !imageAllowed(model.value) || !imageAllowed(intent.model)) {
          status.textContent = '画像の送信を保留しました。相談先を確認して同じ受付番号を使えます。';
          return;
        }
        payload.image = {mime: attachment.file.type, data: bytesBase64(bytes)};
      }
      const response = await requestOwner(apiPath('/api/chat/live', {project}), {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
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
      if (!currentAttachmentField()) return;
      if (!['connected', 'refresh_required'].includes(account.status)) {
        status.textContent = account.status === 'storage_unavailable' ? 'この端末でChatGPTプランの認証を保存できません。' :
          'ChatGPTプランで相談するには、このアプリの利用を承認してください。';
        signIn.hidden = account.status === 'storage_unavailable';
        return;
      }
      const {models} = await api('/api/chat/plan/models');
      if (!currentAttachmentField()) return;
      for (const entry of asArray(models)) {
        const option = node('option', '', entry.displayName);
        option.value = entry.slug;
        if (entry.acceptsImages === true) imageModels.add(entry.slug);
        model.append(option);
      }
      const pendingModel = ui.chatIntents.get(project)?.model;
      if (pendingModel && Array.from(model.options).some(option => option.value === pendingModel)) model.value = pendingModel;
      if (imageModels.size) {
        consultationSettings = viewResource(memoryKey('execution-settings', project), apiPath('/api/execution/settings', {project}));
        if (consultationSettings.pending) void consultationSettings.pending.then(controls);
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
  const conversationChanged = () => { closeCamera(); controls(); };
  return {root: area.root, conversationChanged, reuseImage};
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
function mountChatHandoff(destination, project, conversation, isCurrent) {
  const receipt = conversation.id.slice('api/'.length);
  const proof = node('p', 'small muted');
  proof.setAttribute('role', 'status');
  proof.hidden = true;
  let review = null;
  let run;
  const verify = button('Codexへの引継ぎを照合', async () => {
    if (!isCurrent() || !proof.isConnected) return;
    review = null;
    run?.paint();
    verify.disabled = true;
    proof.hidden = false;
    proof.textContent = '要求、会話、Git上の成果物を照合しています。';
    try {
      const result = await api(apiPath('/api/execution/handover', {project, receipt}), {signal: AbortSignal.timeout(14000)});
      if (!isCurrent() || !proof.isConnected) return;
      if (!result.verified || result.receipt !== receipt || !/^[a-f0-9]{64}$/.test(result.review ?? '')) {
        proof.textContent = '引継ぎの照合結果を確認できませんでした。';
        return;
      }
      review = result.review;
      proof.textContent = `照合済み ${result.requirements.path} · 成果物 ${result.artifacts.length}件 · Git ${result.checkoutHead.slice(0, 12)}`;
      run?.paint();
    } catch (error) { if (isCurrent() && proof.isConnected) proof.textContent = error.message; }
    finally { if (isCurrent() && proof.isConnected) verify.disabled = false; }
  });
  destination.append(verify, proof);
  if (ui.capabilities.codexWrite !== true || selectedProject()?.codexWrite !== true) return;

  const root = node('div', 'stack');
  root.hidden = true;
  const key = memoryKey('codex-handoff-draft', project, receipt);
  const draft = node('textarea', 'draft');
  draft.maxLength = 16000;
  draft.value = ui.drafts.get(key) ?? '';
  draft.addEventListener('input', () => { ui.drafts.set(key, draft.value); storeTab(); });
  const label = node('label', 'picker');
  label.append(node('span', '', 'Codexで続ける指示'), draft);
  root.append(label);
  addDictation(root, draft);
  destination.append(root);
  run = mountCodexRun({root, body: root}, project, draft, key, () => ({route: 'subscription', stage: 'implementation'}), null, {
    handoff: {
      receipt, isCurrent, review: () => review,
      invalidate() {
        review = null;
        if (isCurrent() && proof.isConnected) proof.textContent = '引継ぎの照合を更新してください。';
      },
    },
  });
  return run.cleanup;
}
function chatDevelopmentPanel(project) {
  const area = panel('開発状況');
  area.root.id = 'chat-development';
  area.root.classList.add('chat-development');
  area.root.hidden = true;
  area.header.firstElementChild.id = 'chat-development-title';
  area.root.setAttribute('aria-labelledby', 'chat-development-title');
  area.body.append(node('p', 'strong', project.name));
  const metrics = node('dl', 'properties');
  metric(metrics, '案件の記録', stateLabels[project.state]);
  metric(metrics, '正式な要求達成率', project.measurements?.formalCompletion, true);
  const remaining = metric(metrics, '残り作業時間', estimateLabel(project.schedule?.remainingMinutes));
  markProjectEstimateExpiry(remaining, project, project.schedule?.estimatedFinish);
  const finish = metric(metrics, '完成予定', time(project.measurements?.estimateFinish));
  markProjectEstimateExpiry(finish, project, project.measurements?.estimateFinish);
  metric(metrics, '案件データの取得時刻', time(project.observedAt ?? ui.portfolio?.observedAt));
  area.body.append(metrics);
  if (project.schedule?.delayed === true) area.body.append(node('p', 'chip notice-chip', '当初予定に対して遅延しています'));
  const task = asArray(project.tasks).find(item => item.status !== 'verified');
  if (task) {
    const current = node('p', 'task-title');
    current.append(node('strong', '', task.title), taskStatus(task));
    const taskMetrics = node('dl', 'properties');
    metric(taskMetrics, 'タスクの進捗率', taskProgressLabel(task.progress));
    taskMetrics.append(node('dt', '', 'タスクの残り作業時間'), taskEstimateReadout(task));
    area.body.append(node('h3', '', '確認が残るタスク'), current, taskMetrics);
    if (task.observedAt) area.body.append(node('p', 'small muted', 'タスクの記録 ' + time(task.observedAt)));
  }
  if (ui.capabilities.executionActivity === true) area.body.append(activityPanel());
  return area.root;
}

function syncChatDevelopment() {
  const panel = document.getElementById('chat-development');
  const toggle = dom['chat-development-toggle'];
  const available = Boolean(panel) && chatDevelopmentWidth.matches;
  const visible = available && ui.showChatDevelopment;
  const focused = document.activeElement;
  toggle.hidden = !available;
  toggle.setAttribute('aria-expanded', String(visible));
  if (!panel) return;
  if (!visible && (panel.contains(focused) || (!available && focused === toggle))) {
    (available ? toggle : dom['refresh-button']).focus({preventScroll: true});
  }
  panel.hidden = !visible;
  panel.parentElement.classList.toggle('with-development', visible);
  if (visible) refreshEstimateReadouts();
}

function chat() {
  const details = selectedProject();
  const requestedVoice = realtimeCodexIntent?.project === details?.id ? realtimeCodexIntent : undefined;
  realtimeCodexIntent = undefined;
  if (!details) return emptyProject();
  if (details.registration === 'github') return projectNeedsWorkspace();
  const project = details.id;
  const layout = node('div', 'split conversation-layout');
  const collection = panel('会話履歴');
  const thread = panel('会話');
  const readContainer = thread.body;
  const adviceHost = node('div', 'stack');
  const items = node('div');
  const searchWrap = node('div', 'search-wrap');
  const codexStatus = node('div', 'small muted');
  const codexThreads = new Map();
  let debounce;
  let nextThreadPage = null;
  let explicitSelection = Boolean(ui.chatIds.get(project));
  let cleanupHandoff;
  let cleanupAdvice;
  let advisoryThread;
  let plan;
  let realtime;
  let previousConversation;
  function showAdvice(nativeId) {
    if (ui.capabilities.apiDevelopment !== true || advisoryThread === nativeId) return;
    advisoryThread = nativeId;
    cleanupAdvice?.();
    const advice = apiAdviceComposer(project, () => {
      if (ui.view !== 'chat' || ui.project !== project || !layout.isConnected) return;
      evictChats(project);
      searchChats(search.value);
    }, nativeId);
    adviceHost.replaceChildren(advice.root);
    cleanupAdvice = advice.cleanup;
  }
  function showChatDetails() {
    abortLocalDictation();
    stopSpeech();
    cleanupHandoff?.();
    cleanupHandoff = undefined;
    const id = ui.chatIds.get(project);
    if (previousConversation !== id) {
      previousConversation = id;
      plan?.conversationChanged();
      realtime?.conversationChanged(id);
    }
    const nativeId = id?.startsWith('codex/') ? id.slice('codex/'.length) : null;
    showAdvice(nativeId);
    if (!id) {
      readContainer.replaceChildren(node('p', 'muted', '履歴から会話を選んでください。'));
      return;
    }
    const detail = (offset, cursor) => nativeId ? apiPath('/api/codex/thread', {project, id: nativeId, cursor}) : apiPath('/api/chat', {project, id, offset});
    const key = memoryKey('chat-detail', project, id);
    fetchView(key, detail(0), readContainer, (result, destination) => {
      cleanupHandoff?.();
      cleanupHandoff = undefined;
      const conversation = nativeId ? {title: result?.thread?.title, source: 'codex-history', importedAt: result?.thread?.updatedAt,
        messages: asArray(result?.turns).flatMap(turn => asArray(turn.messages))} : result?.conversation;
      if (!conversation) {
        destination.append(node('p', 'empty', '会話を読み込めませんでした。'));
        return;
      }
      thread.header.replaceChildren(node('h2', '', text(conversation.title, '会話')));
      const apiArchive = conversation.source === 'api-development';
      const source = chatSourceLabels[conversation.source] ?? '取得元未確認';
      const observed = conversation.source === 'chatgpt-export' ? '取り込み ' : '更新 ';
      destination.append(node('p', 'small muted', `${source} · ${observed}${time(conversation.importedAt)}`));
      if (apiArchive) {
        const status = conversation.outcome === 'in_progress' ? '実行中' : activityLabels[conversation.outcome] ?? '状態未確認';
        destination.append(node('p', 'small muted', [status, text(conversation.model, '')].filter(Boolean).join(' · ')));
        showApiReceipts(destination, asArray(conversation.providerReceipts));
      }
      const messages = node('div', 'messages messages-embedded');
      destination.append(messages);
      const empty = node('p', 'muted', '表示できる発言がありません。');
      const imageScope = conversation.source === 'chatgpt-live' ? {project, id, reuseImage: plan?.reuseImage} : undefined;
      if (!messagesInto(messages, conversation.messages, false, imageScope)) messages.append(empty);
      let offset = result.nextOffset;
      let cursor = result.nextCursor;
      const detailIsCurrent = () => messages.isConnected && ui.project === project && ui.chatIds.get(project) === id;
      if (conversation.source === 'openai-realtime' && ui.capabilities.realtimeVoice === true && realtimeConversationId.test(id) &&
          asArray(conversation.messages).some(message => typeof message.turnId === 'string')) {
        const continueVoice = button(realtimeContinueLabel, () => {
          if (detailIsCurrent()) realtime?.continueConversation(id);
        });
        destination.insertBefore(continueVoice, messages);
      }
      const voiceTurn = nativeId && asArray(result?.turns).at(-1);
      if (nativeId && result?.thread?.id === nativeId && ui.capabilities.realtimeVoice === true &&
          voiceTurn?.status === 'completed' && typeof voiceTurn.id === 'string' && voiceTurn.id) {
        const consultVoice = button(realtimeCodexLabel, () => {
          if (detailIsCurrent()) realtime?.consultCodex(nativeId, voiceTurn.id, conversation.title);
        });
        destination.insertBefore(consultVoice, messages);
      }
      const transfer = button('表示中のAI回答をCodexの下書きに追加', () => {
        const recent = asArray(conversation.messages).findLast(message => message.role === 'assistant');
        moveToDraft(project, 'codex', recent, 'この案件でのChatGPTの回答');
      });
      function updateTransfer() {
        transfer.hidden = Boolean(nativeId) || apiArchive || !asArray(conversation.messages).some(message => message.role === 'assistant' && message.text);
      }
      const canLoad = () => nativeId ? Boolean(cursor) : Number.isSafeInteger(offset);
      const load = button(nativeId ? '以前のターンを表示' : '続きの発言を表示', async () => {
        load.disabled = true;
        try {
          const page = await api(detail(offset, cursor));
          if (!detailIsCurrent()) return;
          if (nativeId) {
            const turns = asArray(page.turns);
            if (messagesInto(messages, turns.flatMap(turn => asArray(turn.messages)), true)) empty.remove();
            result.turns = [...turns, ...asArray(result.turns)];
            result.nextCursor = page.nextCursor !== cursor ? page.nextCursor : null;
            cursor = result.nextCursor;
            messages.prepend(load);
          } else {
            const added = asArray(page.conversation?.messages);
            if (messagesInto(messages, added, false, imageScope)) empty.remove();
            conversation.messages = [...asArray(conversation.messages), ...added];
            updateTransfer();
            result.nextOffset = page.nextOffset;
            offset = page.nextOffset;
            messages.append(load);
          }
          load.hidden = !canLoad();
        } catch (error) { if (detailIsCurrent()) setNotice(error.message, true); }
        finally { load.disabled = false; }
      });
      load.hidden = !canLoad();
      if (nativeId) messages.prepend(load);
      else messages.append(load);
      updateTransfer();
      destination.append(transfer);
      if (['chatgpt-export', 'chatgpt-live'].includes(conversation.source) && asArray(conversation.messages).length &&
          selectedProject()?.codexWrite === true && ui.capabilities.codexWrite === true) {
        destination.append(chatCodexHandoff(project, conversation, detailIsCurrent));
      }
      if (apiArchive && conversation.outcome === 'completed') {
        cleanupHandoff = mountChatHandoff(destination, project, conversation, detailIsCurrent);
      }
    }, () => ui.chatIds.get(project) === id);
  }
  function searchChats(query) {
    const key = memoryKey('chat-index', project, query);
    const path = apiPath('/api/chat', {project, q: query});
    fetchView(key, path, items, (result, destination) => {
      const needle = query.trim().toLowerCase();
      const conversations = [...asArray(result?.conversations),
        ...[...codexThreads.values()].filter(thread => !needle || (thread.title ?? '').toLowerCase().includes(needle))]
        .sort((a, b) => (Date.parse(b.importedAt) || 0) - (Date.parse(a.importedAt) || 0));
      if (!conversations.length) {
        destination.append(node('p', 'empty', query ? '一致する会話がありません。' : 'このプロジェクトの会話履歴はありません。'));
        if (!ui.chatIds.get(project)) showChatDetails();
        return;
      }
      if (!explicitSelection && !needle && ui.chatIds.get(project) !== conversations[0].id) {
        ui.chatIds.set(project, conversations[0].id);
        storeTab();
        showChatDetails();
      }
      const rows = node('ul', 'rows');
      for (const conversation of conversations) {
        rows.append(listItem(rowButton(text(conversation.title, '無題の会話'),
          `${chatSourceLabels[conversation.source] ?? '取得元未確認'} · ${time(conversation.importedAt)}`,
          ui.chatIds.get(project) === conversation.id, event => {
            explicitSelection = true;
            ui.chatIds.set(project, conversation.id);
            storeTab();
            for (const row of rows.querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === event.currentTarget));
            showChatDetails();
          })));
      }
      destination.append(rows);
      if (needle && codexThreads.size) destination.append(node('p', 'small muted', 'Codexは取得済みのスレッド名を検索します。'));
    }, () => search.value === query);
  }
  const search = queryInput(routeKey(), '会話を検索', 'タイトル・本文を検索', query => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (items.isConnected) searchChats(query); }, 180);
  });
  const nextCodex = button('以前のCodexスレッドを取得', async () => {
    nextCodex.disabled = true;
    try {
      const page = await api(apiPath('/api/codex/threads', {project, cursor: nextThreadPage}));
      if (layout.isConnected) recordCodexPage(page);
    } catch (error) { setNotice(error.message, true); }
    finally { nextCodex.disabled = false; }
  });
  function recordCodexPage(page) {
    for (const row of asArray(page.data)) {
      if (typeof row.id !== 'string' || !row.id) continue;
      const id = `codex/${row.id}`;
      codexThreads.set(id, {id, title: row.title, importedAt: row.updatedAt, source: 'codex-history'});
    }
    nextThreadPage = page.nextCursor !== nextThreadPage ? page.nextCursor : null;
    nextCodex.hidden = !nextThreadPage;
    codexStatus.append(nextCodex);
    searchChats(search.value);
  }
  searchWrap.append(search);
  collection.body.remove();
  collection.root.append(searchWrap, items, codexStatus);
  if (ui.capabilities.chatImport === true) collection.root.append(importSection(project));
  const current = node('div', 'stack');
  current.append(thread.root);
  function selectConversation(id) {
    if (ui.view !== 'chat' || ui.project !== project || !layout.isConnected) return;
    explicitSelection = true;
    ui.chatIds.set(project, id);
    storeTab();
    evictChats(project);
    showChatDetails();
    searchChats(search.value);
  }
  if (ui.capabilities.chatgptPlan === true) {
    plan = planComposer(project, selectConversation);
    current.append(plan.root);
  }
  if (ui.capabilities.realtimeVoice === true || ui.realtimeTurns.has(project)) {
    realtime = realtimeComposer(project, selectConversation, Boolean(requestedVoice));
    current.append(realtime.root);
  }
  if (ui.capabilities.apiDevelopment === true) current.append(adviceHost);
  layout.append(collection.root, current, chatDevelopmentPanel(details));
  dom.content.append(layout);
  if (requestedVoice && ui.capabilities.realtimeVoice === true) {
    explicitSelection = true;
    ui.chatIds.set(project, `codex/${requestedVoice.thread}`);
    storeTab();
    realtime.consultCodex(requestedVoice.thread, requestedVoice.turn, requestedVoice.title);
  }
  showChatDetails();
  searchChats(search.value);
  if (selectedProject()?.codexScopes) {
    fetchView(memoryKey('codex-index', project), apiPath('/api/codex/threads', {project}), codexStatus, recordCodexPage);
  }
}
const effortLabels = {
  minimal: '最小', low: '低', medium: '標準', high: '高', xhigh: '非常に高い', max: '最大', ultra: '最高',
};
const runPhases = {
  reserved: '受付済み',
  sending: 'Codexへ送信中',
  running: '実行中',
  interrupting: '中断を要求中',
  cancelling: '中止を照合中',
  unconfirmed: '実行状態未確認',
  completed: 'Codexターン完了',
  interrupted: '中断済み',
  cancelled: '中止済み',
  failed: '実行失敗',
};
const pollingPhases = new Set(['reserved', 'sending', 'running', 'interrupting', 'cancelling', 'unconfirmed']);
const finishedPhases = new Set(['completed', 'interrupted', 'cancelled', 'failed']);

const apiWorkMessages = {
  API_AUTHORIZATION_REQUIRED: 'この端末の通常API認証を確認できません。',
  API_RUNTIME_UNSUPPORTED: 'この端末で通常APIの隔離実行を確認できません。',
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
  NATIVE_HANDOVER_ENROLLMENT_REQUIRED: 'この案件で通常APIに送信できる資料と引継ぎ資料を照合してください。',
  NATIVE_HANDOVER_GIT_CHANGED: '引継ぐ要求・成果物が変わりました。Gitの記録を照合してください。',
  INTERRUPTED: 'API作業を中断しました。',
};

const apiAdviceStages = {consultation: '相談', design: '設計'};
const codexImageTypes = ['image/png', 'image/jpeg', 'image/webp'];
const codexImageLimit = 512 * 1024;
const textDocumentLimit = 16 * 1024;
const textDocumentExtensions = ['.txt', '.md', '.markdown', '.csv', '.json'];
const documentDecoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

async function attachmentDigest(bytes, filename = '') {
  let input = bytes;
  if (filename) {
    const prefix = new TextEncoder().encode(filename + '\0');
    input = new Uint8Array(prefix.length + bytes.length);
    input.set(prefix);
    input.set(bytes, prefix.length);
  }
  const hash = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesBase64(bytes) {
  const characters = [];
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    characters.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
  }
  return btoa(characters.join(''));
}

function codexCameraRouteAllowed(settings, stage, route) {
  if (!asArray(settings?.allowedRoutes).includes('subscription')) return false;
  if (route) return route === 'subscription';
  if (settings.mode === 'hybrid') return settings.stageRoutes?.[stage] === 'subscription';
  if (settings.mode === 'auto') return settings.preference === 'subscription-first' ||
    (settings.preference === 'api-first' && settings.allowFallback === true);
  return settings.mode === 'subscription-only';
}

function mountCodexRun(area, project, draft, draftKey, choices, apiReady, {handoff, advice, imageModel, cameraSettings, target} = {}) {
  const apiMode = Boolean(apiReady);
  const runKey = apiMode ? memoryKey('api-work', project) : project;
  const native = advice?.native;
  const stateKey = target ? memoryKey('codex-thread-run', project, target.id) : handoff ? memoryKey('codex-handoff', project, handoff.receipt) :
    native ? memoryKey('api-native-handoff', project, native.threadId) : runKey;
  const path = apiMode ? '/api/execution/api' : '/api/codex/run';
  const run = runStates.get(stateKey) ?? {operation: null, known: false, busy: false, checking: false, message: ''};
  run.key = runKey;
  runStates.set(stateKey, run);
  function paintRelatedRuns() {
    for (const other of runStates.values()) {
      if (other !== run && other.key === runKey) other.onChange?.();
    }
  }
  const intentReceipt = intent => intent?.handover?.receipt ?? intent?.draftReceipt;
  const intentDraftKey = intent => intent?.expectedThreadId ? memoryKey('codex-thread-draft', project, intent.expectedThreadId) :
    intentReceipt(intent) ? memoryKey('codex-handoff-draft', project, intentReceipt(intent)) : draftKey;
  const matchesStage = entry => !apiMode ||
    (Object.hasOwn(apiAdviceStages, entry?.stage) === Boolean(advice) && entry?.nativeOrigin?.threadId === native?.threadId);
  const currentIntent = () => {
    const intent = ui.runIntents.get(runKey);
    return matchesStage(intent) && (apiMode || intent?.expectedThreadId === target?.id) &&
      (!handoff || intentReceipt(intent) === handoff.receipt) ? intent : undefined;
  };
  const pendingElsewhere = () => {
    const intent = !apiMode && ui.runIntents.get(runKey);
    return Boolean(intent && (target || intent.expectedThreadId) && !currentIntent());
  };
  const section = node('section', 'run-control');
  const caption = node('p', 'muted small', advice ? '案件の承認済み資料を使い、回答を会話履歴に保存します。'
    : apiMode ? '許可済みのファイルを分離作業先で編集し、テストを実行します。'
    : '指示は、このプロジェクト専用の分離作業先で実行されます。');
  const status = node('p', 'strong');
  status.setAttribute('role', 'status');
  const details = node('p', 'muted small');
  const warning = node('p', 'run-warning small');
  const steeringStatus = node('p', 'muted small');
  steeringStatus.setAttribute('role', 'status');
  const output = node('pre', 'run-output');
  output.setAttribute('aria-label', advice ? '通常APIの回答' : apiMode ? 'API作業の検証結果' : 'Codexの実行中の出力');
  output.tabIndex = 0;
  const artifacts = node('ul', 'marked-list');
  const actions = node('div', 'run-actions');
  const send = button(handoff ? '引継いでCodexを開始' : native ? '引継いで通常APIに送る' : advice ? '通常APIに送る' :
    apiMode ? '通常APIで開発を開始' : '分離作業先に送信', () => submitNew(), false);
  const resume = button('同じスレッドへ追加指示', () => submitNew(run.operation), true);
  const interrupt = button('中断を要求', async () => {
    if (run.busy || run.checking || !isCurrent() || !canInterrupt()) return;
    const id = run.operation.id;
    await mutate(apiMode ? `${path}/interrupt` : '/api/codex/interrupt', {id});
  }, true);
  const cancel = button('作業を中止', async () => {
    if (run.busy || run.checking || !isCurrent() || !canCancel()) return;
    const id = run.operation.id;
    if (!window.confirm('このCodex作業を中止して、受付を終了しますか？作業履歴と作成済みのファイルは保持します。')) return;
    await mutate('/api/codex/cancel', {id});
  });
  const steer = button('実行中に追加指示・優先順位変更', () => sendSteering(), true);
  const checkSteer = button('追加指示の状態を照合', () => requestSteering(false), true);
  const closeSteer = button('この確認を閉じる', () => {
    if (!steeringIntent()) return;
    ui.steerIntents.delete(project);
    storeTab();
    run.steerMessage = '';
    paint();
  });
  const recover = button('同じ受付番号で再送', async () => {
    const intent = currentIntent();
    if (!run.busy && !run.checking && intent && reviewMatches(intent)) await mutate(path, intent);
  }, true);
  const check = button('作業状態を確認', () => lookup(), true);
  actions.append(send, resume, steer, interrupt, cancel, recover, check, checkSteer, closeSteer);
  if (!advice) section.append(node('h3', '', apiMode ? '通常APIの開発操作' : 'Codex操作'));
  section.append(caption);
  let attachmentInput;
  let attachmentInfo;
  let removeAttachment;
  let attachmentSequence = 0;
  let attachmentMessage = '';
  let readingAttachment = false;
  let captureGeneration = 0;
  let cameraContext = null;
  const camera = imageModel ? createCodexCamera({maxBytes: codexImageLimit, onCapture: file => stageAttachment(file, true),
    onActiveChange: () => queueMicrotask(paint)}) : null;
  function invalidatePhoto() { captureGeneration++; }
  function updateCameraVisibility() {
    if (document.hidden) invalidatePhoto();
    paint();
  }
  if (camera) {
    document.addEventListener('visibilitychange', updateCameraVisibility);
    window.addEventListener('pagehide', invalidatePhoto);
  }
  function cameraContextKey() {
    const model = imageModel?.();
    if (!isCurrent() || document.hidden || !model || run.busy || ui.runIntents.has(runKey)) return null;
    const selected = choices();
    const existing = target ? run.operation : null;
    const route = selected.route ?? existing?.explicitRoute;
    const stage = selected.stage ?? existing?.stage ?? 'implementation';
    return codexCameraRouteAllowed(cameraSettings?.(), stage, route) ? JSON.stringify([model, stage, route]) : null;
  }
  function syncCamera() {
    if (!camera) return;
    const context = cameraContextKey();
    if (context !== cameraContext) {
      cameraContext = context;
      invalidatePhoto();
      camera.close();
    }
    camera.setAvailable(Boolean(context) && !readingAttachment);
  }
  async function stageAttachment(file, captured = false) {
    const context = captured ? cameraContextKey() : null;
    const generation = captureGeneration;
    if (!file || !isCurrent() || (captured && !context)) return;
    const sequence = ++attachmentSequence;
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const kind = codexImageTypes.includes(file.type) ? 'image' : textDocumentExtensions.includes(extension) ? 'document' : null;
    readingAttachment = false;
    if (kind === 'image' && !imageModel() && !currentIntent()?.imageSha256) {
      attachmentMessage = '画像入力に対応するモデルを選んでください。';
    } else if (!file.size || !kind || file.size > (kind === 'image' ? codexImageLimit : textDocumentLimit)) {
      attachmentMessage = '画像は512 KiB、UTF-8のテキスト資料は16 KiBまでです。';
    } else {
      readingAttachment = true;
      attachmentMessage = '添付を照合しています。';
    }
    paint();
    if (!readingAttachment) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (kind === 'document') documentDecoder.decode(bytes);
      const digest = await attachmentDigest(bytes, kind === 'document' ? file.name : '');
      if (sequence !== attachmentSequence || !isCurrent()) return;
      if (captured && (generation !== captureGeneration || context !== cameraContextKey())) {
        attachmentMessage = '';
        return;
      }
      ui.attachmentDrafts.set(draftKey, {kind, file, digest});
      attachmentMessage = '';
    } catch {
      if (sequence === attachmentSequence) attachmentMessage = '添付を読み取れませんでした。';
    } finally {
      if (sequence === attachmentSequence) { readingAttachment = false; paint(); }
    }
  }
  if (imageModel) {
    const attachmentControls = node('div', 'stack');
    const attachmentLabel = node('label', 'picker');
    attachmentInput = node('input');
    attachmentInput.type = 'file';
    attachmentLabel.append(node('span', '', 'Codexへの添付'), attachmentInput);
    attachmentInfo = node('p', 'small muted');
    attachmentInfo.setAttribute('role', 'status');
    removeAttachment = button('添付を外す', () => {
      attachmentSequence++;
      readingAttachment = false;
      ui.attachmentDrafts.delete(draftKey);
      attachmentMessage = '';
      paint();
    });
    attachmentInput.addEventListener('click', () => camera?.close());
    attachmentInput.addEventListener('change', () => {
      const file = attachmentInput.files?.[0];
      attachmentInput.value = '';
      camera?.close();
      void stageAttachment(file);
    });
    attachmentControls.append(attachmentLabel);
    if (camera) attachmentControls.append(camera.root);
    attachmentControls.append(attachmentInfo, removeAttachment);
    section.append(attachmentControls);
  }
  section.append(status, details, warning, steeringStatus, actions, output, artifacts);
  area.body.append(section);

  let timer;
  let disposed = false;
  const isCurrent = () => !disposed && section.isConnected && (!handoff || handoff.isCurrent()) && (!target || target.isCurrent());
  const reviewMatches = intent => !intent?.handover || intent.handover.review === handoff?.review();
  function steeringIntent() {
    const pending = apiMode ? null : ui.steerIntents.get(project);
    if (pending && pending.expectedThreadId !== target?.id) return null;
    if (target) return pending?.operationId === run.operation?.id ? pending : null;
    return !handoff || pending?.operationId === run.operation?.id ? pending : null;
  }
  function canInterrupt() {
    if (apiMode) return run.known && matchesStage(run.operation) && ['reserved', 'running', 'interrupting'].includes(run.operation?.phase);
    return !pendingElsewhere() && run.known && ['running', 'interrupting', 'unconfirmed'].includes(run.operation?.phase) &&
      Boolean(run.operation.threadId && run.operation.turnId);
  }
  function canCancel() {
    const phase = run.operation?.phase;
    return !apiMode && !pendingElsewhere() && run.known && phase !== 'cancelling' && (pollingPhases.has(phase) || phase === 'interrupted');
  }
  function hasRoom() {
    return run.known && !readingAttachment && (!apiMode || apiReady()?.available === true) && !ui.runIntents.has(runKey) &&
      (!run.operation || finishedPhases.has(run.operation.phase));
  }
  function paint() {
    if (!isCurrent()) return;
    clearTimeout(timer);
    const phase = run.operation?.phase;
    const intention = currentIntent();
    if (attachmentInput) {
      const attachment = ui.attachmentDrafts.get(draftKey);
      const imageAvailable = Boolean(imageModel() || intention?.imageSha256);
      attachmentInput.accept = [...textDocumentExtensions, ...(imageAvailable ? codexImageTypes : [])].join(',');
      const defaultMessage = imageAvailable ? '画像は512 KiB、UTF-8のテキスト資料は16 KiBまでです。' : 'UTF-8のテキスト資料を16 KiBまで添付できます。';
      const retryMessage = intention?.imageSha256 ? '再送する場合は、同じ画像を選んでください。' :
        intention?.documentSha256 ? '再送する場合は、同じファイルを選んでください。' : defaultMessage;
      attachmentInfo.textContent = attachmentMessage || (attachment ?
        [attachment.chatHandoffLabel, attachment.file.name,
          Math.ceil(attachment.file.size / 1024) + ' KiB'].filter(Boolean).join(' · ') : retryMessage);
      removeAttachment.hidden = !attachment;
      syncCamera();
    }
    const foreignIntent = pendingElsewhere();
    const relevantOperation = !foreignIntent && matchesStage(run.operation) && (!intention || intention.id === run.operation?.id)
      ? run.operation : null;
    const otherWork = foreignIntent || apiMode && ((!intention && ui.runIntents.has(runKey)) ||
      (run.operation && !relevantOperation && !finishedPhases.has(phase)));
    const continuation = Boolean(run.operation?.threadId && run.operation?.turnId);
    if (handoff) area.root.hidden = !(handoff.review() || intention || run.operation || run.message);
    status.textContent = run.busy && intention ? '受付を確認中…' :
      foreignIntent ? 'この案件の別のスレッドに照合待ちの受付があります。' : otherWork ? 'この案件の別の工程を確認中です。' :
      run.known ? apiMode && relevantOperation?.phase === 'completed' ? (advice ? '回答を保存しました' : '成果物の検証完了') :
        runPhases[relevantOperation?.phase] ?? '実行記録なし' : run.checking ? '照合中…' : '実行状態未確認';
    const timestamps = relevantOperation ? [
      '受付 ' + time(run.operation.createdAt),
      run.operation.startedAt ? '開始 ' + time(run.operation.startedAt) : '',
      run.operation.cancellationRequestedAt ? '中止受付 ' + time(run.operation.cancellationRequestedAt) : '',
      run.operation.updatedAt ? '更新 ' + time(run.operation.updatedAt) : '',
      apiMode ? apiReceiptSummary(asArray(relevantOperation.providerReceipts)) : '',
    ].filter(Boolean) : [];
    details.textContent = timestamps.join(' · ');
    details.hidden = !timestamps.length;
    const responseProblem = advice && relevantOperation?.result === 'API_OUTPUT_UNUSABLE' ?
      '通常APIから保存できる回答を確認できませんでした。' : apiWorkMessages[relevantOperation?.result];
    const apiNotice = apiMode && (responseProblem ||
      (apiReady() && !apiReady().available && (apiWorkMessages[apiReady().reason] || '通常APIの実行条件を確認できません。')));
    warning.textContent = run.message || apiNotice || '';
    warning.hidden = !warning.textContent;
    const pendingSteering = steeringIntent();
    steeringStatus.textContent = run.steerMessage || (pendingSteering ? '追加指示の受付を照合できます。' : '');
    steeringStatus.hidden = apiMode || !steeringStatus.textContent;
    send.hidden = Boolean(target) || !hasRoom() || Boolean(handoff && (!handoff.review() || continuation)) || Boolean(native && !native.origin());
    resume.hidden = apiMode || !hasRoom() || !continuation || phase === 'cancelled';
    resume.textContent = phase === 'interrupted' ? '中断した作業を再開' : '同じスレッドへ追加指示';
    interrupt.hidden = !canInterrupt();
    interrupt.textContent = !apiMode && phase === 'interrupting' ? '同じターンの中断を再要求' : '中断を要求';
    cancel.hidden = !canCancel();
    steer.hidden = apiMode || foreignIntent || !run.known || phase !== 'running' || !run.operation?.turnId || ui.steerIntents.has(project);
    checkSteer.hidden = !pendingSteering;
    closeSteer.hidden = !pendingSteering || !run.known || !finishedPhases.has(phase);
    recover.hidden = !intention || !reviewMatches(intention) || (run.known && run.operation?.id === intention.id);
    for (const action of [send, resume, steer, recover]) action.disabled = run.busy || run.checking || camera?.active === true;
    for (const action of [interrupt, cancel, check, checkSteer, closeSteer]) action.disabled = run.busy || run.checking;
    const body = text(advice ? relevantOperation?.advice :
      apiMode ? relevantOperation?.verification?.output : relevantOperation?.output, '');
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
    const intent = currentIntent();
    const scopedThread = operation?.threadId ?? operation?.expectedThreadId;
    const wrongTarget = target && operation && scopedThread !== target.id;
    if (operation && (operation.project !== project || !operation.id ||
      !Object.hasOwn(runPhases, operation.phase) || (expected && operation.id !== expected) ||
      (handoff && operation.handoverReceipt !== handoff.receipt) || wrongTarget)) {
      throw new Error('対象の作業状態を照合できませんでした。');
    }
    if (operation) {
      const acceptedTurn = apiMode || Boolean(operation.turnId);
      if (intent?.id === operation.id && (acceptedTurn || finishedPhases.has(operation.phase))) {
        ui.runIntents.delete(runKey);
        if (acceptedTurn) {
          const key = intentDraftKey(intent);
          const attachmentSha = intent.imageSha256 ?? intent.documentSha256;
          if (attachmentSha && ui.attachmentDrafts.get(key)?.digest === attachmentSha) ui.attachmentDrafts.delete(key);
          if (text(ui.drafts.get(key), '').trim() === intent.prompt) {
            ui.drafts.delete(key);
            if (key === draftKey) run.clearDraft = intent.prompt;
          }
        }
        storeTab();
        paintRelatedRuns();
      }
    }
    const newlyCompleted = advice && matchesStage(operation) && operation?.phase === 'completed' &&
      (operation.id !== run.operation?.id || run.operation?.phase !== 'completed');
    run.operation = operation ?? (target && !expected ? null : run.operation);
    run.known = Boolean(operation) || (!expected && !ui.runIntents.has(runKey));
    run.message = run.known ? '' : '受付を確認できません。再送する場合は同じ受付番号が使われます。';
    if (newlyCompleted && isCurrent()) advice.onComplete();
  }

  async function lookup(operationId) {
    if (run.busy || run.checking || !isCurrent()) return;
    run.checking = true;
    run.onChange?.();
    const id = operationId ?? currentIntent()?.id ??
      (run.operation && !finishedPhases.has(run.operation.phase) ? run.operation.id : undefined);
    try {
      const response = await api(apiPath(path, {project, id, thread: id ? undefined : target?.id, handoverReceipt: handoff?.receipt}),
        {signal: AbortSignal.timeout(9000)});
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
    if (run.busy || run.checking || !isCurrent()) return;
    run.busy = true;
    run.message = '';
    run.onChange?.();
    let verifyCancellation = false;
    try {
      const {draftReceipt, imageSha256, documentSha256, ...request} = payload;
      const digest = imageSha256 ?? documentSha256;
      if (digest) {
        const attachment = ui.attachmentDrafts.get(intentDraftKey(payload));
        if (attachment?.digest !== digest) throw new Error(imageSha256 ?
          '再送する画像を選んでください。' : '再送するファイルを選んでください。');
        const {file} = attachment;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (await attachmentDigest(bytes, documentSha256 ? file.name : '') !== digest) throw new Error('送信する添付の内容が変わりました。');
        if (!isCurrent()) return;
        if (imageSha256) request.image = {mime: file.type, data: bytesBase64(bytes)};
        else request.document = {name: file.name, text: documentDecoder.decode(bytes)};
      }
      const result = await api(apiPath(endpoint, {project}), {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request),
        signal: AbortSignal.timeout(payload.nativeOrigin ? 30000 : payload.handover ? 16000 : 12000),
      });
      if (!result?.operation) throw new Error('作業の受付結果を照合できませんでした。');
      accept(result, payload.id);
    } catch (error) {
      const imageModelRejected = Boolean(payload.imageSha256) && error.code === 'CODEX_IMAGE_MODEL_UNAVAILABLE';
      const targetRejected = error.status === 409 && error.code === 'CODEX_RESUME_TARGET_UNAVAILABLE';
      const confirmedRejection = [400, 403, 413].includes(error.status) || imageModelRejected || targetRejected ||
        (apiMode || payload.handover) && error.status === 409;
      if (endpoint === path && confirmedRejection && ui.runIntents.get(runKey)?.id === payload.id) {
        ui.runIntents.delete(runKey);
        if (payload.handover) handoff?.invalidate();
        if (payload.nativeOrigin) native?.invalidate();
        storeTab();
        paintRelatedRuns();
      }
      run.known = Boolean((apiMode || payload.handover || imageModelRejected) && confirmedRejection);
      run.message = error.message + ' 作業状態を確認してください。';
      verifyCancellation = endpoint === '/api/codex/cancel' && (!error.status || error.status >= 500);
    } finally {
      run.busy = false;
      run.onChange?.();
      if (verifyCancellation) void lookup(payload.id);
    }
  }

  async function requestSteering(submit) {
    const intent = steeringIntent();
    if (!intent || run.busy || run.checking || !isCurrent()) return;
    run.busy = true;
    run.steerMessage = '追加指示の受付を照合中…';
    paint();
    try {
      const path = apiPath('/api/codex/steer', {project, id: submit ? undefined : intent.id});
      const {draftReceipt, expectedThreadId, ...request} = intent;
      const options = submit ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)} : {};
      const {steering} = await api(path, {...options, signal: AbortSignal.timeout(14000)});
      if (ui.steerIntents.get(project)?.id !== intent.id) return;
      const matchesIntent = steering?.id === intent.id && steering.project === project && steering.operationId === intent.operationId;
      if (matchesIntent && steering.phase === 'accepted') {
        ui.steerIntents.delete(project);
        const key = intentDraftKey(intent);
        if (text(ui.drafts.get(key), '').trim() === intent.prompt) {
          ui.drafts.delete(key);
          if (key === draftKey) run.clearDraft = intent.prompt;
        }
        storeTab();
        run.steerMessage = '実行中の同じターンで追加指示が受理されました。';
      } else if (matchesIntent && steering.phase === 'rejected') {
        ui.steerIntents.delete(project);
        storeTab();
        run.steerMessage = '元のターンの状態が変わったため、追加指示を送信しませんでした。';
      } else run.steerMessage = '追加指示の受理をまだ確認できません。作業状態を照合できます。';
    } catch (error) {
      if (submit && [400, 403, 409, 413].includes(error.status) && ui.steerIntents.get(project)?.id === intent.id) {
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
    if (steer.hidden || run.busy || run.checking || !isCurrent() || ui.steerIntents.has(project)) return;
    if (camera?.active || readingAttachment) {
      run.steerMessage = '撮影・添付を終えてから送信してください。';
      paint();
      return;
    }
    if (ui.attachmentDrafts.has(draftKey)) {
      run.steerMessage = '添付は、このスレッドの次のターンに送れます。';
      paint();
      return;
    }
    const prompt = draft.value.trim();
    if (!prompt) {
      run.steerMessage = '追加する指示を下書きに入力してください。';
      paint();
      draft.focus();
      return;
    }
    const request = {id: crypto.randomUUID(), operationId: run.operation.id, prompt};
    abortLocalDictation(draft);
    if (handoff) request.draftReceipt = handoff.receipt;
    if (target) request.expectedThreadId = target.id;
    ui.steerIntents.set(project, request);
    storeTab();
    void requestSteering(true);
  }

  function submitNew(previous) {
    if (run.busy || run.checking || !hasRoom() || !isCurrent() || previous?.phase === 'cancelled') return;
    if (camera?.active) {
      run.message = '撮影を完了するか、カメラを閉じてから送信してください。';
      paint();
      return;
    }
    if (target && previous?.threadId !== target.id) return;
    const review = handoff?.review();
    if (handoff && !previous && (!review || (run.operation?.threadId && run.operation?.turnId))) return;
    const nativeOrigin = native?.origin();
    if (native && !nativeOrigin) return;
    const attachment = ui.attachmentDrafts.get(draftKey);
    const isImage = attachment?.kind === 'image';
    const selectedImageModel = isImage && imageModel?.();
    if (attachment && (apiMode || (isImage && !selectedImageModel))) {
      run.message = apiMode ? '添付はCodex操作から送信してください。' : '画像入力に対応するモデルを選んでください。';
      paint();
      return;
    }
    const prompt = draft.value.trim() ||
      (previous?.phase === 'interrupted' ? 'このスレッドで中断した作業を再開してください。' : '');
    if (!prompt) {
      run.message = '送信する指示を下書きに入力してください。';
      paint();
      draft.focus();
      return;
    }
    const intent = {id: crypto.randomUUID(), prompt, ...choices()};
    abortLocalDictation(draft);
    if (isImage) {
      intent.imageSha256 = attachment.digest;
      intent.model = selectedImageModel;
    } else if (attachment) {
      intent.documentSha256 = attachment.digest;
    }
    if (previous) {
      intent.resume = previous.id;
      if (handoff) intent.draftReceipt = handoff.receipt;
      if (target) intent.expectedThreadId = target.id;
    } else if (handoff) intent.handover = {receipt: handoff.receipt, review};
    if (nativeOrigin) intent.nativeOrigin = nativeOrigin;
    ui.runIntents.set(runKey, intent);
    storeTab();
    paintRelatedRuns();
    void mutate(path, intent);
  }

  run.onChange = paint;
  const cleanup = () => {
    abortLocalDictation(draft);
    disposed = true;
    camera?.dispose();
    if (camera) {
      document.removeEventListener('visibilitychange', updateCameraVisibility);
      window.removeEventListener('pagehide', invalidatePhoto);
    }
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
  return {paint, cleanup};
}

function mountApiControls(area, project, draft, draftKey, advice) {
  const options = node('fieldset', 'model-pickers');
  const developmentStages = Object.fromEntries(Object.entries(workStageLabels).filter(([key]) => !Object.hasOwn(apiAdviceStages, key)));
  const stage = labeledSelect('通常APIの工程', advice ? apiAdviceStages : developmentStages);
  const model = labeledSelect('通常APIのモデル', {'': '案件設定を使う'});
  const effort = labeledSelect('通常APIの推論レベル', {'': '案件設定を使う'});
  options.append(stage.field, model.field, effort.field);
  area.body.append(options);
  let capability;
  const run = mountCodexRun(area, project, draft, draftKey, () => ({stage: stage.input.value,
    ...(model.input.value ? {model: model.input.value} : {}), ...(effort.input.value ? {effort: effort.input.value} : {})}),
  () => capability, {advice});
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
    run.paint();
  }).catch(() => {
    capability = {available: false, reason: 'API_AUTHORIZATION_REQUIRED'};
    run.paint();
  });
  return run;
}

function apiAdviceComposer(project, onComplete, threadId) {
  const area = panel(threadId ? 'Codexの結果を通常APIに引継ぐ' : '通常APIに相談');
  const draftKey = threadId ? memoryKey('api-advice-draft', project, threadId) : memoryKey('api-advice-draft', project);
  const draft = node('textarea', 'draft');
  draft.maxLength = 12000;
  draft.value = ui.drafts.get(draftKey) ?? '';
  draft.addEventListener('input', () => {
    ui.drafts.set(draftKey, draft.value);
    storeTab();
  });
  const label = node('label', 'picker');
  label.append(node('span', '', '相談・設計の依頼'), draft);
  let origin;
  let native;
  let run;
  if (threadId) {
    const status = node('p', 'small muted');
    status.setAttribute('role', 'status');
    const isCurrent = () => area.root.isConnected && ui.project === project && ui.chatIds.get(project) === 'codex/' + threadId;
    const verify = button('通常APIへの引継ぎを照合', async () => {
      if (!isCurrent()) return;
      origin = null;
      run.paint();
      verify.disabled = true;
      status.textContent = '完了ターン、要求、成果物を照合しています。';
      try {
        const proof = await api(apiPath('/api/execution/handover', {project, thread: threadId}), {signal: AbortSignal.timeout(25000)});
        if (!isCurrent()) return;
        if (proof.verified !== true || proof.destination !== 'api' || !/^[a-z0-9_-]{8,80}$/i.test(proof.receipt ?? '') ||
            !/^[a-f0-9]{64}$/.test(proof.review ?? '') || !Array.isArray(proof.artifacts) || !proof.transcript?.messages) {
          throw new Error('引継ぎの照合結果を確認できませんでした。');
        }
        origin = {threadId, operationId: proof.receipt, review: proof.review};
        status.textContent = `照合済み ${proof.requirements.path} · 発言 ${proof.transcript.messages}件 · 成果物 ${proof.artifacts.length}件`;
        run.paint();
      } catch (error) { if (isCurrent()) status.textContent = error.message; }
      finally { if (isCurrent()) verify.disabled = false; }
    });
    native = {threadId, origin: () => origin, invalidate() {
      origin = null;
      if (isCurrent()) status.textContent = '次の依頼を送る前に、引継ぎを照合してください。';
    }};
    area.body.append(verify, status);
  }
  area.body.append(label);
  addDictation(area.body, draft);
  run = mountApiControls(area, project, draft, draftKey, {native, onComplete() {
    if (origin) native.invalidate();
    onComplete();
  }});
  return {root: area.root, cleanup: run.cleanup};
}

function modelSettings(target, back) {
  const project = ui.project;
  const canWrite = ui.capabilities.codexWrite === true && selectedProject()?.codexWrite === true;
  const area = panel('モデルと推論');
  if (target) {
    area.body.append(node('p', 'strong', '対象スレッド ' + target.title),
      node('p', 'small muted', target.id), button('案件全体の操作を表示', back));
  }
  const draftLabel = node('label', 'picker');
  draftLabel.append(node('span', '', '開発指示の下書き'));
  const draft = node('textarea', 'draft');
  draft.placeholder = '次の作業や確認したいことを書く';
  draft.maxLength = canWrite ? 16000 : 32000;
  const draftKey = target ? memoryKey('codex-thread-draft', project, target.id) : memoryKey('codex-draft', project);
  draft.value = ui.drafts.get(draftKey) ?? '';
  draft.addEventListener('input', () => {
    ui.drafts.set(draftKey, draft.value);
    storeTab();
  });
  draftLabel.append(draft);
  const form = node('fieldset', 'model-pickers');
  area.body.append(form, node('h3', '', '下書き'), draftLabel);
  addDictation(area.body, draft);
  let nativeRun;
  let apiRun;
  let imageModel = null;
  const projectSettings = canWrite ? viewResource(memoryKey('execution-settings', project), apiPath('/api/execution/settings', {project})) : null;
  let runChoices = {};
  if (canWrite) {
    const details = node('details', 'scope-info');
    const fields = node('div', 'stack');
    const route = labeledSelect('作業別の利用経路', {'': '案件設定を使う', subscription: 'サブスク',
      ...(!target && ui.capabilities.apiDevelopment !== true ? {api: 'API'} : {})});
    const stage = labeledSelect('作業の工程', {'': '標準設定を使う', ...workStageLabels});
    fields.append(route.field, stage.field);
    details.append(node('summary', '', 'この作業の経路を指定'), fields);
    if (ui.capabilities.executionSettings === true) area.body.append(details);
    nativeRun = mountCodexRun(area, project, draft, draftKey, () => ({...runChoices,
      ...(route.input.value ? {route: route.input.value} : {}), ...(stage.input.value ? {stage: stage.input.value} : {})}),
    null, {imageModel: () => imageModel, cameraSettings: () => projectSettings?.value?.settings, target});
    route.input.addEventListener('change', nativeRun.paint);
    stage.input.addEventListener('change', nativeRun.paint);
  }
  else if (target || ui.capabilities.apiDevelopment !== true) {
    area.body.append(node('p', 'small muted draft-hint', '現在の接続では履歴を閲覧できます。下書きはこのタブに保存されます。'));
  }
  if (!target && ui.capabilities.apiDevelopment === true) apiRun = mountApiControls(area, project, draft, draftKey);
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
    model.setAttribute('aria-label', 'モデル');
    effort.setAttribute('aria-label', '推論レベル');
    const modelLabel = node('label', 'picker');
    const effortLabel = node('label', 'picker');
    modelLabel.append(node('span', '', 'モデル'), model);
    effortLabel.append(node('span', '', '推論レベル'), effort);
    for (const item of models) {
      const option = node('option', '', text(item.displayName, item.id));
      option.value = item.id;
      model.append(option);
    }
    const configuredModel = () => projectSettings?.value?.settings?.model;
    function applyModelDefault() {
      const preference = ui.options.get(project);
      const selection = preference?.sendModel ? preference.model : configuredModel();
      model.value = models.find(item => item.id === selection)?.id ?? models.find(item => item.isDefault)?.id ?? models[0].id;
    }
    applyModelDefault();
    function save({sendModel, sendEffort}) {
      ui.options.set(project, {model: model.value, effort: effort.value, sendModel, sendEffort});
      runChoices = {};
      if (sendModel && model.value) runChoices.model = model.value;
      if (sendEffort && effort.value) runChoices.effort = effort.value;
      storePreferences();
    }
    function populateEffort(modelChanged = false) {
      const entry = models.find(item => item.id === model.value);
      const previous = ui.options.get(project);
      const explicit = modelChanged || (previous?.sendModel === true && previous.model === entry?.id);
      const current = configuredModel();
      imageModel = asArray(entry?.inputModalities).includes('image') && (explicit ||
        (projectSettings?.value && (!current ? entry.isDefault === true : current === entry.id))) ? entry.id : null;
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
      effort.disabled = !values.length;
      effort.value = previous?.model === model.value && values.includes(previous.effort) ? previous.effort :
        values.includes(entry?.defaultReasoningEffort) ? entry.defaultReasoningEffort : values[0] ?? '';
      const sameModel = previous?.model === model.value;
      save({sendModel: modelChanged || (sameModel && previous?.sendModel === true),
        sendEffort: sameModel && previous?.effort === effort.value && previous?.sendEffort === true});
      nativeRun?.paint();
    }
    model.addEventListener('change', () => populateEffort(true));
    effort.addEventListener('change', () => {
      const entry = models.find(item => item.id === model.value);
      save({sendModel: ui.options.get(project)?.sendModel === true || entry?.isDefault !== true, sendEffort: true});
    });
    populateEffort();
    destination.append(modelLabel, effortLabel);
    if (projectSettings?.pending) void projectSettings.pending.then(() => {
      if (!form.isConnected || !model.isConnected) return;
      if (!ui.options.get(project)?.sendModel) applyModelDefault();
      populateEffort();
    });
  });
  return {root: area.root, cleanup() {
    abortLocalDictation(draft);
    nativeRun?.cleanup();
    apiRun?.cleanup();
  }};
}
const evidenceStatus = {inProgress: '実行中', completed: '完了', interrupted: '中断', failed: '失敗', declined: '却下'};
const evidenceKind = {add: '追加', update: '変更', delete: '削除'};
const turnHistoryCursors = new WeakMap();
const codexHistoryPages = new WeakMap();

function codexResultChatHandoff(project, threadId, selector, isCurrent) {
  const root = node('div', 'stack');
  const actions = node('div', 'run-actions');
  const status = node('p', 'small muted');
  status.setAttribute('role', 'status');
  const preview = node('pre', 'run-output');
  preview.tabIndex = 0;
  preview.setAttribute('data-chat-context', '');
  preview.setAttribute('aria-label', 'チャットに渡す実行結果');
  const prepareButton = button('チャットへ渡す内容を確認', () => void prepare());
  const attach = button('結果をチャットの下書きに添付', stage);
  const draftKey = memoryKey('chat-draft', project);
  let prepared, generation = 0;
  const selectedTurn = () => selector.selectedOptions[0];
  const eligible = () => selectedTurn()?.dataset.status === 'completed';
  actions.append(prepareButton, attach);
  root.append(actions, status, preview);

  function reset() {
    generation++;
    prepared = undefined;
    root.hidden = !eligible();
    preview.hidden = true;
    preview.textContent = status.textContent = '';
    attach.disabled = true;
    prepareButton.disabled = false;
  }

  async function prepare() {
    if (!isCurrent() || !eligible() || prepareButton.disabled) return;
    reset();
    prepareButton.disabled = true;
    const visit = generation;
    const turn = selector.value;
    const historyCursor = selectedTurn()?.dataset.historyCursor;
    const selected = ui.chatIds.get(project);
    const candidate = selected && !/^(?:api|codex)\//.test(selected) ? selected : undefined;
    const current = () => visit === generation && isCurrent() && eligible() && selector.value === turn;
    status.textContent = 'このターンの結果と共有先を照合しています…';
    try {
      const result = await api(apiPath('/api/codex/chat-context', {project, id: threadId, turn, conversation: candidate, historyCursor}),
        {signal: AbortSignal.timeout(12000)});
      if (!current()) return;
      const {document, conversation, sha256, summary} = result ?? {};
      const counts = [summary?.commands, summary?.files, summary?.artifacts];
      if (result?.threadId !== threadId || result.turnId !== turn || document?.name !== 'codex-result.json' ||
          typeof document.text !== 'string' || counts.some(count => !Number.isSafeInteger(count) || count < 0) ||
          (conversation !== null && (typeof conversation?.id !== 'string' || !conversation.id ||
            typeof conversation.linked !== 'boolean' || (!conversation.linked && conversation.id !== candidate)))) {
        throw new Error('選択したターンまたは共有先を確認できませんでした。');
      }
      const bytes = new TextEncoder().encode(document.text);
      if (bytes.length > textDocumentLimit || await attachmentDigest(bytes) !== sha256) {
        throw new Error('添付資料が照合結果と一致しません。');
      }
      const packet = JSON.parse(document.text);
      if (packet.project?.id !== project || packet.threadId !== threadId || packet.turnId !== turn || packet.status !== 'completed' ||
          ['commands', 'files', 'artifacts'].some((key, index) => asArray(packet[key]).length !== counts[index])) {
        throw new Error('収録した結果を確認できませんでした。');
      }
      const digest = await attachmentDigest(bytes, document.name);
      if (!current()) return;
      const target = conversation ? text(conversation.title, '保存済みの会話') : 'この案件の新しい相談';
      status.textContent = [`共有先 ${target}`, `実行記録${counts[0]}件・変更ファイル${counts[1]}件・成果物${counts[2]}件`].join(' · ');
      preview.textContent = document.text;
      preview.hidden = false;
      prepared = {turn, document, digest, sourceConversationId: conversation?.id ?? null};
      attach.disabled = false;
    } catch (error) {
      if (current()) status.textContent = error.message;
    } finally {
      if (visit === generation) prepareButton.disabled = false;
    }
  }

  function stage() {
    if (!prepared || !isCurrent() || !eligible() || prepared.turn !== selector.value || ui.capabilities.chatgptPlan !== true) return;
    if (ui.chatIntents.has(project) || chatStreams.has(project) || ui.attachmentDrafts.has(draftKey)) {
      status.textContent = 'チャットの保留中の応答と現在の添付を確認してから追加してください。';
      return;
    }
    const {document, digest, sourceConversationId} = prepared;
    ui.attachmentDrafts.set(draftKey, {document, digest, sourceConversationId});
    if (sourceConversationId) ui.chatIds.set(project, sourceConversationId);
    storeTab();
    location.hash = 'chat';
  }

  reset();
  return {root, reset};
}

function codexTurnEvidence(project, threadId, isCurrent) {
  const section = node('details', 'scope-info');
  const selector = labeledSelect('確認するターン', {});
  const status = node('p', 'small muted');
  status.setAttribute('role', 'status');
  const records = node('ol', 'marked-list');
  const refresh = button('実行記録を更新', () => { reset(); void load(); });
  const more = button('続きの実行記録を表示', () => load(cursor));
  const actions = node('div', 'run-actions');
  actions.append(refresh, more);
  more.hidden = true;
  section.append(node('summary', '', 'コマンド結果・変更ファイル'), selector.field, status, records, actions);
  const chatHandoff = ui.capabilities.chatgptPlan === true
    ? codexResultChatHandoff(project, threadId, selector.input, () => section.open && section.isConnected && isCurrent()) : null;
  if (chatHandoff) section.append(chatHandoff.root);
  section.hidden = true;
  const displayed = new Set();
  const previousCursors = new Set();
  const mounted = () => section.isConnected && isCurrent();
  const endpoint = '/api/codex/evidence';
  let generation = 0, request, cursor, attempted = false;

  function reset() {
    generation++;
    request?.abort();
    request = null;
    attempted = false;
    cursor = undefined;
    displayed.clear();
    previousCursors.clear();
    records.replaceChildren();
    more.hidden = true;
    chatHandoff?.reset();
  }
  function renderCommandOutput(output, entry, turn, visit) {
    const messages = {empty: '出力なし', unavailable: '出力未取得', hidden: '出力は非表示です。'};
    if (entry.outputState === 'visible' && typeof entry.output === 'string') {
      const pre = node('pre', 'run-output', entry.output);
      pre.setAttribute('aria-label', 'コマンドの出力');
      pre.tabIndex = 0;
      output.replaceChildren(pre);
      if (entry.truncated) output.append(node('p', 'small muted', 'この記録の一部を表示しています。'));
    } else if (entry.outputState === 'deferred') {
      const message = node('p', 'small muted');
      message.setAttribute('role', 'status');
      const read = button('保存済みの出力を取得', async () => {
        if (read.disabled || !mounted() || visit !== generation || !output.isConnected) return;
        const wasFocused = document.activeElement === read;
        read.disabled = true;
        message.textContent = '出力を取得中…';
        try {
          const page = await api(apiPath(endpoint, {project, id: threadId, turn, item: entry.id}),
            {signal: AbortSignal.timeout(9000)});
          if (!mounted() || visit !== generation || !output.isConnected) return;
          if (page?.threadId !== threadId || page.turnId !== turn || page.entry?.id !== entry.id || page.entry.type !== 'command') {
            throw new Error('対象の出力を照合できませんでした。');
          }
          if (page.entry.outputState === 'deferred') {
            message.textContent = '現在の接続から保存済みの出力を取得できません。';
            return;
          }
          const returnFocus = wasFocused && [read, document.body].includes(document.activeElement);
          renderCommandOutput(output, page.entry, turn, visit);
          const heading = output.firstElementChild;
          if (returnFocus && heading) {
            if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
            heading.focus({preventScroll: true});
          }
        } catch (error) {
          if (mounted() && visit === generation) message.textContent = error.message;
        } finally { read.disabled = false; }
      });
      output.replaceChildren(read, message);
    } else {
      output.replaceChildren(node('p', 'small muted', messages[entry.outputState] ?? '出力未取得'));
    }
  }
  function renderEntry(entry, turn, visit) {
    const row = node('li', 'stack');
    const details = [evidenceStatus[entry.status] ?? '状態未確認'];
    if (entry.type === 'command') {
      if (Number.isInteger(entry.exitCode)) details.push('終了コード ' + entry.exitCode);
      if (Number.isSafeInteger(entry.durationMs)) details.push(entry.durationMs.toLocaleString('ja-JP') + ' ms');
      if (entry.cwd && entry.cwd !== '.') details.push('作業先 ' + entry.cwd);
      row.append(node('p', 'strong', 'コマンド · ' + details.join(' · ')));
      if (entry.command) {
        const command = node('pre', 'run-output', entry.command);
        command.setAttribute('aria-label', '実行したコマンド');
        command.tabIndex = 0;
        row.append(command);
      }
      const output = node('div', 'stack');
      renderCommandOutput(output, entry, turn, visit);
      row.append(output);
      if (entry.truncated && entry.outputState !== 'visible') row.append(node('p', 'small muted', 'この記録の一部を表示しています。'));
    } else {
      row.append(node('p', 'strong', 'ファイル変更 · ' + details.join(' · ')));
      const paths = node('ul', 'marked-list');
      for (const change of asArray(entry.changes)) {
        if (typeof change?.path !== 'string' || !Object.hasOwn(evidenceKind, change.kind)) continue;
        paths.append(node('li', 'small', change.from ? '移動 ' + change.from + ' → ' + change.path :
          evidenceKind[change.kind] + ' ' + change.path));
      }
      if (paths.children.length) row.append(paths);
      if (entry.truncated) row.append(node('p', 'small muted', '表示できる変更の一部を掲載しています。'));
    }
    return row;
  }
  async function load(next) {
    const turn = selector.input.value;
    if (!section.open || !mounted() || !turn || request) return;
    const visit = generation;
    const current = new AbortController();
    request = current;
    attempted = true;
    refresh.disabled = more.disabled = true;
    status.textContent = '実行記録を取得中…';
    try {
      const page = await api(apiPath(endpoint, {project, id: threadId, turn, cursor: next}),
        {signal: AbortSignal.any([current.signal, AbortSignal.timeout(9000)])});
      if (!mounted() || visit !== generation) return;
      if (page?.threadId !== threadId || page.turnId !== turn || !Array.isArray(page.entries)) {
        throw new Error('対象ターンの実行記録を照合できませんでした。');
      }
      for (const entry of page.entries) {
        if (typeof entry?.id !== 'string' || displayed.has(entry.id) || !['command', 'files'].includes(entry.type)) continue;
        displayed.add(entry.id);
        records.append(renderEntry(entry, turn, visit));
      }
      if (next) previousCursors.add(next);
      cursor = typeof page.nextCursor === 'string' && page.nextCursor && !previousCursors.has(page.nextCursor) ? page.nextCursor : undefined;
      more.hidden = !cursor;
      status.textContent = displayed.size ? '' : 'このページに表示できる実行記録はありません。';
    } catch (error) {
      if (mounted() && visit === generation && !current.signal.aborted) status.textContent = error.message;
    } finally {
      if (request === current) {
        request = null;
        refresh.disabled = more.disabled = false;
      }
    }
  }
  selector.input.addEventListener('change', () => { reset(); void load(); });
  section.addEventListener('toggle', () => {
    if (section.open && !attempted) void load();
    if (!section.open) chatHandoff?.reset();
  });
  return {section, useTurns(turns) {
    const previous = selector.input.value;
    selector.input.replaceChildren(...[...asArray(turns)].reverse().filter(turn =>
      typeof turn?.id === 'string' && codexRecordId.test(turn.id)).map(turn => {
      const user = asArray(turn.messages).find(message => message?.role === 'user');
      const title = text(user?.text, '').replace(/\s+/g, ' ').slice(0, 65);
      const parts = [turn.startedAt ? time(turn.startedAt) : '', title, evidenceStatus[turn.status] ?? '状態未確認'].filter(Boolean);
      const option = node('option', '', parts.join(' · '));
      option.value = turn.id;
      option.dataset.status = turn.status;
      const historyCursor = turnHistoryCursors.get(turn);
      if (historyCursor) option.dataset.historyCursor = historyCursor;
      return option;
    }));
    if ([...selector.input.options].some(option => option.value === previous)) selector.input.value = previous;
    section.hidden = !selector.input.value;
    if (previous !== selector.input.value) {
      reset();
      if (section.open) void load();
    } else chatHandoff?.reset();
  }};
}

function codex() {
  const project = ui.project;
  if (!project) return emptyProject();
  if (selectedProject()?.registration === 'github') return projectNeedsWorkspace();
  const layout = node('div', 'split conversation-layout');
  const collection = panel('スレッド');
  const thread = panel('スレッド詳細');
  const reading = thread.body;
  const items = node('div');
  const sidebar = node('div', 'stack');
  const current = node('div', 'stack');
  const composer = node('div');
  const indexKey = memoryKey('codex-index', project);
  const paging = new Set();
  let historyRequest;
  let controls;
  let controlsThread;
  let displayedThread;
  collection.body.remove();
  collection.root.append(items);
  sidebar.append(collection.root);
  current.append(thread.root, composer);
  layout.append(sidebar, current);
  dom.content.append(layout);
  function showControls(target) {
    controls?.cleanup();
    controlsThread = target?.id;
    if (target === null) {
      controls = null;
      composer.replaceChildren(button('案件全体の操作を表示', () => showControls()));
      return;
    }
    controls = modelSettings(target, () => showControls());
    composer.replaceChildren(controls.root);
  }
  showControls();

  function showThread(position) {
    const id = ui.threadIds.get(project);
    if (displayedThread !== id) {
      displayedThread = id;
      const handoff = ui.attachmentDrafts.get(memoryKey('codex-draft', project))?.chatHandoffLabel;
      showControls(id && !handoff ? null : undefined);
    }
    if (!id) {
      thread.header.replaceChildren(node('h2', '', 'スレッド詳細'));
      reading.replaceChildren(node('p', 'muted', '一覧からスレッドを選んでください。'));
      return;
    }
    const path = apiPath('/api/codex/thread', {project, id});
    const key = memoryKey('codex-thread', project, id);
    const isCurrent = () => layout.isConnected && ui.view === 'codex' && ui.project === project && ui.threadIds.get(project) === id;
    fetchView(key, path, reading, (value, destination) => {
      if (!isCurrent()) return;
      const selected = value?.thread;
      thread.header.replaceChildren(node('h2', '', text(selected?.title, 'スレッド')), chip(selected?.status));
      destination.append(node('p', 'small muted', '更新 ' + time(selected?.updatedAt)));
      const actions = node('div', 'run-actions');
      if (selected?.id === id && value.managed === true) {
        actions.append(button('このスレッドの操作を表示', () => {
          if (isCurrent() && destination.isConnected) showControls({id, title: text(selected.title, 'スレッド'), isCurrent});
        }));
      }
      const voiceTurn = asArray(value?.turns).at(-1);
      if (selected?.id === id && ui.capabilities.realtimeVoice === true &&
          voiceTurn?.status === 'completed' && typeof voiceTurn.id === 'string' && voiceTurn.id) {
        actions.append(button(realtimeCodexLabel, () => {
          if (!isCurrent() || !destination.isConnected) return;
          realtimeCodexIntent = {project, thread: id, turn: voiceTurn.id, title: selected.title};
          location.hash = 'chat';
        }));
      }
      if (selected?.id === id && value.desktopThreadId === id && id.length === 36 &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)) {
        const open = node('a', 'button secondary', 'Codexアプリで元のスレッドを開く');
        open.href = 'codex://threads/' + id;
        actions.append(open);
      }
      if (actions.children.length) destination.append(actions);
      const evidence = codexTurnEvidence(project, id, isCurrent);
      destination.append(evidence.section);
      evidence.useTurns(value?.turns);
      const messages = node('div', 'messages messages-embedded');
      destination.append(messages);
      function appendTurns(turns, prepend = false) {
        const rows = asArray(turns);
        const chunks = document.createDocumentFragment();
        for (const turn of rows) {
          const group = document.createDocumentFragment();
          messagesInto(group, turn.messages);
          [...group.children].forEach((message, index) => {
            message.dataset.historyKey = JSON.stringify([turn.id, index]);
          });
          chunks.append(group);
        }
        if (prepend) messages.prepend(chunks);
        else messages.append(chunks);
        return rows.reduce((amount, turn) => amount + (Number.isInteger(turn.itemCount) ? turn.itemCount : 0), 0);
      }
      const itemCount = appendTurns(value?.turns);
      if (!messages.children.length) {
        messages.append(node('p', 'muted', itemCount ? 'このページに表示できる会話本文はありません。' : '表示できる発言がありません。'));
      }
      let cursor = value?.nextCursor;
      const more = button('以前のターンを表示', async () => {
        if (paging.has(key)) return;
        const connection = connectionGeneration;
        const canApply = () => messages.isConnected && isCurrent() && connection === connectionGeneration &&
          resources.get(key)?.value === value;
        more.disabled = true;
        paging.add(key);
        try {
          const page = await api(apiPath('/api/codex/thread', {project, id, cursor}));
          if (!canApply()) return;
          const initialTop = messages.getBoundingClientRect().height;
          const added = asArray(page?.turns);
          for (const turn of added) if (turn && typeof turn === 'object') turnHistoryCursors.set(turn, cursor);
          appendTurns(added, true);
          value.turns = [...added, ...asArray(value.turns)];
          codexHistoryPages.set(value, (codexHistoryPages.get(value) ?? 1) + 1);
          evidence.useTurns(value.turns);
          value.nextCursor = page?.nextCursor;
          cursor = page?.nextCursor;
          more.hidden = typeof cursor !== 'string' || !cursor;
          if (!more.hidden) messages.prepend(more);
          const growth = messages.getBoundingClientRect().height - initialTop;
          if (growth > 0) scrollBy(0, growth);
        } catch (error) { if (canApply()) setNotice(error.message, true); }
        finally { paging.delete(key); more.disabled = false; }
      });
      more.hidden = typeof cursor !== 'string' || !cursor;
      messages.prepend(more);
      if (ui.capabilities.chatgptPlan === true) {
        const recent = asArray(value?.turns).flatMap(turn => asArray(turn.messages)).findLast(message => message.role === 'assistant');
        if (recent?.text) destination.append(button('Codexの回答をチャットの下書きに追加', () => {
          moveToDraft(project, 'chat', recent, 'この案件でのCodexの回答');
        }));
      }
      restoreHistoryPosition(reading, position);
    }, isCurrent);
  }
  function showThreads(result, destination, passive = false) {
    const previousSelection = ui.threadIds.get(project);
    const threads = asArray(result?.data);
    if (!threads.length) {
      const detail = selectedProject()?.codexScopes ?
        'このプロジェクトのスレッドが見つかりません。' : 'このプロジェクトの端末・作業フォルダは未接続です。';
      destination.append(node('p', 'empty', detail));
      if (!passive && !selectedProject()?.codexScopes) {
        ui.threadIds.delete(project);
        storeTab();
      }
      if (!passive || previousSelection !== ui.threadIds.get(project)) showThread();
      return;
    }
    if (!ui.threadIds.get(project)) {
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
        const row = rowButton(text(item.title, '無題のスレッド'), '更新 ' + time(item.updatedAt),
          ui.threadIds.get(project) === item.id, event => {
            ui.threadIds.set(project, item.id);
            storeTab();
            for (const row of rows.querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === event.currentTarget));
            showThread();
          }, chip(item.status));
        row.dataset.historyKey = item.id;
        rows.append(listItem(row));
      }
      return added;
    }
    addThreads(threads);
    destination.append(rows);
    let cursor = result.nextCursor;
    const next = button('さらにスレッドを表示', async () => {
      if (paging.has(indexKey)) return;
      const connection = connectionGeneration;
      const canApply = () => rows.isConnected && connection === connectionGeneration && resources.get(indexKey)?.value === result;
      next.disabled = true;
      paging.add(indexKey);
      try {
        const page = await api(apiPath('/api/codex/threads', {project, cursor}));
        if (!canApply()) return;
        const added = addThreads(asArray(page?.data));
        result.data = [...asArray(result.data), ...added];
        codexHistoryPages.set(result, (codexHistoryPages.get(result) ?? 1) + 1);
        result.nextCursor = page.nextCursor !== cursor ? page.nextCursor : null;
        cursor = result.nextCursor;
        next.hidden = typeof cursor !== 'string' || !cursor;
      } catch (error) { if (canApply()) setNotice(error.message, true); }
      finally { paging.delete(indexKey); next.disabled = false; }
    });
    next.hidden = typeof cursor !== 'string' || !cursor;
    const pagination = node('div', 'pagination');
    pagination.append(next);
    destination.append(pagination);
    if (!passive || previousSelection !== ui.threadIds.get(project)) showThread();
  }

  function historyPosition(container) {
    const active = document.activeElement;
    const rows = [...layout.querySelectorAll('[data-history-key]')];
    const anchor = layout.contains(active) && !container.contains(active) ? active : rows.find(row => {
      const {top, bottom} = row.getBoundingClientRect();
      return top < innerHeight && bottom > 0;
    });
    return {anchor, top: anchor?.getBoundingClientRect().top, focus: container.contains(active) ? active?.dataset.historyKey : undefined};
  }

  function restoreHistoryPosition(container, position) {
    if (!position) return;
    const rows = [...container.querySelectorAll('[data-history-key]')];
    rows.find(row => row.dataset.historyKey === position.focus)?.focus({preventScroll: true});
    const anchor = position.anchor?.isConnected ? position.anchor : rows.find(row =>
      row.dataset.historyKey === position.anchor?.dataset.historyKey);
    if (anchor) scrollBy(0, anchor.getBoundingClientRect().top - position.top);
  }

  function canRefreshHistory(container) {
    const selection = document.getSelection();
    const copying = selection && !selection.isCollapsed &&
      (container.contains(selection.anchorNode) || container.contains(selection.focusNode));
    const focused = document.activeElement;
    return !copying && !container.querySelector('details[open]') &&
      (!container.contains(focused) || (container === items && focused.hasAttribute('data-history-key')));
  }

  async function refreshHistoryPane(id, connection, signal) {
    const key = id ? memoryKey('codex-thread', project, id) : indexKey;
    const container = id ? reading : items;
    const field = id ? 'turns' : 'data';
    const entry = resources.get(key);
    const current = () => layout.isConnected && !dom.shell.hidden && !document.hidden && !signal.aborted &&
      ui.view === 'codex' && ui.project === project && connectionGeneration === connection &&
      resources.get(key) === entry && (!id || ui.threadIds.get(project) === id);
    if (!entry || entry.pending || paging.has(key) || !canRefreshHistory(container)) return;
    const previous = entry.value;
    const pageCount = codexHistoryPages.get(previous) ?? 1;
    const mayUpdate = () => current() && !paging.has(key) && (codexHistoryPages.get(previous) ?? 1) === pageCount &&
      canRefreshHistory(container);
    try {
      let snapshot, cursor;
      let page = 0;
      const batches = [];
      for (; page < pageCount; page++) {
        const result = await api(apiPath(id ? '/api/codex/thread' : '/api/codex/threads', {project, id, cursor}), {signal});
        if (!mayUpdate()) return;
        if (!Array.isArray(result?.[field]) || (id && result.thread?.id !== id)) throw new Error('Invalid Codex history response');
        snapshot ??= {...result};
        if (id && cursor) for (const turn of result.turns) turnHistoryCursors.set(turn, cursor);
        batches.push(result[field]);
        snapshot.nextCursor = typeof result.nextCursor === 'string' && result.nextCursor !== cursor ? result.nextCursor : null;
        cursor = snapshot.nextCursor;
        if (!cursor) { page++; break; }
      }
      const rows = (id ? batches.reverse() : batches).flat();
      snapshot[field] = [...new Map(rows.filter(row => row?.id).map(row => [row.id, row])).values()];
      if (!entry.error && JSON.stringify(snapshot) === JSON.stringify(previous)) return;
      const position = historyPosition(container);
      codexHistoryPages.set(snapshot, page);
      entry.value = snapshot;
      entry.error = undefined;
      if (id) showThread(position);
      else {
        items.replaceChildren();
        showThreads(snapshot, items, true);
        restoreHistoryPosition(items, position);
      }
    } catch (error) {
      if (!current() || ![403, 404].includes(error.status)) return;
      entry.value = undefined;
      entry.error = error.message;
      container.replaceChildren(node('p', 'empty', error.message));
      if (id) {
        thread.header.replaceChildren(node('h2', '', 'スレッド詳細'));
        if (controlsThread === id) showControls(null);
      }
    }
  }

  const interval = window.setInterval(() => {
    if (historyRequest || document.hidden || dom.shell.hidden || connectionState !== 'connected' || !selectedProject()?.codexScopes) return;
    const request = new AbortController();
    historyRequest = request;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
    const connection = connectionGeneration;
    const selected = ui.threadIds.get(project);
    const refresh = [refreshHistoryPane(undefined, connection, signal)];
    if (selected) refresh.push(refreshHistoryPane(selected, connection, signal));
    void Promise.allSettled(refresh).finally(() => { historyRequest = undefined; });
  }, 30000);
  const cleanup = () => {
    window.clearInterval(interval);
    historyRequest?.abort();
    runViewCleanups.delete(cleanup);
  };
  runViewCleanups.add(cleanup);
  fetchView(indexKey, apiPath('/api/codex/threads', {project}), items, showThreads);
  showThread();
}
function artifacts() {
  const registered = asArray(ui.portfolio?.artifacts);
  const sources = [
    {label: '通常API', name: undefined, files: new Map(), offset: 0, pages: 0},
    {label: 'Codex', name: 'codex', files: new Map(), offset: 0, pages: 0},
  ];
  const openProof = new Set();
  let generation = 0;
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
  function codexDownload(label, href, asButton = false) {
    const action = link(label, href, true, asButton);
    if (!action || new URL(action.href).origin !== location.origin) return null;
    action.download = '';
    return action;
  }

  function proofFor(artifact) {
    const actions = [['要件', artifact.evidence?.requirements], ['検証記録', artifact.evidence?.verification]]
      .flatMap(([label, proof]) => {
        if (typeof proof?.path !== 'string' || !proof.path) return [];
        const download = codexDownload(label + ' · ' + proof.path, proof.href);
        return download ? [listItem(download)] : [];
      });
    if (!actions.length) return null;
    const details = node('details', 'small');
    details.append(node('summary', '', '要件と検証記録'));
    const proof = node('ul', 'marked-list');
    proof.append(...actions);
    details.append(proof);
    details.open = openProof.has(artifact.href);
    details.addEventListener('toggle', () => {
      if (details.open) openProof.add(artifact.href);
      else openProof.delete(artifact.href);
    });
    return details;
  }

  function filter(query, preserveReading = false) {
    const visible = [...registered, ...sources.flatMap(source => [...source.files.values()])]
      .filter(item => (only.value !== 'project' || item.project === ui.project) &&
        matches(query, item.title, item.description, item.observedAt, time(item.observedAt),
          projectList().find(candidate => candidate.id === item.project)?.name))
      .sort((a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0));
    const anchor = preserveReading ? [...list.children].find(row => {
      const {top, bottom} = row.getBoundingClientRect();
      return top < innerHeight && bottom > 0;
    }) : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    let restoredAnchor;
    list.replaceChildren();
    for (const artifact of visible) {
      const item = node('div', 'artifact-row');
      const main = node('div');
      main.append(node('h3', '', text(artifact.title)));
      const project = projectList().find(candidate => candidate.id === artifact.project);
      const fromCodex = artifact.workSource === 'codex';
      main.append(node('p', 'muted small', (project?.name ?? 'プロジェクト不明') +
        (fromCodex ? ' · Codex' : '') + ' · 確認 ' + time(artifact.observedAt)));
      if (artifact.description) main.append(node('p', '', artifact.description));
      if (fromCodex) {
        const proof = proofFor(artifact);
        if (proof) main.append(proof);
      }
      item.append(main);
      const action = fromCodex ? codexDownload('取得', artifact.href, true) :
        link(artifact.kind === 'file' ? '取得' : '開く', artifact.href, true, true);
      if (action) item.append(action);
      else item.append(chip('unknown', '取得先未確認'));
      const row = listItem(item);
      row.dataset.artifactKey = JSON.stringify([artifact.workSource ?? '', artifact.project, artifact.href]);
      if (row.dataset.artifactKey === anchor?.dataset.artifactKey) restoredAnchor = row;
      list.append(row);
    }
    if (restoredAnchor) window.scrollBy(0, restoredAnchor.getBoundingClientRect().top - anchorTop);
    empty.hidden = visible.length > 0;
    empty.textContent = query ? '一致する成果物がありません。' : '表示できる確認済みの成果物はありません。';
  }
  const controls = node('div', 'pagination run-actions');
  for (const source of sources) {
    source.more = button('以前の' + source.label + '成果物を表示', () => loadWork(source));
    source.more.hidden = true;
    source.retry = button(source.label + 'の成果物を再取得', () => loadWork(source, {refresh: source.refreshFailed}));
    source.retry.hidden = true;
    source.status = node('p', 'muted small');
    source.status.setAttribute('role', 'status');
    source.status.hidden = true;
    controls.append(source.more, source.status, source.retry);
  }

  function canRefreshWork() {
    const selected = document.getSelection();
    const copying = selected && !selected.isCollapsed && (list.contains(selected.anchorNode) || list.contains(selected.focusNode));
    return section.root.isConnected && !dom.shell.hidden && !document.hidden && connectionState === 'connected' &&
      !dom['refresh-button'].disabled && !controls.contains(document.activeElement) && !list.contains(document.activeElement) && !copying;
  }

  async function loadWork(source, {refresh = false, automatic = false} = {}) {
    if (source.request || (!refresh && source.offset === null)) return;
    const generationAtStart = generation;
    const connection = connectionGeneration;
    const sameScope = () => section.root.isConnected && !dom.shell.hidden && generationAtStart === generation;
    const current = () => sameScope() && connection === connectionGeneration;
    const request = new AbortController();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
    source.request = request;
    source.more.disabled = source.retry.disabled = true;
    try {
      let offset = refresh ? 0 : source.offset;
      const pages = refresh ? Math.max(1, source.pages) : 1;
      const files = refresh ? new Map() : new Map(source.files);
      let loaded = 0;
      for (; loaded < pages && offset !== null; loaded++) {
        const result = await api(apiPath('/api/artifacts/work', {
          project: only.value === 'project' ? ui.project : undefined, source: source.name, offset,
        }), {signal});
        if (!current()) return;
        if (!Array.isArray(result?.artifacts)) throw new Error('Invalid artifact response');
        for (const file of result.artifacts) {
          if (typeof file?.href !== 'string' || (source.name && file.kind !== 'file')) continue;
          files.set(file.href, {...file, workSource: source.name});
        }
        offset = Number.isSafeInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
      }
      const changed = JSON.stringify([...files.values()]) !== JSON.stringify([...source.files.values()]);
      if (automatic && changed && !canRefreshWork()) return;
      source.files = files;
      source.offset = offset;
      source.pages = (refresh ? 0 : source.pages) + loaded;
      source.more.hidden = source.offset === null;
      source.status.hidden = source.retry.hidden = true;
      if (changed) filter(search.value, refresh);
    } catch (error) {
      if (!current()) return;
      if (error.status === 403 || error.status === 404) {
        source.files.clear();
        source.offset = source.pages = 0;
        filter(search.value, refresh);
      }
      source.refreshFailed = refresh;
      source.status.textContent = source.label + (refresh ? 'の成果物を更新できませんでした。' : 'の成果物を読み取れませんでした。');
      source.status.hidden = source.retry.hidden = false;
      source.more.hidden = true;
    } finally {
      if (sameScope()) {
        source.request = null;
        source.more.disabled = source.retry.disabled = false;
      }
    }
  }
  const search = queryInput('artifact-search', '成果物を検索', '成果物を検索', filter);
  only.addEventListener('change', () => {
    ui.searches.set('artifact-filter', only.value);
    storeTab();
    generation++;
    for (const source of sources) {
      source.request?.abort();
      source.request = null;
      source.offset = source.pages = 0;
      source.refreshFailed = false;
      source.more.hidden = source.status.hidden = source.retry.hidden = true;
      source.files.clear();
    }
    filter(search.value);
    for (const source of sources) void loadWork(source);
  });
  searchWrap.append(search);
  section.body.remove();
  section.root.append(searchWrap, empty, list, controls);
  dom.content.append(section.root);
  filter(search.value);
  for (const source of sources) void loadWork(source);
  const interval = window.setInterval(() => {
    if (canRefreshWork()) for (const source of sources) void loadWork(source, {refresh: true, automatic: true});
  }, 30000);
  const cleanup = () => {
    generation++;
    window.clearInterval(interval);
    for (const source of sources) source.request?.abort();
    runViewCleanups.delete(cleanup);
  };
  runViewCleanups.add(cleanup);
}
function emptyProject() {
  dom.content.append(node('p', 'empty panel', '上のプロジェクト欄から対象を選んでください。'));
}
function projectNeedsWorkspace() {
  dom.content.append(node('p', 'empty panel', '作業先と利用権限を登録すると、この案件を開けます。'));
}

const screens = {dashboard, chat, codex, artifacts};
const dashboardSummary = () => ui.portfolio?.taskProgressSource?.observedAt
  ? '開発タスクの観測 ' + time(ui.portfolio.taskProgressSource.observedAt)
  : '案件データの観測 ' + time(ui.portfolio?.observedAt);
function render(restore = true, keepNotice = false) {
  if (dom.shell.hidden) return;
  abortLocalDictation();
  stopSpeech();
  for (const stop of runViewCleanups) stop();
  mounted++;
  const intended = ui.scroll.get(routeKey());
  pendingScroll = restore ? {epoch: mounted, y: Number.isFinite(intended) ? intended : 0} : null;
  if (!keepNotice) setNotice();
  dom.content.replaceChildren();
  for (const anchor of dom.navigation.querySelectorAll('[data-view]')) {
    if (anchor.dataset.view === ui.view) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  const title = pages[ui.view];
  document.title = title + ' · Personal AI HQ';
  dom['page-title'].textContent = title;
  const summaries = {
    dashboard: dashboardSummary(),
    chat: 'プロジェクト別の会話履歴',
    codex: '端末から取得したスレッドと会話本文',
    artifacts: '確認された成果物を横断して検索',
  };
  dom['page-summary'].textContent = summaries[ui.view];
  screens[ui.view]();
  syncChatDevelopment();
  paintActivity();
  void pollActivity();
  if (restore) restoreScroll();
}
function canRefreshVisibleDashboard() {
  if (connectionState === 'offline' || connectionState === 'checking') return false;
  if (document.hidden || dom.shell.hidden || ui.view !== 'dashboard' || !ui.portfolio || dom['refresh-button'].disabled) return false;
  const focused = document.activeElement;
  const editing = focused?.matches('input, select, textarea, [contenteditable="true"]');
  const readingDetailLink = focused?.closest('details[data-dashboard-detail]') && !focused.matches('summary');
  const pairing = dom.content.querySelector('[data-pair-expires-at]');
  return !editing && !readingDetailLink && !dom.content.querySelector('details[open]:not([data-dashboard-detail])') &&
    !(Date.parse(pairing?.dataset.pairExpiresAt) > Date.now());
}
async function refreshVisibleDashboard() {
  refreshEstimateReadouts();
  paintAppHostConnection();
  if (portfolioPollRunning || !canRefreshVisibleDashboard()) return;
  const generation = requestSequence;
  const connection = connectionGeneration;
  const executionVersion = dashboardExecutionVersion;
  const isCurrent = () => generation === requestSequence && connection === connectionGeneration &&
    executionVersion === dashboardExecutionVersion && canRefreshVisibleDashboard();
  portfolioPollRunning = true;
  try {
    const latest = await api('/api/portfolio', {signal: AbortSignal.timeout(6500)});
    if (!isCurrent()) return;
    dom['page-summary'].textContent = dashboardSummary();
    if (JSON.stringify(latest) === JSON.stringify(ui.portfolio)) {
      if (setObservedPortfolio(ui.portfolio, connection)) repaintDashboardExecutions();
      return;
    }
    const focused = document.activeElement;
    const focusedProject = focused?.dataset?.dashboardProject;
    const focusedDetail = focused?.matches('summary') ? focused.parentElement.dataset.dashboardDetail : null;
    const selected = ui.project;
    const openDetails = [...dom.content.querySelectorAll('details[data-dashboard-detail][open]')];
    const openNames = new Set(openDetails.map(detail => detail.dataset.dashboardDetail));
    const visibleDetails = openDetails.filter(detail => {
      const {top, bottom} = detail.getBoundingClientRect();
      return top < innerHeight && bottom > 0;
    });
    const anchor = visibleDetails.find(detail => detail.contains(focused)) ?? visibleDetails[0];
    const anchorTop = anchor?.getBoundingClientRect().top;
    rememberScroll();
    setObservedPortfolio(latest, connection);
    updateProjectSelect();
    render(true, true);
    if (ui.project === selected) {
      const details = [...dom.content.querySelectorAll('details[data-dashboard-detail]')];
      for (const detail of details) {
        if (openNames.has(detail.dataset.dashboardDetail)) detail.open = true;
        if (focusedDetail === detail.dataset.dashboardDetail) detail.firstElementChild.focus({preventScroll: true});
      }
      const restoredAnchor = details.find(detail => detail.dataset.dashboardDetail === anchor?.dataset.dashboardDetail);
      if (restoredAnchor?.open && pendingScroll) {
        pendingScroll.y = Math.max(0, scrollY + restoredAnchor.getBoundingClientRect().top - anchorTop);
      }
    }
    if (focusedProject) dashboardProjectRow(focusedProject)?.focus({preventScroll: true});
  } catch {
    if (generation === requestSequence && connection === connectionGeneration) forgetAppHostObservation();
    if (isCurrent()) dom['page-summary'].textContent = dashboardSummary() + ' · 更新できません。前回の情報を表示しています。';
  } finally { portfolioPollRunning = false; }
}
async function refresh() {
  const id = ++requestSequence;
  const generation = connectionGeneration;
  const executionVersion = dashboardExecutionVersion;
  dom['refresh-button'].disabled = true;
  const onPage = !dom.shell.hidden;
  if (onPage) setNotice('情報を取得しています。');
  try {
    const portfolio = await api('/api/portfolio');
    if (id !== requestSequence) return;
    if (generation !== connectionGeneration || executionVersion !== dashboardExecutionVersion) { setNotice(); return; }
    if (onPage) rememberScroll();
    dom.gate.hidden = true;
    dom.shell.hidden = false;
    if (!onPage) showConnection(navigator.onLine ? 'connected' : 'offline');
    setObservedPortfolio(portfolio, connectionGeneration);
    resources.clear();
    updateProjectSelect();
    render();
  } catch (error) {
    if (id !== requestSequence) return;
    if (generation === connectionGeneration) forgetAppHostObservation();
    if (ui.portfolio) setNotice(generation === connectionGeneration ? error.message : '', true);
    else if (error.status !== 401) gate('情報を取得できません', error.message, true);
  } finally {
    if (id === requestSequence) dom['refresh-button'].disabled = false;
  }
}
async function activate() {
  gate('接続を確認しています', '', false);
  try {
    const session = await api('/api/session');
    ui.capabilities = session?.capabilities ?? {};
    if (session?.authenticated !== true) {
      endSession();
      return;
    }
    await refresh();
  } catch (error) {
    if (error.status !== 401) gate('接続できません', error.message, true);
  }
}

dom['gate-tailnet'].addEventListener('submit', async event => {
  event.preventDefault();
  const input = dom['gate-code'];
  const submit = dom['gate-connect'];
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    await api('/api/access/redeem', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({code: input.value})});
    input.value = '';
    await activate();
  } catch (error) {
    dom['gate-description'].textContent = error.message;
  } finally { submit.disabled = false; }
});
dom['gate-retry'].addEventListener('click', activate);
dom['project-select'].addEventListener('change', event => selectProject(event.target.value));
dom['refresh-button'].addEventListener('click', refresh);
dom['connection-retry'].addEventListener('click', recheckConnection);
dom['chat-development-toggle'].addEventListener('click', () => {
  ui.showChatDevelopment = !ui.showChatDevelopment;
  storeTab();
  syncChatDevelopment();
  paintActivity();
});
chatDevelopmentWidth.addEventListener('change', () => {
  if (ui.view !== 'chat') return;
  syncChatDevelopment();
  paintActivity();
});
dom['theme-button'].addEventListener('click', () => {
  ui.theme = ui.theme === 'system' ? 'dark' : ui.theme === 'dark' ? 'light' : 'system';
  setTheme();
  storePreferences();
});
window.addEventListener('hashchange', changeView);
window.addEventListener('offline', () => {
  if (!dom.shell.hidden) showConnection('offline');
});
window.addEventListener('online', () => {
  if (connectionState !== 'connected') void recheckConnection();
});
for (const input of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
  window.addEventListener(input, () => { pendingScroll = null; }, {passive: true});
}
window.addEventListener('pagehide', () => {
  abortLocalDictation();
  if (!dom.shell.hidden) rememberScroll();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) abortLocalDictation();
  else {
    paintActivity();
    void refreshVisibleDashboard();
    void pollActivity();
  }
});
window.setInterval(() => void refreshVisibleDashboard(), 30000);
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
setTheme();
void activate();
