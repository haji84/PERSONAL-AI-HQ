import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
const bubbleSource = source.slice(source.indexOf('function chatHistoryImage('),source.indexOf('function apiReceiptSummary('));

function archiveFixture(read) {
  const requests = [];
  const controller = new AbortController();
  function node(tag, classes, textContent = '') {
    return {tag,classes,textContent,isConnected:true,children:[],append(...items) {
      for (const item of items) {
        if (typeof item === 'string') this.textContent += item;
        else this.children.push(item);
      }
    }, setAttribute() {}, focus() { document.activeElement = this; }};
  }
  const document = {activeElement:null};
  const item = Object.freeze({role:'assistant',text:'  冒頭\n',createdAt:null,
    original:Object.freeze({index:2,sha256:'a'.repeat(64),nextOffset:5})});
  const scope = {original:{project:'example',id:'archive',signal:controller.signal,isCurrent:() => !controller.signal.aborted}};
  const bubble = runInNewContext(bubbleSource + '\nmessageBubble(item,scope);',{
    item,scope,node,document,ui:{view:'chat',capabilities:{}},text:(value, fallback) => value || fallback,
    time:() => '',button(label,click) { return {...node('button','',label),click}; },
    apiPath:(path,params) => ({path,params}),api(request,options) {
      requests.push({...request,signal:options?.signal});
      return read(request.params.offset);
    },
  });
  const control = () => bubble.children.flatMap(child => [child,...child.children])
    .find(child => child.tag === 'button' && child.textContent === '原文の続きを読む');
  return {item,bubble,control,requests,controller,document};
}

test('archived text is appended verbatim and keeps the reviewed preview unchanged',async () => {
  const first = '\n  続き🦊\n';
  const second = ' 末尾  ';
  const fixture = archiveFixture(offset => offset === 5
    ? {text:first,nextOffset:5 + first.length} : {text:second,nextOffset:null});
  const paragraph = fixture.bubble.children.find(child => child.tag === 'p');
  const load = fixture.control();
  assert.ok(load);
  load.focus();
  assert.deepEqual(fixture.requests,[]);
  await load.click();
  await load.click();
  assert.equal(paragraph.textContent,fixture.item.text + first + second);
  assert.equal(fixture.item.text,'  冒頭\n');
  assert.deepEqual(fixture.requests.map(({path,params}) => [path,params.id,params.index,params.offset]),[
    ['/api/chat/original','archive',2,5],
    ['/api/chat/original','archive',2,5 + first.length],
  ]);
  assert.equal(load.hidden,true);
  assert.equal(fixture.document.activeElement.textContent,'原文の最後まで表示しました。');
});

test('duplicate clicks and a closed archive view cannot append a late reply',async () => {
  const pending = Promise.withResolvers();
  const fixture = archiveFixture(() => pending.promise);
  const load = fixture.control();
  assert.ok(load);
  const first = load.click();
  await load.click();
  assert.equal(fixture.requests.length,1);
  fixture.controller.abort();
  assert.equal(fixture.requests[0].signal.aborted,true);
  pending.resolve({text:'PRIVATE_LATE_REPLY',nextOffset:null});
  await first;
  assert.equal(fixture.bubble.children.find(child => child.tag === 'p').textContent,fixture.item.text);
});
