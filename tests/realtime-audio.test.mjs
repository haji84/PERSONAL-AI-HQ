import assert from 'node:assert/strict';
import test from 'node:test';
import {openRealtimeAudio} from '../public/realtime-audio.mjs';

function browser(t, {grant, sampleRate = 24000, activation = true} = {}) {
  const calls = [];
  const contexts = [];
  const worklets = [];
  const track = {stop() { calls.push('stop-track'); }};
  const stream = {getTracks: () => [track], getAudioTracks: () => [track]};
  const mediaDevices = {getUserMedia(options) {
    calls.push('microphone');
    assert.equal(options.audio.channelCount, 1);
    assert.equal(options.video, false);
    return grant?.promise ?? Promise.resolve(stream);
  }};
  class AudioContext {
    currentTime = 0;
    state = 'suspended';
    destination = {};
    sources = [];
    audioWorklet = {addModule: async url => {
      calls.push('worklet');
      assert.equal(url, '/realtime-capture-worklet.mjs');
    }};
    constructor(options) {
      assert.equal(options.sampleRate, 24000);
      this.sampleRate = sampleRate;
      contexts.push(this);
    }
    async resume() { calls.push('resume'); this.state = 'running'; }
    async close() { calls.push('close-context'); this.state = 'closed'; }
    createMediaStreamSource() {
      return {connect() {}, disconnect() { calls.push('disconnect-mic'); }};
    }
    createBuffer(channels, frames, rate) {
      assert.equal(channels, 1);
      assert.equal(rate, 24000);
      const data = new Float32Array(frames);
      return {getChannelData: () => data};
    }
    createBufferSource() {
      const node = {connect() {}, disconnect() {}, start(at) { node.at = at; }, stop() { node.stopped = true; }};
      this.sources.push(node);
      return node;
    }
  }
  class AudioWorkletNode {
    port = {onmessage: null, postMessage: () => { calls.push('flush'); }, close() { calls.push('close-port'); }};
    constructor(_context, name, options) {
      assert.equal(name, 'hq-realtime-capture');
      assert.equal(options.numberOfOutputs, 1);
      assert.equal(options.outputChannelCount[0], 1);
      this.options = options;
      worklets.push(this);
    }
    connect() {}
    disconnect() { calls.push('disconnect-worklet'); }
    deliver(data) { this.port.onmessage?.({data}); }
  }
  for (const [key, value] of Object.entries({AudioContext, AudioWorkletNode, isSecureContext: true,
    navigator: {mediaDevices, userActivation: {isActive: activation}}})) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, value});
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  return {calls, worklets, contexts, stream};
}

function chunk(frames, activeSamples = frames) {
  const pcm = new ArrayBuffer(frames * 2);
  new DataView(pcm).setInt16(0, -24576, true);
  return {type: 'chunk', pcm, activeSamples};
}

test('opening requires a user gesture and one lease and restarts only after close', async t => {
  const {calls, contexts} = browser(t);
  await assert.rejects(openRealtimeAudio({maxSeconds: 0}), /録音/);
  const opening = openRealtimeAudio({maxSeconds: 2});
  assert.deepEqual(calls.slice(0, 2), ['resume', 'microphone']);
  await assert.rejects(openRealtimeAudio({maxSeconds: 2}), /使用中/);
  const first = await opening;
  first.close();
  first.close();
  const second = await openRealtimeAudio({maxSeconds: 2});
  assert.equal(contexts.length, 2);
  second.close();
  assert.equal(calls.filter(call => call === 'stop-track').length, 2);
});

test('abort before a permission grant releases the lease and stops the late track', async t => {
  const grant = Promise.withResolvers();
  const controller = new AbortController();
  const {calls, stream} = browser(t, {grant});
  const pending = openRealtimeAudio({maxSeconds: 2, signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, /終了/);
  assert.equal(calls.includes('close-context'), true);
  grant.resolve(stream);
  await Promise.resolve();
  assert.equal(calls.includes('stop-track'), true);
});

test('unsupported 24 kHz or inactive gesture opens no microphone', async t => {
  const {calls} = browser(t, {sampleRate: 48000});
  await assert.rejects(openRealtimeAudio({maxSeconds: 2}), /24 kHz/);
  assert.equal(calls.includes('microphone'), false);
  navigator.userActivation.isActive = false;
  await assert.rejects(openRealtimeAudio({maxSeconds: 2}), /ボタン/);
  assert.equal(calls.includes('microphone'), false);
});

test('finish is repeatable, flushes exact PCM, and keeps the playback context open', async t => {
  const {calls, worklets, contexts} = browser(t);
  const session = await openRealtimeAudio({maxSeconds: 2});
  t.after(() => session.close());
  const worklet = worklets[0];
  worklet.deliver(chunk(2400));
  const result = session.finish();
  assert.equal(calls.includes('stop-track'), true);
  assert.equal(calls.includes('flush'), true);
  const finalChunk = chunk(100);
  worklet.deliver(finalChunk);
  worklet.deliver({type: 'done', limit: false});
  const pcm = await result;
  assert.equal(pcm.byteLength, 5000);
  assert.equal(new DataView(pcm.buffer).getInt16(4800, true), -24576);
  assert.equal(await session.finish(), pcm);
  assert.equal(calls.includes('close-port'), true);
  assert.equal(contexts[0].state, 'running');
});

test('recording limit fires once with the microphone released; silent audio is withheld', async t => {
  const {calls, worklets} = browser(t);
  let limits = 0;
  const session = await openRealtimeAudio({maxSeconds: 1, onLimit() {
    assert.equal(calls.includes('stop-track'), true);
    limits++;
  }});
  t.after(() => session.close());
  const worklet = worklets[0];
  worklet.deliver(chunk(24000, 0));
  worklet.deliver({type: 'done', limit: true});
  worklet.deliver({type: 'done', limit: true});
  assert.equal(limits, 1);
  await assert.rejects(session.finish(), /音声を確認/);
});

test('the wall limit stops mic immediately when input frames arrive too slowly', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {calls, worklets} = browser(t);
  let limits = 0;
  const session = await openRealtimeAudio({maxSeconds: 1, onLimit() { limits++; }});
  t.after(() => session.close());
  worklets[0].deliver(chunk(2400));
  t.mock.timers.tick(1000);
  assert.equal(calls.includes('stop-track'), true);
  assert.equal(calls.includes('flush'), true);
  assert.equal(limits, 0);
  worklets[0].deliver({type: 'done', limit: false});
  assert.equal(limits, 1);
  assert.equal((await session.finish()).length, 4800);
});

test('streaming PCM schedules sequential output and stop discards queued and late frames', async t => {
  const {contexts, worklets} = browser(t);
  const session = await openRealtimeAudio({maxSeconds: 2});
  t.after(() => session.close());
  worklets[0].deliver(chunk(2400));
  worklets[0].deliver({type: 'done', limit: false});
  await session.finish();
  const context = contexts[0];
  const pcm = Buffer.from(chunk(2400).pcm).toString('base64');
  session.play(pcm);
  session.play(pcm);
  const [first, second] = context.sources;
  assert.ok(Math.abs(second.at - first.at - 0.1) < 0.00001);
  assert.equal(first.buffer.getChannelData(0)[0], -0.75);
  context.currentTime = first.at + 0.08;
  context.getOutputTimestamp = () => ({contextTime: first.at + 0.05});
  const heard = session.stopPlayback();
  assert.ok(heard >= 49 && heard <= 50);
  assert.ok(first.stopped && second.stopped);
  context.currentTime += 3;
  session.play(pcm);
  assert.equal(context.sources.length, 2);
  assert.equal(session.stopPlayback(), heard);
  await session.waitForPlayback();
});

test('large output backlog fails bounded; fully played responses drain without closing the context', async t => {
  const {contexts, worklets} = browser(t);
  const start = async () => {
    const session = await openRealtimeAudio({maxSeconds: 2});
    t.after(() => session.close());
    worklets.at(-1).deliver(chunk(2400));
    worklets.at(-1).deliver({type: 'done', limit: false});
    await session.finish();
    return session;
  };
  const session = await start();
  assert.throws(() => session.play('xxxx='), /音声データ/);
  const one = Buffer.alloc(4800).toString('base64');
  session.play(one);
  contexts[0].currentTime = 2;
  await session.waitForPlayback();
  assert.equal(contexts[0].state, 'running');
  assert.equal(session.stopPlayback(), 100);
  session.close();
  const repeated = await start();
  const large = Buffer.alloc(48000 * 8).toString('base64');
  for (let index = 0; index < 3; index++) repeated.play(large);
  assert.throws(() => repeated.play(large), /再生待ち/);
  assert.equal(contexts[1].sources.length, 3);
});

test('worklet emits mono signed little-endian samples, mute output, and exact sample limit', async t => {
  const messages = [];
  let processor;
  const replacements = {
    AudioWorkletProcessor: class { port = {postMessage: data => messages.push(data)}; },
    registerProcessor(name, type) { assert.equal(name, 'hq-realtime-capture'); processor = type; },
  };
  for (const [key, value] of Object.entries(replacements)) {
    globalThis[key] = value;
    t.after(() => delete globalThis[key]);
  }
  await import('../public/realtime-capture-worklet.mjs');
  const capture = new processor({processorOptions: {maxSamples: 4}});
  const output = [new Float32Array([0.8, 0.8, 0.8, 0.8, 0.8])];
  capture.process([[new Float32Array([-1, 1, 0.5, -0.5, 0.25])]], [output]);
  assert.deepEqual([...output[0]], [0, 0, 0, 0, 0]);
  assert.equal(messages[0].activeSamples, 4);
  const data = new DataView(messages[0].pcm);
  assert.deepEqual([0, 2, 4, 6].map(offset => data.getInt16(offset, true)), [-32768, 32767, 16384, -16384]);
  assert.deepEqual(messages[1], {type: 'done', limit: true});
});
