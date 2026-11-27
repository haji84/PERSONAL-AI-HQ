const language = 'ja-JP';
const localOptions = {langs: [language], processLocally: true};
const labels = {
  available: '音声入力',
  downloadable: '日本語音声認識を準備',
  downloading: '準備状況を確認',
};
const errorMessages = {
  'not-allowed': 'ブラウザーでマイクを許可してください。',
  'service-not-allowed': '端末内の音声認識を利用できません。',
  'language-not-supported': '日本語音声認識を準備してください。',
  'audio-capture': '使えるマイクを確認してください。',
  'no-speech': '音声を聞き取れませんでした。',
};
let active;
let preparation;

export function abortLocalDictation(draft) {
  if (!active || (draft && active.draft !== draft)) return;
  const capture = active;
  capture.finish('音声入力を終了しました。');
  try { capture.recognition.abort(); } catch { /* Already inactive. */ }
}

export function createLocalDictation(draft, {beforeStart} = {}) {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!window.isSecureContext || !Recognition || typeof Recognition.available !== 'function' ||
      !('processLocally' in Recognition.prototype)) return null;
  const controls = document.createElement('div');
  const toggle = document.createElement('button');
  const status = document.createElement('span');
  controls.className = 'speech-control';
  controls.hidden = true;
  toggle.className = 'button secondary';
  toggle.type = 'button';
  status.className = 'small muted';
  status.setAttribute('role', 'status');
  controls.append(toggle, status);
  let available;

  async function check() {
    try { available = await Recognition.available(localOptions); }
    catch { available = 'unavailable'; }
    controls.hidden = !Object.hasOwn(labels, available) ||
      (available === 'downloadable' && typeof Recognition.install !== 'function');
    if (!controls.hidden) toggle.textContent = labels[available];
  }
  function start() {
    if (!draft.isConnected || document.hidden || draft.disabled || draft.readOnly) return;
    abortLocalDictation();
    beforeStart?.();
    const recognition = new Recognition();
    recognition.lang = language;
    recognition.processLocally = true;
    if (recognition.processLocally !== true) {
      status.textContent = '端末内の音声認識を利用できません。';
      return;
    }
    let lastFinal = -1;
    let resultStatus = '';
    const capture = {draft, recognition, finish(message) {
      if (active !== capture) return;
      active = undefined;
      toggle.disabled = false;
      toggle.textContent = labels[available];
      status.textContent = message;
    }};
    recognition.onresult = event => {
      if (active !== capture || !draft.isConnected || draft.disabled || draft.readOnly || document.hidden) return;
      const parts = [];
      for (let i = Math.max(event.resultIndex, lastFinal + 1); i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        lastFinal = i;
        const spoken = result[0]?.transcript?.trim();
        if (spoken) parts.push(spoken);
      }
      if (!parts.length) return;
      const separator = draft.value && !/\s$/u.test(draft.value) ? '\n' : '';
      const next = draft.value + separator + parts.join(' ');
      if (draft.maxLength >= 0 && next.length > draft.maxLength) {
        resultStatus = '下書きの文字数が上限に達しました。';
      } else {
        draft.value = next;
        draft.dispatchEvent(new Event('input', {bubbles: true}));
        resultStatus = '下書きに追加しました。';
      }
      status.textContent = resultStatus;
    };
    recognition.onerror = event => {
      capture.finish(errorMessages[event.error] ?? '音声入力を確認できませんでした。');
      if (event.error === 'language-not-supported' || event.error === 'service-not-allowed') void check();
    };
    recognition.onend = () => capture.finish(resultStatus || '音声入力を終了しました。');
    active = capture;
    toggle.textContent = '音声入力を停止';
    status.textContent = 'ブラウザーのマイクを使用します。';
    try { recognition.start(); }
    catch { capture.finish('音声入力を開始できませんでした。'); }
  }
  toggle.addEventListener('click', async () => {
    if (toggle.disabled) return;
    if (active?.draft === draft) {
      toggle.disabled = true;
      try { active.recognition.stop(); }
      catch { abortLocalDictation(draft); }
      return;
    }
    if (available === 'available') { start(); return; }
    if (!['downloadable', 'downloading'].includes(available)) return;
    toggle.disabled = true;
    status.textContent = '端末内の日本語音声認識を確認しています。';
    try {
      if (available === 'downloadable') {
        preparation ??= Promise.resolve(Recognition.install(localOptions)).finally(() => { preparation = undefined; });
        await preparation;
      }
      await check();
      status.textContent = available === 'available' ? '音声入力を使えます。'
        : available === 'downloading' ? '日本語音声認識を準備しています。' : '日本語音声認識の準備を確認できませんでした。';
    } catch { status.textContent = '日本語音声認識の準備を確認できませんでした。'; }
    finally { toggle.disabled = false; }
  });
  void check();
  return controls;
}
