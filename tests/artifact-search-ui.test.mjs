import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const app = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function artifacts()'), app.indexOf('function emptyProject()'));
const settled = () => new Promise(setImmediate);
const firstRevision = 'a'.repeat(64);
const secondRevision = 'b'.repeat(64);
const artifact = (title, project = 'chosen') => ({
  title, project, kind: 'file', href: '/artifact/' + encodeURIComponent(title),
  observedAt: '2026-11-28T09:30:00.000Z', evidence: {requirements: {path: 'GOAL.md', href: '/proof'}},
});

function fixture(reply, registered = []) {
  function node(tag, style, textContent = '') {
    return {tag, style, textContent, children: [], events: {}, dataset: {}, hidden: false, isConnected: true,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }, remove() {},
      addEventListener(event, callback) { this.events[event] = callback; },
      setAttribute() {}, removeAttribute() {},
      contains(value) { return this === value || this.children.some(child => child.contains(value)); },
      getBoundingClientRect() { return {top: 0, bottom: 100}; }};
  }
  const asArray = value => Array.isArray(value) ? value : [];
  const content = node('main');
  const ui = {project: 'chosen', portfolio: {artifacts: registered}, scroll: new Map(), searches: new Map(), artifactReading: new Map()};
  const requests = [];
  const timers = new Map();
  const intervals = new Map();
  const cleanups = new Set();
  const scrollPositions = [];
  let timerId = 0;
  const routeKey = () => 'artifacts:chosen:' + (ui.searches.get('artifact-filter') ?? 'all');
  const context = {
    ui, node, AbortController, AbortSignal, asArray, routeKey,
    runViewCleanups: cleanups, dom: {content, shell: {hidden: false}, 'refresh-button': {disabled: false}},
    document: {hidden: false, getSelection: () => null}, connectionState: 'connected', connectionGeneration: 0,
    innerHeight: 800, scrollY: 0, pendingScroll: undefined, mounted: 1,
    window: {setInterval(fn) { intervals.set(++timerId, fn); return timerId; },
      clearInterval(id) { intervals.delete(id); }, scrollBy() {}},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); }, storeTab() {},
    rememberScroll() { if (!ui.searches.get('artifact-search')?.trim()) ui.scroll.set(routeKey(), context.scrollY); },
    queueViewScroll: () => ({epoch: 1, y: ui.scroll.get(routeKey()) ?? 0}),
    restoreScroll() { if (context.pendingScroll) scrollPositions.push(context.pendingScroll.y); },
    projectList: () => [{id: 'chosen', name: 'Chosen'}, {id: 'other', name: 'Other'}],
    selectedProject: () => ({name: 'Chosen'}),
    artifactFilterScope: () => ui.searches.get('artifact-filter') ?? 'all',
    text: value => value, time: value => value, chip: (_, label) => node('span', '', label),
    matches: (query, ...values) => values.some(value => String(value).toLowerCase().includes(query.trim().toLowerCase())),
    panel() {
      const root = node('section'), header = node('header'), body = node('div');
      root.append(header, body);
      return {root, header, body};
    },
    button: (label, click) => ({...node('button', '', label), click}),
    listItem(child) { const item = node('li'); item.append(child); return item; },
    link: label => node('a', '', label), codexDownload: label => node('a', '', label),
    queryInput(key, label, _, change) {
      const field = node('input', '', label);
      field.value = ui.searches.get(key) ?? '';
      field.input = value => { field.value = value; ui.searches.set(key,value); change(value); };
      return field;
    },
    apiPath: (_, params) => params,
    async api(params, {signal}) {
      requests.push({...params, signal});
      const result = await reply(params);
      return params.q && result?.nextOffset !== null ? {searchRevision: firstRevision, ...result} : result;
    },
  };
  runInNewContext(source + '\nartifacts();', context);
  const descendants = root => [root, ...root.children.flatMap(descendants)];
  const visible = (root, parentVisible = true) => parentVisible && !root.hidden
    ? [root, ...root.children.flatMap(child => visible(child))] : [];
  const findButton = label => visible(content).find(item => item.tag === 'button' && item.textContent === label);
  return {
    requests, scrollPositions, cleanups,
    input(value) { descendants(content).find(item => item.tag === 'input').input(value); },
    scope(value) { const field = descendants(content).find(item => item.tag === 'select'); field.value = value; field.events.change(); },
    scroll(y) { context.scrollY = y; },
    flush() { for (const fn of [...timers.values()]) fn(); timers.clear(); },
    tick() { for (const fn of intervals.values()) fn(); },
    titles: () => visible(content).filter(item => item.tag === 'h3').map(item => item.textContent),
    messages: () => visible(content).filter(item => item.tag === 'p').map(item => item.textContent),
    findButton,
    details: () => visible(content).find(item => item.tag === 'details'),
  };
}

test('search advances through an empty server page and restores ordinary browsing on clear', async () => {
  const view = fixture(({source, offset, q}) => {
    if (q) return offset === 0 ? {artifacts: [], nextOffset: 1}
      : {artifacts: source ? [artifact('Server indexed alias')] : [], nextOffset: null};
    return {artifacts: source ? [artifact(offset === 0 ? 'Newest' : 'Older')] : [], nextOffset: source && offset === 0 ? 1 : null};
  }, [artifact('STATIC needle')]);
  await settled();
  view.findButton('以前のCodex成果物を表示').click();
  await settled();
  const opened = view.details();
  opened.open = true;
  opened.events.toggle();
  view.scroll(320);
  view.input('ne');
  view.input('  needle  ');
  assert.equal(view.requests.some(request => request.q), false);
  view.flush();
  await settled();
  assert.deepEqual(view.requests.filter(request => request.source === 'codex' && request.q)
    .map(({q, offset}) => [q, offset]), [['needle', 0], ['needle', 1]]);
  assert.deepEqual(view.titles(), ['STATIC needle', 'Server indexed alias']);

  const count = view.requests.length;
  view.input('');
  await settled();
  assert.equal(view.requests.length, count);
  assert.deepEqual(view.titles(), ['STATIC needle', 'Newest', 'Older']);
  assert.equal(view.details().open, true);
  assert.equal(view.scrollPositions.at(-1), 320);
});

test('changing query or project scope aborts stale searches and leaves other results out of view', async () => {
  const pending = [];
  const view = fixture(({source, q, project}) => {
    if (!q || !source) return {artifacts: [], nextOffset: null};
    if (q === 'old' || !project) return new Promise(resolve => pending.push(resolve));
    return {artifacts: [artifact('Current hit')], nextOffset: null};
  });
  await settled();
  view.input('old');
  view.flush();
  await settled();
  view.input('new');
  view.flush();
  await settled();
  view.scope('project');
  view.flush();
  await settled();
  assert.equal(view.requests.find(request => request.q === 'old' && request.source === 'codex').signal.aborted, true);
  assert.equal(view.requests.find(request => request.q === 'new' && !request.project && request.source === 'codex').signal.aborted, true);
  assert.equal(view.requests.find(request => request.q === 'new' && request.project === 'chosen' && request.source === 'codex').offset, 0);
  for (const resolve of pending) resolve({artifacts: [artifact('Late hit', 'other')], nextOffset: null});
  await settled();
  assert.deepEqual(view.titles(), ['Current hit']);
});

test('a bounded unfinished scan offers continuation and an error offers retry without claiming no results', async () => {
  let failing = false;
  let resumed = false;
  const view = fixture(({source, q, offset}) => {
    if (!q || !source) return {artifacts: [], nextOffset: null};
    if (failing) {
      if (!resumed) throw Object.assign(new Error('Source timed out'), {status: 503});
      return {artifacts: [artifact('Found after retry')], nextOffset: null};
    }
    return {artifacts: [], nextOffset: offset + 1};
  });
  await settled();
  view.input('anything');
  view.flush();
  await settled();
  const scanned = view.requests.filter(request => request.q && request.source === 'codex');
  assert.ok(scanned.length > 1 && scanned.length <= 10);
  assert.equal(view.messages().includes('一致する成果物がありません。'), false);
  const more = view.findButton('Codexの検索を続ける');
  assert.ok(more);
  failing = true;
  more.click();
  await settled();
  assert.equal(view.messages().includes('一致する成果物がありません。'), false);
  const retry = view.findButton('Codexの検索を再試行');
  assert.ok(retry);
  resumed = true;
  retry.click();
  await settled();
  assert.deepEqual(view.titles(), ['Found after retry']);
});

test('automatic refresh atomically rereads only scanned search pages and removes withdrawn matches', async () => {
  let mode = 'initial';
  const view = fixture(({source, q, offset}) => {
    if (!q || !source) return {artifacts: [], nextOffset: null};
    if (offset === 0) return {artifacts: mode === 'transient' ? [artifact('Do not publish partial refresh')] : [], nextOffset: 1};
    if (mode === 'transient') throw Object.assign(new Error('Temporary network failure'), {status: 503});
    if (mode === 'revoked') throw Object.assign(new Error('Access revoked'), {status: 403});
    if (mode === 'withdrawn') return {artifacts: [], nextOffset: null};
    return {artifacts: [artifact(mode === 'initial' ? 'Originally published' : 'Newly published')], nextOffset: 2};
  });
  await settled();
  view.input('needle');
  view.flush();
  await settled();
  assert.deepEqual(view.titles(), ['Originally published']);

  const refresh = async () => {
    const start = view.requests.length;
    view.tick();
    await settled();
    return view.requests.slice(start).filter(request => request.q && request.source === 'codex').map(request => request.offset);
  };
  mode = 'transient';
  assert.deepEqual(await refresh(), [0, 1]);
  assert.deepEqual(view.titles(), ['Originally published']);
  assert.ok(view.messages().some(message => /更新.*確認できません/.test(message)));
  const retry = view.findButton('Codexの検索を再試行');
  assert.ok(retry);
  mode = 'published';
  const startRetry = view.requests.length;
  retry.click();
  await settled();
  assert.deepEqual(view.requests.slice(startRetry).filter(request => request.q).map(request => request.offset), [0, 1]);
  assert.deepEqual(view.titles(), ['Newly published']);

  mode = 'revoked';
  assert.deepEqual(await refresh(), [0, 1]);
  assert.deepEqual(view.titles(), []);
  assert.equal(view.messages().includes('一致する成果物がありません。'), false);
  mode = 'withdrawn';
  assert.deepEqual(await refresh(), [0, 1]);
  assert.deepEqual(view.titles(), []);
  assert.ok(view.messages().includes('一致する成果物がありません。'));
  assert.equal(view.findButton('Codexの検索を続ける'), undefined);
});

test('a changed server search revision invalidates its incomplete results and retries from the start', async () => {
  let changed = false;
  const view = fixture(({source, q, offset, revision}) => {
    if (!q || !source) return {artifacts: [], nextOffset: null};
    if (!offset) return {artifacts: [artifact(changed ? 'New revision' : 'Old revision')], nextOffset: 1,
      searchRevision: changed ? secondRevision : firstRevision};
    assert.equal(revision, changed ? firstRevision : secondRevision);
    throw Object.assign(new Error('Search changed'), {status: 409, code: 'ARTIFACT_SEARCH_CHANGED'});
  });
  await settled();
  view.input('needle');
  view.flush();
  await settled();
  assert.deepEqual(view.titles(), ['Old revision']);
  changed = true;
  view.findButton('Codexの検索を続ける').click();
  await settled();
  assert.equal(view.requests.filter(request => request.q && request.source === 'codex').at(-1).revision, firstRevision);
  assert.deepEqual(view.titles(), []);
  assert.equal(view.messages().includes('一致する成果物がありません。'), false);
  const retry = view.findButton('Codexの検索を再試行');
  assert.ok(retry);
  retry.click();
  await settled();
  const retried = view.requests.filter(request => request.q && request.source === 'codex').at(-1);
  assert.equal(retried.offset, 0);
  assert.equal(retried.revision, undefined);
  assert.deepEqual(view.titles(), ['New revision']);
});
