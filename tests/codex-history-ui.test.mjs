import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const app = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
const chatScreen = app.slice(app.indexOf('function chat() {'), app.indexOf('const effortLabels'));

function chatFixture(reply) {
  const requests = [];
  const cleanups = new Set();
  const resources = new Map();
  const ui = {view:'chat', project:'example', capabilities:{}, chatIds:new Map(),
    chatNativeLocations:new Map(), realtimeTurns:new Map()};
  function node(tag, className, text = '') {
    return {tag, className, textContent:text, children:[], events:{}, attrs:{}, isConnected:true,
      append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } },
      prepend(...children) { this.append(...children); this.children.unshift(...this.children.splice(-children.length)); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      addEventListener(type, listener) { this.events[type] = listener; },
      setAttribute(name,value) { this.attrs[name] = value; },
      querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); },
      focus() { this.focused = true; },
      scrollIntoView() { this.revealed = true; },
      get firstElementChild() { return this.children[0]; },
    };
  }
  const content = node('main');
  const project = {id:'example', codexScopes:true};
  const apiPath = (route, params) => ({route, params});
  const api = async (path, options) => {
    requests.push({...path, signal:options?.signal});
    return reply?.(path);
  };
  runInNewContext(chatScreen + '\nchat();', {
    ui, dom:{content}, node, AbortController, AbortSignal, setTimeout, clearTimeout,
    requestAnimationFrame: callback => queueMicrotask(callback),
    realtimeCodexIntent:undefined, pendingScroll:null, runViewCleanups:cleanups, codexRecordId:/^[a-z0-9_-]+$/i,
    validLinkedCodexId: value => typeof value === 'string' && /^[a-z0-9_-]+$/i.test(value),
    selectedProject:() => project, panel(title) {
      const root = node('section');
      const header = node('header', '', title);
      const body = node('div');
      root.append(header,body);
      return {root,header,body};
    },
    asArray: value => Array.isArray(value) ? value : [], api, apiPath, resources, memoryKey:(...args) => JSON.stringify(args),
    fetchView(_key, path, destination, paint, current = () => true) {
      void api(path).then(result => { if (!current()) return; destination.replaceChildren(); paint(result,destination); });
    },
    button(label, handler) {
      const control = node('button','',label);
      control.events.click = handler;
      return control;
    },
    queryInput(_key,_label,_placeholder,input) {
      const field = node('input');
      field.value = '';
      field.events.input = () => input(field.value);
      return field;
    },
    chatSourceLabels:{'codex-history':'Codex'}, time:() => '', text:(value,fallback) => value || fallback,
    listItem(child) { const row = node('li'); row.append(child); return row; },
    rowButton(title, detail, active, click) {
      const control = node('button','',title);
      control.attrs.detail = detail;
      control.events.click = () => click({currentTarget:control});
      return control;
    },
    messagesInto(parent,messages) {
      parent.append(...messages.map(message => node('p','',message.text)));
      return messages.length;
    },
    routeKey:() => 'chat:example', chatDevelopmentPanel:() => node('aside'),
    storeTab() {}, abortLocalDictation() {}, stopSpeech() {}, setNotice() {},
  });
  return {content, requests, cleanups};
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('Codex history search continues partial scans and opens the exact old turn page',async () => {
  const {content,requests,cleanups} = chatFixture(({route,params}) => {
    if (route === '/api/codex/history-search') return params.cursor === 'next-batch'
      ? {matches:[{id:'thread',title:'Native thread',updatedAt:null,turnId:'match',turnCursor:'old-page'}], nextCursor:null}
      : {matches:[], nextCursor:'next-batch'};
    if (route === '/api/codex/threads') return {data:[],nextCursor:null};
    if (route === '/api/codex/thread') return {thread:{id:'thread',title:'Native thread'}, turns:[
      {id:'match', messages:[{role:'user',text:'The finding is in this earlier turn.'}]},
    ]};
    return {conversations:[]};
  });
  await settled();
  const field = content.querySelectorAll('input')[0];
  field.value = 'finding';
  field.events.input();
  const form = content.querySelectorAll('form')[0];
  assert.ok(form);
  await form.events.submit({preventDefault() {}});
  await settled();
  assert.equal(requests.find(item=>item.route === '/api/codex/history-search')?.params.q,'finding');
  await form.events.submit({preventDefault() {}});
  await settled();
  const match = content.querySelectorAll('button').find(item=>item.textContent === 'Native thread');
  assert.ok(match);
  match.events.click();
  await settled();
  assert.equal(requests.find(item=>item.route === '/api/codex/thread')?.params.cursor,'old-page');
  assert.ok(content.querySelectorAll('p').some(item=>item.focused && item.textContent.includes('earlier turn')));
  const latest = content.querySelectorAll('button').find(item=>item.textContent === '最新のターンを表示');
  assert.equal(latest.hidden,false);
  latest.events.click();
  await settled();
  assert.equal(requests.findLast(item=>item.route === '/api/codex/thread')?.params.cursor,null);
  for (const cleanup of cleanups) cleanup();
});

test('query changes and leaving the chat discard pending Codex results',async () => {
  const completions = [];
  const {content,requests,cleanups} = chatFixture(({route}) => route === '/api/codex/history-search'
    ? new Promise(resolve=>completions.push(resolve))
    : {data:[],conversations:[],nextCursor:null});
  await settled();
  const field = content.querySelectorAll('input')[0];
  const form = content.querySelectorAll('form')[0];
  const submit = () => form.events.submit({preventDefault() {}});
  const enter = query => { field.value = query; field.events.input(); };
  enter('first');
  const first = submit();
  enter('second');
  assert.equal(requests.findLast(item=>item.route === '/api/codex/history-search').signal.aborted,true);
  const second = submit();
  completions[0]({matches:[{id:'old',title:'Stale thread',turnId:'turn',turnCursor:null}],nextCursor:null});
  await first;
  assert.ok(!content.querySelectorAll('button').some(item=>item.textContent === 'Stale thread'));
  for (const cleanup of cleanups) cleanup();
  assert.equal(requests.findLast(item=>item.route === '/api/codex/history-search').signal.aborted,true);
  completions[1]({matches:[{id:'second',title:'Other screen',turnId:'turn',turnCursor:null}],nextCursor:null});
  await second;
  assert.ok(!content.querySelectorAll('button').some(item=>item.textContent === 'Other screen'));
});
