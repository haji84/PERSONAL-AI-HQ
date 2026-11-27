const maximumPhotoBytes = 512 * 1024;
const maximumFrameSide = 1280;
const videoConstraints = {
  audio: false,
  video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 960}},
};
const cameraErrors = {
  NotAllowedError: 'ブラウザーでカメラを許可してください。',
  NotFoundError: '使えるカメラが見つかりませんでした。',
  NotReadableError: 'カメラを使っているアプリを確認してください。',
};
let cameraOwner;

function frameCanvas(page, source, width, height, scale) {
  const canvas = page.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Camera frame canvas unavailable');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function encodePhoto(page, frame, maxBytes, isCurrent) {
  for (const scale of [1, 0.65]) {
    if (!isCurrent()) return null;
    const canvas = scale === 1 ? frame : frameCanvas(page, frame, frame.width, frame.height, scale);
    for (const quality of [0.88, 0.73, 0.57]) {
      if (!isCurrent()) return null;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob?.type === 'image/jpeg' && blob.size > 0 && blob.size <= maxBytes) return blob;
    }
  }
  return null;
}

export function createCodexCamera({maxBytes, onCapture, onActiveChange}) {
  const browser = window;
  const page = document;
  const mediaDevices = browser.navigator?.mediaDevices;
  if (!browser.isSecureContext || typeof mediaDevices?.getUserMedia !== 'function' ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || typeof onCapture !== 'function') return null;
  const byteLimit = Math.min(maxBytes, maximumPhotoBytes);
  const root = page.createElement('div');
  root.className = 'camera-controls';
  const actions = page.createElement('div');
  actions.className = 'run-actions';
  const preview = page.createElement('video');
  preview.className = 'camera-preview';
  preview.setAttribute('aria-label', '撮影前のプレビュー');
  preview.autoplay = true;
  preview.playsInline = true;
  preview.muted = true;
  preview.srcObject = null;
  const status = page.createElement('p');
  status.className = 'small muted';
  status.setAttribute('role', 'status');

  let available = false;
  let disposed = false;
  let active;
  const owner = {};
  const canUse = () => available && root.isConnected && !page.hidden;
  const isCurrent = flight => active === flight && canUse();
  const frameReady = () => preview.readyState >= 2 && preview.videoWidth > 0 && preview.videoHeight > 0;

  const start = makeButton('カメラを開く', openCamera);
  const take = makeButton('撮影して添付', captureFrame);
  const cancel = makeButton('閉じる', () => close());
  actions.append(start, take, cancel);
  root.append(actions, preview, status);
  paint();

  function makeButton(label, action) {
    const button = page.createElement('button');
    button.className = 'button secondary';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  function paint() {
    root.hidden = !available;
    start.hidden = Boolean(active);
    cancel.hidden = !active;
    preview.hidden = !active?.stream;
    take.hidden = !active?.stream;
    take.disabled = !active?.stream || active.encoding || !frameReady();
    status.hidden = !status.textContent;
  }

  function releaseStream(flight) {
    const stream = flight?.stream;
    if (!stream) return;
    flight.stream = null;
    preview.srcObject = null;
    for (const track of stream.getTracks()) {
      track.removeEventListener('ended', flight.ended);
      track.stop();
    }
  }

  function close(message = '') {
    const focus = page.activeElement;
    const flight = active;
    active = undefined;
    if (cameraOwner === owner) cameraOwner = undefined;
    releaseStream(flight);
    status.textContent = message;
    paint();
    if (flight) onActiveChange?.(false);
    if ((focus === take || focus === cancel) && canUse()) start.focus({preventScroll: true});
  }

  function updatePreview() {
    if (!active?.stream || active.encoding || !frameReady()) return;
    status.textContent = '画像を確認してから撮影してください。';
    paint();
  }

  async function openCamera() {
    if (!canUse() || active) return;
    if (cameraOwner) {
      status.textContent = '開いているカメラを閉じてから、もう一度お試しください。';
      paint();
      return;
    }
    const wasFocused = page.activeElement === start;
    const flight = {stream: null, encoding: false};
    flight.ended = () => {
      if (isCurrent(flight) && !flight.encoding) close('カメラの接続が終了しました。');
    };
    active = flight;
    cameraOwner = owner;
    status.textContent = 'カメラを開いています…';
    paint();
    onActiveChange?.(true);
    if (!isCurrent(flight)) return;
    if (wasFocused) cancel.focus({preventScroll: true});
    try {
      const stream = await mediaDevices.getUserMedia(videoConstraints);
      if (!isCurrent(flight)) {
        for (const track of stream.getTracks()) track.stop();
        if (active === flight) close();
        return;
      }
      flight.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener('ended', flight.ended, {once: true});
      preview.srcObject = stream;
      paint();
      await preview.play();
      if (isCurrent(flight)) updatePreview();
    } catch (cause) {
      if (active === flight) close(cameraErrors[cause?.name] ?? 'カメラを開けませんでした。');
    }
  }

  async function captureFrame() {
    const flight = active;
    if (!flight?.stream || flight.encoding || !isCurrent(flight) || !frameReady()) return;
    const wasFocused = page.activeElement === take;
    flight.encoding = true;
    try {
      const {videoWidth, videoHeight} = preview;
      const scale = Math.min(1, maximumFrameSide / Math.max(videoWidth, videoHeight));
      const frame = frameCanvas(page, preview, videoWidth, videoHeight, scale);
      releaseStream(flight);
      status.textContent = '添付する画像を作成しています…';
      paint();
      if (wasFocused) cancel.focus({preventScroll: true});
      const blob = await encodePhoto(page, frame, byteLimit, () => isCurrent(flight));
      if (!isCurrent(flight)) return;
      if (!blob) {
        close('添付できる大きさに調整できませんでした。');
        return;
      }
      const file = new File([blob], 'カメラ画像.jpg', {type: 'image/jpeg'});
      close();
      await onCapture(file);
    } catch {
      if (active === flight) close('撮影できませんでした。');
    }
  }

  preview.addEventListener('loadeddata', updatePreview);
  preview.addEventListener('canplay', updatePreview);
  preview.addEventListener('playing', updatePreview);
  function hideCamera() { if (page.hidden) close(); }
  function leavePage() { close(); }
  page.addEventListener('visibilitychange', hideCamera);
  browser.addEventListener('pagehide', leavePage);

  return {
    root,
    get active() { return Boolean(active); },
    setAvailable(value) {
      if (disposed || available === (value === true)) return;
      available = value === true;
      if (available) paint();
      else close();
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      available = false;
      page.removeEventListener('visibilitychange', hideCamera);
      browser.removeEventListener('pagehide', leavePage);
      close();
    },
  };
}
