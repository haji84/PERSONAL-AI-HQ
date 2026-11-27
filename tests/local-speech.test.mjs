import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {localSpeechAvailable, localSpeechMaxChars, synthesizeLocalSpeech} from '../app/local-speech.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hq-speech-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('speech rejects bad grammar or an already aborted request without leaving input on disk', async t => {
  const runtime = await fixture(t);
  assert.equal(localSpeechMaxChars, 2000);
  for (const text of [null, '', ' \n', 'a'.repeat(2001), '不正\0文字', '\ud800', '[[slnc 999999]]秘密の文']) {
    await assert.rejects(synthesizeLocalSpeech(runtime, text), error => error.code === 'LOCAL_SPEECH_TEXT_INVALID' &&
      error.status === 400 && !error.message.includes('秘密の文') && error.cause === undefined);
  }
  await assert.rejects(synthesizeLocalSpeech(runtime, '処理しない入力', {signal: AbortSignal.abort('private reason')}), error =>
    error.code === 'LOCAL_SPEECH_ABORTED' && error.status === 499 && !error.message.includes('private reason'));
  assert.deepEqual(await readdir(runtime), []);
});

test('Kyoko produces real 16 kHz PCM WAV without playback and cleans its temporary workspace', async t => {
  const available = await localSpeechAvailable();
  assert.equal(typeof available, 'boolean');
  if (!available) return t.skip('Mac or installed Japanese Kyoko voice unavailable');
  const runtime = await fixture(t);
  const wave = await synthesizeLocalSpeech(runtime, 'こんにちは。\r\nこれは日本語の音声テストです。');
  assert.ok(Buffer.isBuffer(wave));
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
  const format = wave.indexOf('fmt ', 12);
  const data = wave.indexOf('data', format + 24);
  assert.equal(wave.readUInt16LE(format + 8), 1);
  assert.equal(wave.readUInt32LE(format + 12), 16000);
  assert.equal(wave.readUInt16LE(format + 22), 16);
  assert.ok(wave.readUInt32LE(data + 4) >= 16000);
  assert.ok(wave.subarray(data + 8).some(byte => byte !== 0));
  assert.deepEqual(await readdir(runtime), []);
});

test('speech fails closed for a symlink or shared runtime directory', async t => {
  if (!await localSpeechAvailable()) return t.skip('Mac or installed Japanese Kyoko voice unavailable');
  const directory = await fixture(t);
  const target = join(directory, 'target');
  const shared = join(directory, 'shared');
  const withAcl = join(directory, 'shared-acl');
  const link = join(directory, 'link');
  await mkdir(target, {mode: 0o700});
  await mkdir(shared, {mode: 0o700});
  await mkdir(withAcl, {mode: 0o700});
  await chmod(shared, 0o755);
  await promisify(execFile)('/bin/chmod', ['+a', 'everyone allow list,search', withAcl]);
  await symlink(target, link);
  for (const runtime of [shared, withAcl, link]) {
    await assert.rejects(synthesizeLocalSpeech(runtime, '作業先の検証'), {code: 'LOCAL_SPEECH_UNAVAILABLE', status: 503});
    assert.deepEqual(await readdir(runtime), []);
  }
});

test('cancelling active synthesis removes the temporary workspace and hides abort details', async t => {
  if (!await localSpeechAvailable()) return t.skip('Mac or installed Japanese Kyoko voice unavailable');
  const runtime = await fixture(t);
  const controller = new AbortController();
  const request = synthesizeLocalSpeech(runtime, '音声。'.repeat(660), {signal: controller.signal});
  const assertion = assert.rejects(request, error => error.code === 'LOCAL_SPEECH_ABORTED' && error.status === 499 &&
    !error.message.includes('private reason') && error.cause === undefined);
  try {
    for (let count = 0; count < 1000; count++) {
      const [working] = await readdir(runtime);
      const files = working ? await readdir(join(runtime, working)) : [];
      assert.ok(files.every(name => ['voice.aiff', 'voice.wav'].includes(name)));
      if (files.includes('voice.aiff')) {
        controller.abort('private reason');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(controller.signal.aborted, true, 'the temporary AIFF must exist while cancelling');
  } finally {
    controller.abort('private reason');
    await assertion;
  }
  assert.deepEqual(await readdir(runtime), []);
});
