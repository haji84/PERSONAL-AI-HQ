import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import test from 'node:test';
import {createCodexCamera} from '../public/codex-camera.mjs';

class Element extends EventTarget {
  constructor(tag, owner) {
    super();
    this.tag = tag;
    this.owner = owner;
    this.children = [];
    this.isConnected = true;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
  }

  append(...children) { this.children.push(...children); }
  setAttribute() {}
  focus() { this.owner.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  async play() {}
}

function browser(t, {secure = true, supported = true, encode, request, onActiveChange, onCapture} = {}) {
  const document = new EventTarget();
  const window = new EventTarget();
  const requests = [];
  const canvases = [];
  const videos = [];
  const streams = [];
  const captures = [];
  document.hidden = false;
  window.isSecureContext = secure;
  window.navigator = {mediaDevices: supported ? {async getUserMedia(options) {
    requests.push(options);
    if (request) return request();
    return makeStream();
  }} : {}};
  document.createElement = tag => {
    const element = new Element(tag, document);
    if (tag === 'video') {
      element.readyState = 0;
      element.videoWidth = 0;
      element.videoHeight = 0;
      videos.push(element);
    }
    if (tag === 'canvas') {
      element.getContext = () => ({drawImage() {}});
      element.toBlob = (callback, type) => callback(encode?.(element, type) ?? new Blob(['jpeg'], {type}));
      canvases.push(element);
    }
    return element;
  };
  function makeStream() {
    const track = new EventTarget();
    track.stopCalls = 0;
    track.stop = () => { track.stopCalls++; };
    const stream = {track, getTracks: () => [track], getVideoTracks: () => [track]};
    streams.push(stream);
    return stream;
  }
  for (const [name, value] of Object.entries({document, window})) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, value});
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  function control() {
    const camera = createCodexCamera({maxBytes: 512 * 1024, onActiveChange, onCapture(file) {
      captures.push(file);
      onCapture?.(file);
    }});
    if (!camera) return camera;
    t.after(() => camera.dispose());
    const elements = element => [element, ...element.children.flatMap(elements)];
    const button = label => elements(camera.root).find(element => element.tag === 'button' && element.textContent === label);
    return Object.assign(camera, {open: button('カメラを開く'), take: button('撮影して添付'), cancel: button('閉じる')});
  }
  function showFrame(video = videos.at(-1)) {
    Object.assign(video, {readyState: 2, videoWidth: 2560, videoHeight: 1440});
    video.dispatchEvent(new Event('loadeddata'));
  }
  return {control, videos, requests, streams, canvases, captures, showFrame, makeStream, document, window};
}

test('camera controls require secure camera capability and explicit user action', async t => {
  for (const options of [{secure: false}, {supported: false}]) {
    await t.test(JSON.stringify(options), current => {
      const {control, requests} = browser(current, options);
      assert.equal(control(), null);
      assert.deepEqual(requests, []);
    });
  }
});

test('an explicit capture makes one bounded JPEG and releases the preview immediately', async t => {
  let encodes = 0;
  const fixture = browser(t, {encode(_canvas, type) {
    const bytes = encodes++ < 3 ? 512 * 1024 + 1 : 80;
    return new Blob([new Uint8Array(bytes)], {type});
  }});
  const camera = fixture.control();
  assert.equal(camera.root.hidden, true);
  assert.equal(camera.active, false);
  camera.open.click();
  camera.setAvailable(true);
  assert.equal(camera.root.hidden, false);
  assert.equal(fixture.requests.length, 0);
  camera.open.click();
  camera.open.click();
  assert.equal(camera.active, true);
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].audio, false);
  assert.equal(fixture.requests[0].video.facingMode.ideal, 'environment');
  const [video] = fixture.videos;
  assert.equal(video.playsInline, true);
  assert.equal(video.muted, true);
  camera.take.click();
  assert.equal(fixture.captures.length, 0);
  fixture.showFrame(video);
  camera.take.click();
  camera.take.click();
  assert.equal(fixture.streams[0].track.stopCalls, 1);
  await settle();
  assert.equal(video.srcObject, null);
  assert.equal(camera.active, false);
  assert.equal(fixture.captures.length, 1);
  const [photo] = fixture.captures;
  assert.equal(photo.type, 'image/jpeg');
  assert.match(photo.name, /\.jpg$/);
  assert.equal(photo.size, 80);
  const bounds = fixture.canvases.map(canvas => [canvas.width, canvas.height]);
  assert.ok(bounds.every(([width, height]) => width <= 1280 && height <= 1280));
  assert.ok(bounds.at(-1)[0] < bounds[0][0]);
});

test('active changes notify once after rendering, before requesting permission or handing over the photo', async t => {
  const notifications = [];
  const fixture = browser(t, {
    onActiveChange(value) { notifications.push([value, camera.open.hidden, fixture.requests.length]); },
    onCapture() { notifications.push('photo'); },
  });
  const camera = fixture.control();
  camera.setAvailable(true);
  camera.close();
  assert.deepEqual(notifications, []);
  camera.open.click();
  await settle();
  fixture.showFrame();
  camera.take.click();
  await settle();
  camera.close();
  camera.dispose();
  assert.deepEqual(notifications, [[true, true, 0], [false, false, 1], 'photo']);
});

test('a late permission result after disabling is stopped and never becomes a preview', async t => {
  const permission = Promise.withResolvers();
  const fixture = browser(t, {request: () => permission.promise});
  const camera = fixture.control();
  camera.setAvailable(true);
  camera.open.click();
  camera.setAvailable(false);
  const stream = fixture.makeStream();
  permission.resolve(stream);
  await settle();
  assert.equal(stream.track.stopCalls, 1);
  assert.equal(fixture.videos[0].srcObject, null);
  assert.equal(camera.root.hidden, true);
  assert.deepEqual(fixture.captures, []);
});

test('closing a pending permission request cannot replace a newly opened preview', async t => {
  const previous = Promise.withResolvers();
  const next = Promise.withResolvers();
  const pending = [previous, next];
  const fixture = browser(t, {request: () => pending.shift().promise});
  const camera = fixture.control();
  camera.setAvailable(true);
  camera.open.click();
  camera.cancel.click();
  camera.open.click();
  const oldStream = fixture.makeStream();
  const currentStream = fixture.makeStream();
  next.resolve(currentStream);
  await settle();
  previous.resolve(oldStream);
  await settle();
  assert.equal(oldStream.track.stopCalls, 1);
  assert.equal(currentStream.track.stopCalls, 0);
  assert.equal(fixture.videos[0].srcObject, currentStream);
  camera.cancel.click();
  assert.equal(currentStream.track.stopCalls, 1);
  assert.equal(fixture.videos[0].srcObject, null);
});

test('leaving the page while JPEG encoding is pending discards the photo', async t => {
  const fixture = browser(t);
  const camera = fixture.control();
  const callbacks = [];
  const create = fixture.document.createElement;
  fixture.document.createElement = tag => {
    const element = create(tag);
    if (tag === 'canvas') element.toBlob = callback => callbacks.push(callback);
    return element;
  };
  camera.setAvailable(true);
  camera.open.click();
  await settle();
  fixture.showFrame();
  camera.take.click();
  assert.equal(callbacks.length, 1);
  assert.equal(fixture.streams[0].track.stopCalls, 1);
  assert.equal(camera.active, true);
  fixture.window.dispatchEvent(new Event('pagehide'));
  assert.equal(camera.active, false);
  callbacks[0](new Blob(['jpeg'], {type: 'image/jpeg'}));
  await settle();
  assert.deepEqual(fixture.captures, []);
  assert.equal(camera.open.hidden, false);
});

test('visibility changes and externally ended tracks close the preview and allow reopening', async t => {
  const fixture = browser(t);
  const camera = fixture.control();
  const second = fixture.control();
  camera.setAvailable(true);
  second.setAvailable(true);
  camera.open.click();
  await settle();
  second.open.click();
  await settle();
  assert.equal(fixture.requests.length, 1);
  const video = fixture.videos[0];
  const firstStream = fixture.streams[0];
  firstStream.track.dispatchEvent(new Event('ended'));
  assert.equal(firstStream.track.stopCalls, 1);
  assert.equal(video.srcObject, null);
  camera.open.click();
  await settle();
  assert.equal(fixture.requests.length, 2);
  fixture.document.hidden = true;
  fixture.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(fixture.streams[1].track.stopCalls, 1);
  assert.equal(video.srcObject, null);
  assert.deepEqual(fixture.captures, []);
});

test('permission denial releases the controls for a subsequent explicit attempt', async t => {
  const attempts = [];
  const fixture = browser(t, {request() {
    attempts.push(true);
    if (attempts.length === 1) throw new DOMException('not granted', 'NotAllowedError');
    return fixture.makeStream();
  }});
  const camera = fixture.control();
  camera.setAvailable(true);
  camera.open.click();
  await settle();
  assert.equal(camera.open.hidden, false);
  assert.ok(camera.root.children.some(child => child.textContent.includes('許可')));
  camera.open.click();
  await settle();
  assert.equal(attempts.length, 2);
  assert.equal(fixture.videos[0].srcObject, fixture.streams[0]);
  camera.dispose();
  assert.equal(fixture.streams[0].track.stopCalls, 1);
  assert.equal(camera.root.hidden, true);
});
