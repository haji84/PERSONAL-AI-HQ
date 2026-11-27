import {execFile, spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access, lstat, mkdtemp, open, realpath, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

export const localSpeechMaxChars = 2000;
const maxInputBytes = 6000;
const maxAiffBytes = 32 * 1024 ** 2;
const maxWaveBytes = 8 * 1024 ** 2;
const timeoutMs = 24000;
const voiceCheckTtlMs = 60000;
const sandbox = '/usr/bin/sandbox-exec';
const say = '/usr/bin/say';
const afconvert = '/usr/bin/afconvert';
const ls = '/bin/ls';
const sandboxArgs = ['-p', '(version 1) (allow default) (deny network*)'];
const voice = 'Kyoko';
const environment = {PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8'};
const execute = promisify(execFile);
const messages = {
  TEXT_INVALID: [400, '読み上げには2,000文字以内のプレーンテキストを指定してください。'],
  UNAVAILABLE: [503, 'この端末で安全に日本語の音声を生成できる状態を確認できません。'],
  ABORTED: [499, '音声の生成を中断しました。'],
  TIMEOUT: [504, '音声を生成する時間の上限に達しました。'],
  FAILED: [502, '音声を生成できませんでした。'],
};
const problem = kind => Object.assign(new Error(messages[kind][1]), {status: messages[kind][0], code: `LOCAL_SPEECH_${kind}`});

let lastVoiceCheck;

async function checkVoice() {
  try {
    await Promise.all([sandbox, say, afconvert, ls].map(command => access(command, constants.X_OK)));
    const {stdout} = await execute(sandbox, [...sandboxArgs, say, '-v', '?'], {
      env: environment, encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    });
    return /^Kyoko\s+ja_JP\s+#/m.test(stdout);
  } catch { return false; }
}

export async function localSpeechAvailable() {
  if (process.platform !== 'darwin') return false;
  if (!lastVoiceCheck || Date.now() >= lastVoiceCheck.expiresAt) {
    lastVoiceCheck = {expiresAt: Date.now() + voiceCheckTtlMs, result: checkVoice()};
  }
  return lastVoiceCheck.result;
}

async function privateRuntime(input) {
  try {
    const path = resolve(input);
    const [stat, target] = await Promise.all([lstat(path), realpath(path)]);
    if (target !== path || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw problem('UNAVAILABLE');
    const {stdout} = await execute(ls, ['-Plde', path], {
      env: environment, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 8192,
    });
    if (!stdout || stdout.trimEnd().includes('\n')) throw problem('UNAVAILABLE');
    return path;
  } catch { throw problem('UNAVAILABLE'); }
}

function runAudio(command, args, cwd, signal, input) {
  return new Promise((resolveRun, rejectRun) => {
    if (signal.aborted) { rejectRun(problem('ABORTED')); return; }
    const child = spawn(sandbox, [...sandboxArgs, command, ...args], {
      cwd, detached: true, stdio: input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
      env: {...environment, TMPDIR: cwd},
    });
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    child.once('error', () => {});
    child.once('close', code => {
      signal.removeEventListener('abort', stop);
      if (code === 0 && !signal.aborted) resolveRun();
      else rejectRun(problem('FAILED'));
    });
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop();
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input, 'utf8');
    }
  });
}

function isPcmWave(wave) {
  if (wave.length < 44 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.readUInt32LE(4) + 8 !== wave.length ||
      wave.toString('ascii', 8, 12) !== 'WAVE') return false;
  let format = false;
  for (let offset = 12; offset + 8 <= wave.length;) {
    const type = wave.toString('ascii', offset, offset + 4);
    const size = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wave.length) return false;
    if (type === 'fmt ') {
      format = size >= 16 && wave.readUInt16LE(start) === 1 && wave.readUInt32LE(start + 4) === 16000 &&
        wave.readUInt16LE(start + 14) === 16;
    } else if (type === 'data') return format && size > 0 && size % 2 === 0;
    offset = start + size + (size % 2);
  }
  return false;
}

async function readWave(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size < 44 || stat.size > maxWaveBytes) throw problem('FAILED');
    const wave = Buffer.alloc(stat.size);
    const {bytesRead} = await file.read(wave, 0, wave.length, 0);
    if (bytesRead !== wave.length || !isPcmWave(wave)) throw problem('FAILED');
    return wave;
  } finally { await file.close(); }
}

export async function synthesizeLocalSpeech(directory, text, {signal} = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > localSpeechMaxChars || !text.isWellFormed() ||
      Buffer.byteLength(text, 'utf8') > maxInputBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text) || text.includes('[[')) {
    throw problem('TEXT_INVALID');
  }
  if (signal?.aborted) throw problem('ABORTED');
  if (!await localSpeechAvailable()) throw problem(signal?.aborted ? 'ABORTED' : 'UNAVAILABLE');
  const runtime = await privateRuntime(directory);
  if (signal?.aborted) throw problem('ABORTED');
  const timeout = AbortSignal.timeout(timeoutMs);
  const stopSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let temporary;
  let output;
  try {
    temporary = await mkdtemp(join(runtime, '.speech-'));
    const aiff = join(temporary, 'voice.aiff');
    const wav = join(temporary, 'voice.wav');
    await runAudio(say, ['-v', voice, '-o', aiff], temporary, stopSignal, text);
    const intermediate = await lstat(aiff);
    if (!intermediate.isFile() || intermediate.size === 0 || intermediate.size > maxAiffBytes) throw problem('FAILED');
    await runAudio(afconvert, ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, wav], temporary, stopSignal);
    output = await readWave(wav);
  } catch { throw problem(signal?.aborted ? 'ABORTED' : timeout.aborted ? 'TIMEOUT' : 'FAILED'); }
  finally {
    if (temporary) {
      try { await rm(temporary, {recursive: true, force: true}); }
      catch { throw problem('FAILED'); }
    }
  }
  if (signal?.aborted) throw problem('ABORTED');
  if (timeout.aborted) throw problem('TIMEOUT');
  return output;
}
