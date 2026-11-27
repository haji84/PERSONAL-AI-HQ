const sampleRate = 24000;
const bytesPerSecond = sampleRate * 2;
const maxFrameBytes = 8 * bytesPerSecond;
const maxQueuedSeconds = 30;
const maxOutputSamples = 120 * sampleRate;
const soundErrors = {
  NotAllowedError: 'ブラウザーでマイクを許可してください。',
  NotFoundError: '使用できるマイクが見つかりませんでした。',
  NotReadableError: 'マイクを使っているアプリを確認してください。',
};
const audioError = message => Object.assign(new Error(message), {name: 'RealtimeAudioError'});

let active;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return {promise, resolve, reject};
}

function stopTracks(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export async function openRealtimeAudio({maxSeconds, signal, onLimit} = {}) {
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 60) throw audioError('録音時間を確認してください。');
  if (signal?.aborted) throw audioError('音声会話を終了しました。');
  if (active) throw audioError('音声会話は使用中です。');
  const browser = globalThis;
  const devices = browser.navigator?.mediaDevices;
  const Context = browser.AudioContext ?? browser.webkitAudioContext;
  if (!browser.isSecureContext || typeof devices?.getUserMedia !== 'function' ||
      typeof Context !== 'function' || typeof browser.AudioWorkletNode !== 'function') {
    throw audioError('このブラウザーでは音声会話を開始できません。');
  }
  if (browser.navigator.userActivation?.isActive === false) throw audioError('音声会話の開始ボタンを押してください。');

  const lease = {};
  active = lease;
  const opening = deferred();
  const captured = deferred();
  let context;
  let stream;
  let source;
  let worklet;
  let recording = new Uint8Array(maxSeconds * bytesPerSecond);
  let written = 0;
  let activeSamples = 0;
  let captureComplete = false;
  let captureValid = false;
  let requestedFinish = false;
  let hitLimit = false;
  let closed = false;
  let captureTimer;
  let flushTimer;
  let openTimer;
  const scheduled = new Set();
  const timeline = [];
  let playUntil = 0;
  let acceptedSamples = 0;
  let stoppedMs;
  let drain;

  function releaseMicrophone() {
    source?.disconnect();
    source = undefined;
    stopTracks(stream);
    stream = undefined;
  }

  function settleCapture(problem, limit = false) {
    if (captureComplete) return;
    captureComplete = true;
    clearTimeout(captureTimer);
    clearTimeout(flushTimer);
    releaseMicrophone();
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.onprocessorerror = null;
      worklet.port.close();
      worklet.disconnect();
      worklet = undefined;
    }
    if (problem) captured.reject(problem);
    else if (written < bytesPerSecond / 10 || activeSamples < 24) captured.reject(audioError('録音した音声を確認してください。'));
    else {
      captureValid = true;
      captured.resolve(recording.slice(0, written));
    }
    recording = undefined;
    if (!closed && (limit || hitLimit)) {
      try { onLimit?.(); } catch { /* A UI callback cannot retain capture resources. */ }
    }
  }

  function receiveCapture(event) {
    if (captureComplete) return;
    const data = event.data;
    if (data?.type === 'done') {
      settleCapture(null, data.limit === true);
      return;
    }
    if (data?.type !== 'chunk' || !(data.pcm instanceof ArrayBuffer) || !data.pcm.byteLength ||
        data.pcm.byteLength % 2 || written + data.pcm.byteLength > recording.byteLength ||
        !Number.isSafeInteger(data.activeSamples) || data.activeSamples < 0 || data.activeSamples * 2 > data.pcm.byteLength) {
      settleCapture(audioError('録音データを確認できませんでした。'));
      return;
    }
    recording.set(new Uint8Array(data.pcm), written);
    written += data.pcm.byteLength;
    activeSamples += data.activeSamples;
  }

  function finishCapture(limit = false) {
    hitLimit ||= limit;
    if (!captureComplete && !requestedFinish) {
      requestedFinish = true;
      clearTimeout(captureTimer);
      releaseMicrophone();
      flushTimer = setTimeout(() => settleCapture(audioError('録音を終了できませんでした。')), 600);
      try { worklet.port.postMessage('finish'); }
      catch { settleCapture(audioError('録音を終了できませんでした。')); }
    }
    return captured.promise;
  }

  function heardClock() {
    const now = context?.currentTime ?? 0;
    try {
      const time = context?.getOutputTimestamp?.()?.contextTime;
      if (Number.isFinite(time) && time >= 0 && time <= now) return time;
    } catch { /* Some browsers expose the method without an available device clock. */ }
    const latency = [context?.baseLatency, context?.outputLatency]
      .reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
    return Math.max(0, now - latency);
  }

  function settleDrain(problem) {
    if (!drain) return;
    clearTimeout(drain.timer);
    if (problem) drain.reject(problem);
    else drain.resolve();
  }

  function stopPlayback() {
    if (stoppedMs !== undefined) return stoppedMs;
    const time = heardClock();
    const heardSamples = timeline.reduce((sum, segment) => sum + (time >= segment.end ? segment.samples :
      Math.min(segment.samples, Math.max(0, Math.floor((time - segment.start) * sampleRate)))), 0);
    stoppedMs = Math.floor(Math.min(acceptedSamples, heardSamples) * 1000 / sampleRate);
    for (const node of scheduled) {
      node.onended = null;
      try { node.stop(); } catch { /* The last output may already have ended. */ }
      node.disconnect();
    }
    scheduled.clear();
    settleDrain();
    return stoppedMs;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (active === lease) active = undefined;
    signal?.removeEventListener('abort', close);
    clearTimeout(openTimer);
    const reason = audioError('音声会話を終了しました。');
    opening.reject(reason);
    settleCapture(reason);
    stopPlayback();
    if (context) void context.close().catch(() => {});
  }

  function play(pcmBase64) {
    if (closed || stoppedMs !== undefined) return;
    if (!captureValid || context.state !== 'running') throw audioError('ブラウザーの音声再生を確認してください。');
    let bytes;
    try {
      if (typeof pcmBase64 !== 'string' || !pcmBase64.length || pcmBase64.length > 4 * Math.ceil(maxFrameBytes / 3) ||
          pcmBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(pcmBase64)) throw new Error();
      bytes = atob(pcmBase64);
      if (btoa(bytes) !== pcmBase64 || bytes.length % 2 || bytes.length > maxFrameBytes) throw new Error();
    } catch { throw audioError('受信した音声データを確認できませんでした。'); }
    const samples = bytes.length / 2;
    const now = context.currentTime;
    const start = playUntil > now ? playUntil : now + 0.015;
    const end = start + samples / sampleRate;
    if (end - now > maxQueuedSeconds || samples + acceptedSamples > maxOutputSamples ||
        scheduled.size >= 2048 || timeline.length >= 2048) throw audioError('音声の再生待ちが上限に達しました。');
    const buffer = context.createBuffer(1, samples, sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < samples; index++) {
      const sample = bytes.charCodeAt(index * 2) | (bytes.charCodeAt(index * 2 + 1) << 8);
      data[index] = ((sample << 16) >> 16) / 32768;
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    try { node.start(start); }
    catch { node.disconnect(); throw audioError('ブラウザーの音声再生を確認してください。'); }
    node.onended = () => { scheduled.delete(node); node.disconnect(); };
    scheduled.add(node);
    const previous = timeline.at(-1);
    if (previous?.end === start) { previous.end = end; previous.samples += samples; }
    else timeline.push({start, end, samples});
    playUntil = end;
    acceptedSamples += samples;
  }

  // The caller invokes this after the final network event, when no new frames will be queued.
  function waitForPlayback() {
    if (closed || stoppedMs !== undefined || !timeline.length) return Promise.resolve();
    if (drain) return drain.promise;
    drain = deferred();
    const deadline = performance.now() + (maxQueuedSeconds + 2) * 1000;
    const poll = () => {
      const remaining = playUntil - heardClock();
      if (remaining <= 0) settleDrain();
      else if (performance.now() >= deadline) {
        settleDrain(audioError('音声の再生を完了できませんでした。'));
        stopPlayback();
      } else drain.timer = setTimeout(poll, Math.max(4, Math.min(100, remaining * 1000)));
    };
    poll();
    return drain.promise;
  }

  signal?.addEventListener('abort', close, {once: true});
  try {
    if (signal?.aborted) throw audioError('音声会話を終了しました。');
    try { context = new Context({sampleRate}); }
    catch { throw audioError('24 kHzの音声を利用できません。'); }
    if (context.sampleRate !== sampleRate) throw audioError('24 kHzの音声を利用できません。');
    if (typeof context.audioWorklet?.addModule !== 'function') throw audioError('このブラウザーでは音声会話を開始できません。');
    const resume = context.resume();
    void resume.catch(() => {});
    const getStream = devices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true,
      autoGainControl: true}, video: false}).then(granted => {
      if (closed) { stopTracks(granted); throw audioError('音声会話を終了しました。'); }
      stream = granted;
    });
    const workletReady = Promise.resolve().then(() => context.audioWorklet.addModule('/realtime-capture-worklet.mjs'));
    openTimer = setTimeout(() => opening.reject(audioError('マイクの開始を確認できませんでした。')), 15000);
    await Promise.race([Promise.all([resume, getStream, workletReady]), opening.promise]);
    clearTimeout(openTimer);
    if (closed || context.state !== 'running') throw audioError('マイクの開始を確認できませんでした。');
    worklet = new browser.AudioWorkletNode(context, 'hq-realtime-capture', {numberOfInputs: 1, numberOfOutputs: 1,
      outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: {maxSamples: sampleRate * maxSeconds}});
    worklet.port.onmessage = receiveCapture;
    worklet.onprocessorerror = () => settleCapture(audioError('録音処理を続けられませんでした。'));
    source = context.createMediaStreamSource(stream);
    worklet.connect(context.destination);
    source.connect(worklet);
    captureTimer = setTimeout(() => finishCapture(true), maxSeconds * 1000);
    return {finish: () => finishCapture(), play, stopPlayback, waitForPlayback, close};
  } catch (cause) {
    close();
    throw cause?.name === 'RealtimeAudioError' ? cause : audioError(soundErrors[cause?.name] ?? 'マイクを開始できませんでした。');
  }
}
