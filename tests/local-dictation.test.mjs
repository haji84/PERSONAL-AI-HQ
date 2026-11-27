import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import test from 'node:test';
import {abortLocalDictation, createLocalDictation} from '../public/dictation.mjs';

class Element extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this.value = '';
    this.children = [];
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.isConnected = true;
  }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

function browser(t, {secure = true, local = true, availability = 'available'} = {}) {
  const probes = [];
  const instances = [];
  const actions = [];
  let state = availability;
  class Recognition extends EventTarget {
    static async available(options) {
      probes.push({kind: 'available', options});
      return state;
    }

    static async install(options) {
      probes.push({kind: 'install', options});
      state = 'available';
      return true;
    }

    constructor() {
      super();
      if (local) this.processLocally = false;
      this.started = 0;
      this.aborted = 0;
      instances.push(this);
    }

    start() { actions.push('start'); this.started++; }
    stop() { actions.push('stop'); }
    abort() { actions.push('abort'); this.aborted++; }

    emit(type, fields) {
      const event = Object.assign(new Event(type), fields);
      this.dispatchEvent(event);
      this['on' + type]?.(event);
    }
  }

  if (local) Recognition.prototype.processLocally = false;
  const document = {createElement: tag => new Element(tag)};
  for (const [name, value] of Object.entries({document, SpeechRecognition: Recognition, webkitSpeechRecognition: undefined,
    isSecureContext: secure, window: {SpeechRecognition: Recognition, document, isSecureContext: secure}})) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, value});
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  t.after(abortLocalDictation);
  return {probes, instances, actions};
}

function controls(element) {
  assert.equal(element?.tagName, 'DIV');
  const [button, status] = element.children;
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(status.getAttribute('role'), 'status');
  return {button, status};
}

function speechResult(text, isFinal) {
  return Object.assign([{transcript: text}], {isFinal});
}

const localJapanese = {langs: ['ja-JP'], processLocally: true};

test('dictation stays unavailable without secure local recognition support', async t => {
  for (const options of [{secure: false}, {local: false}]) {
    await t.test(JSON.stringify(options), async current => {
      const {probes, actions} = browser(current, options);
      assert.equal(createLocalDictation(new Element('textarea')), null);
      await settle();
      assert.deepEqual(probes, []);
      assert.deepEqual(actions, []);
    });
  }
});

test('an unavailable local language stays hidden and never starts', async t => {
  const {actions, probes} = browser(t, {availability: 'unavailable'});
  const element = createLocalDictation(new Element('textarea'));
  assert.equal(element.hidden, true);
  await settle();
  assert.equal(element.hidden, true);
  controls(element).button.click();
  await settle();
  assert.deepEqual(actions, []);
  assert.deepEqual(probes, [{kind: 'available', options: localJapanese}]);
});

test('Japanese recognition preparation is explicit and never starts the microphone', async t => {
  const {probes, actions} = browser(t, {availability: 'downloadable'});
  const {button} = controls(createLocalDictation(new Element('textarea')));
  await settle();
  assert.equal(button.textContent, '日本語音声認識を準備');
  assert.deepEqual(probes, [{kind: 'available', options: localJapanese}]);
  assert.deepEqual(actions, []);
  button.click();
  await settle();
  assert.deepEqual(probes.filter(probe => probe.kind === 'install'), [{kind: 'install', options: localJapanese}]);
  assert.ok(probes.every(probe => probe.options.processLocally === true));
  assert.deepEqual(actions, []);
  assert.ok(['音声入力', '準備状況を確認'].includes(button.textContent));
});

test('an explicit local dictation appends final text, ignores interim, and discards results after route cleanup', async t => {
  const {probes, instances, actions} = browser(t);
  const draft = new Element('textarea');
  draft.value = '既存の下書き。';
  let inputs = 0;
  let sends = 0;
  draft.addEventListener('input', () => { inputs++; });
  draft.addEventListener('submit', () => { sends++; });
  draft.addEventListener('keydown', () => { sends++; });
  const {button, status} = controls(createLocalDictation(draft, {beforeStart: () => { actions.push('beforeStart'); }}));
  await settle();
  assert.equal(button.textContent, '音声入力');
  assert.deepEqual(probes, [{kind: 'available', options: localJapanese}]);
  assert.deepEqual(actions, []);
  button.click();
  await settle();
  assert.deepEqual(actions, ['beforeStart', 'start']);
  assert.equal(button.textContent, '音声入力を停止');
  const speaker = instances.find(instance => instance.started === 1);
  assert.equal(speaker?.lang, 'ja-JP');
  assert.equal(speaker.processLocally, true);
  speaker.emit('result', {resultIndex: 0, results: [speechResult('途中', false)]});
  assert.equal(draft.value, '既存の下書き。');
  assert.equal(inputs, 0);
  speaker.emit('result', {resultIndex: 0, results: [speechResult('確定した入力です。', true)]});
  assert.match(draft.value, /^既存の下書き。\s*確定した入力です。$/u);
  assert.equal(status.textContent, '下書きに追加しました。');
  assert.equal(inputs, 1);
  const accepted = draft.value;
  abortLocalDictation();
  assert.equal(speaker.aborted, 1);
  speaker.emit('result', {resultIndex: 0, results: [speechResult('古い入力', true)]});
  speaker.emit('end', {});
  assert.equal(draft.value, accepted);
  assert.equal(inputs, 1);
  assert.equal(sends, 0);
});

test('microphone denial appears in status without changing the draft', async t => {
  const {instances} = browser(t);
  const draft = new Element('textarea');
  const {button, status} = controls(createLocalDictation(draft));
  await settle();
  button.click();
  await settle();
  const speaker = instances.find(instance => instance.started === 1);
  assert.ok(speaker);
  speaker.emit('error', {error: 'not-allowed'});
  assert.match(status.textContent, /マイク|権限|許可/u);
  assert.equal(draft.value, '');
});

test('a new draft owns capture and results never cross between drafts', async t => {
  const {instances} = browser(t);
  const first = new Element('textarea');
  const next = new Element('textarea');
  const firstControl = controls(createLocalDictation(first));
  const nextControl = controls(createLocalDictation(next));
  await settle();
  firstControl.button.click();
  const firstCapture = instances.find(instance => instance.started === 1);
  assert.ok(firstCapture);
  nextControl.button.click();
  const nextCapture = instances.find(instance => instance !== firstCapture && instance.started === 1);
  assert.ok(nextCapture);
  assert.equal(firstCapture.aborted, 1);
  abortLocalDictation(first);
  assert.equal(nextCapture.aborted, 0);
  firstCapture.emit('result', {resultIndex: 0, results: [speechResult('切り替え前', true)]});
  nextCapture.emit('result', {resultIndex: 0, results: [speechResult('切り替え後', true)]});
  assert.equal(first.value, '');
  assert.equal(next.value, '切り替え後');
});
