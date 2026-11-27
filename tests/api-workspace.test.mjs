import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalApiWorkspacePath, prepareApiWorkspace, readCommittedEvidence } from '../app/api-workspace.mjs';

const macTest = process.platform === 'darwin' ? test : test.skip;
const digest = (text) => createHash('sha256').update(text).digest('hex');

test('workspace paths can be bound to a canonical local Windows drive', () => {
  const windows = path.win32;
  const local = 'C:\\Users\\Owner\\保護 Work';
  assert.equal(canonicalApiWorkspacePath(local, windows), local);
  for (const invalid of [
    '\\\\host\\share\\workspace', '\\\\?\\C:\\work', 'C:relative', 'C:/work', 'C:\\work\\..\\other',
    'C:\\work\\file:stream', 'C:\\work\\other.', 'C:\\work\\NUL.txt', 'C:\\work\\COM¹.txt', 'C:\\work\\CONIN$',
  ]) assert.throws(() => canonicalApiWorkspacePath(invalid, windows), /canonical/i, invalid);
  assert.equal(canonicalApiWorkspacePath('/Users/Owner/work', path.posix), '/Users/Owner/work');
  assert.throws(() => canonicalApiWorkspacePath('/Users/Owner/work\\other', path.posix), /canonical/i);
});

async function fixture(t, extra = '', expected = 2) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hq-api-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo');
  await mkdir(checkout);
  await mkdir(path.join(checkout, 'test'));
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  const write = (name, data) => writeFile(path.join(checkout, name), data);
  const initial = 'export const result = 1;\n';
  await write('value.mjs', initial);
  await write('test/check.test.mjs', `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { result } from '../value.mjs';
    test('checks the user-approved result', () => assert.equal(result, ${expected}));
    ${extra}
  `);
  await write('.env', 'fake=secret\n');
  await git('init', '-q');
  git('add', '--', 'value.mjs', 'test', '.env');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const options = {
    checkout, jobRoot: path.join(root, 'job'),
    files: [{ path: 'value.mjs', writable: true }],
    testPaths: ['test/check.test.mjs'],
  };
  return { root, checkout, write, options, initial, git, baseSha: git('rev-parse', 'HEAD') };
}

macTest('tests real candidate edits while preserving the original checkout', async (t) => {
  const { checkout, options, initial, baseSha } = await fixture(t);
  const job = await prepareApiWorkspace(options);
  assert.deepEqual(job.context(), { baseSha, files: [{ path: 'value.mjs', writable: true, text: initial }] });
  assert.equal((await job.verify()).passed, false);
  await assert.rejects(async () => job.finish(), /verified/i);
  const text = 'export const result = 2;\n';
  await job.apply([{ path: 'value.mjs', text }]);
  assert.equal(job.context().files[0].text, text);
  assert.equal((await job.verify()).passed, true);
  const finished = await job.finish();
  assert.equal(finished.baseSha, baseSha);
  assert.deepEqual(finished.changes, [{
    path: 'value.mjs', beforeSha256: digest(initial), sha256: digest(text), bytes: Buffer.byteLength(text),
  }]);
  assert.equal(await readFile(path.join(finished.candidatePath, 'value.mjs'), 'utf8'), text);
  assert.equal(await readFile(path.join(checkout, 'value.mjs'), 'utf8'), initial);
  assert.equal((await lstat(options.jobRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(finished.candidatePath, 'value.mjs'))).mode & 0o777, 0o600);
});

macTest('rejects unauthorized replacements, aliases, immutable tests and stale authorized sources', async (t) => {
  const { checkout, options, write, initial } = await fixture(t);
  const job = await prepareApiWorkspace(options);
  for (const target of ['test/check.test.mjs', '.env', 'VALUE.mjs', '../value.mjs', './value.mjs']) {
    await assert.rejects(async () => job.apply([{ path: 'value.mjs', text: 'changed' }, { path: target, text: 'changed' }]));
    assert.equal(job.context().files[0].text, initial);
  }
  const attempt = (files, id) => prepareApiWorkspace({ ...options, files, jobRoot: `${options.jobRoot}-${id}` });
  await assert.rejects(attempt([{ path: '.env', writable: false }], 'private'));
  await assert.rejects(attempt([{ path: 'VALUE.mjs', writable: true }], 'case'));
  const outside = path.join(checkout, '..', 'outside.mjs');
  await writeFile(outside, initial);
  await rm(path.join(checkout, 'value.mjs'));
  await symlink(outside, path.join(checkout, 'value.mjs'));
  await assert.rejects(attempt(options.files, 'symlink'));
  await rm(path.join(checkout, 'value.mjs'));
  await link(outside, path.join(checkout, 'value.mjs'));
  await assert.rejects(attempt(options.files, 'hardlink'));
  await rm(path.join(checkout, 'value.mjs'));
  await write('value.mjs', 'uncommitted edit');
  await assert.rejects(attempt(options.files, 'dirty'), /modified/i);
  assert.equal(await readFile(path.join(checkout, 'value.mjs'), 'utf8'), 'uncommitted edit');
});

macTest('isolates read, writes, environment and localhost networking', async (t) => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => listener.close());
  const extra = `
    import { readFile, writeFile } from 'node:fs/promises';
    import { connect } from 'node:net';
    import { execFileSync } from 'node:child_process';
    test('cannot access out-of-scope resources', async () => {
      const denied = { code: 'ERR_ACCESS_DENIED' };
      assert.throws(() => execFileSync('/usr/bin/true'), denied);
      await assert.rejects(readFile('../../sentinel.txt'), denied);
      await assert.rejects(writeFile('./test/check.test.mjs', 'tamper'), denied);
      await assert.rejects(writeFile('../../side-effect.txt', 'tamper'), denied);
      assert.equal(process.env.HQ_PRIVATE_DUMMY, undefined);
      const sock = connect({host:'127.0.0.1', port:${listener.address().port}});
      try {
        await assert.rejects(new Promise((resolve, reject) => {
          sock.once('connect', resolve); sock.once('error', reject);
        }), { code: 'EPERM' });
      } finally { sock.destroy(); }
    });
  `;
  const { root, options } = await fixture(t, extra, 1);
  await writeFile(path.join(root, 'sentinel.txt'), 'outside scope');
  const job = await prepareApiWorkspace(options);
  const previous = process.env.HQ_PRIVATE_DUMMY;
  process.env.HQ_PRIVATE_DUMMY = 'fixture-env-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.HQ_PRIVATE_DUMMY;
    else process.env.HQ_PRIVATE_DUMMY = previous;
  });
  const result = await job.verify();
  assert.equal(result.passed, true, result.output);
});

macTest('rejects unverified, no-test and early-exit results and protects test feedback', async (t) => {
  const { options } = await fixture(t);
  const job = await prepareApiWorkspace(options);
  await job.apply([{ path: 'value.mjs', text: "console.log('PRIVATE_TEST_FEEDBACK'); process.exit(0); export const result=2;" }]);
  const attempted = await job.verify();
  assert.equal(attempted.passed, false);
  assert.doesNotMatch(attempted.output, /PRIVATE_TEST_FEEDBACK/);
  await assert.rejects(async () => job.finish(), /verified/i);
  await assert.rejects(prepareApiWorkspace({ ...options, jobRoot: options.jobRoot + '-none', testPaths: [] }));
});

macTest('cancels running tests and rejects a pre-cancelled job', async (t) => {
  const { options } = await fixture(t);
  const job = await prepareApiWorkspace(options);
  await job.apply([{ path: 'value.mjs', text: 'await new Promise(resolve => setTimeout(resolve, 60000)); export const result=2;' }]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  t.after(() => clearTimeout(timer));
  const result = await job.verify({ signal: controller.signal });
  assert.equal(result.passed, false);
  assert.match(result.output, /cancel/i);
  await assert.rejects(prepareApiWorkspace({ ...options, signal: AbortSignal.abort() }));
});

macTest('only accepts fresh job directories below a private parent', async (t) => {
  const { root, options } = await fixture(t);
  await mkdir(options.jobRoot);
  await assert.rejects(prepareApiWorkspace(options));
  await chmod(root, 0o755);
  await assert.rejects(prepareApiWorkspace({ ...options, jobRoot: options.jobRoot + '-new' }));
});

macTest('creates only explicitly enrolled absent files in the candidate', async (t) => {
  const { checkout, options } = await fixture(t);
  options.files.push({ path: 'new.mjs', writable: true, create: true });
  const job = await prepareApiWorkspace(options);
  assert.equal(job.context().files.find(({ path }) => path === 'new.mjs').text, null);
  const text = 'export const result = 2;\n';
  await job.apply([{ path: 'value.mjs', text: "export { result } from './new.mjs';" }, { path: 'new.mjs', text }]);
  assert.equal((await job.verify()).passed, true);
  assert.deepEqual((await job.finish()).changes[1], {
    path: 'new.mjs', beforeSha256: null, sha256: digest(text), bytes: Buffer.byteLength(text),
  });
  await assert.rejects(lstat(path.join(checkout, 'new.mjs')), { code: 'ENOENT' });
});

macTest('bounds test output and rejects artifact changes after verification', async (t) => {
  const { options } = await fixture(t);
  const job = await prepareApiWorkspace(options);
  await job.apply([{ path: 'value.mjs', text: "console.log('x'.repeat(131072)); export const result = 2;" }]);
  const noisy = await job.verify();
  assert.equal(noisy.passed, false);
  assert.ok(noisy.output.length < 4096);
  assert.doesNotMatch(noisy.output, /x{20}/);
  await job.apply([{ path: 'value.mjs', text: 'export const result = 2;' }]);
  assert.equal((await job.verify()).passed, true);
  const { candidatePath } = await job.finish();
  await writeFile(path.join(candidatePath, 'unapproved.mjs'), 'export {};');
  await assert.rejects(job.finish(), /changed/i);
});

macTest('committed evidence reports exact HEAD and digests while retaining unrelated edits', async (t) => {
  const { root, checkout, write, initial, baseSha } = await fixture(t);
  const enrolledTest = 'test/check.test.mjs';
  const testBytes = await readFile(path.join(checkout, enrolledTest));
  await write('.env', 'unrelated, edited bytes');
  await write('unrelated.txt', 'untracked, edited bytes');
  const before = { root: await readdir(root), checkout: await readdir(checkout) };
  assert.deepEqual(await readCommittedEvidence({ checkout, paths: [enrolledTest, 'value.mjs'] }), {
    head: baseSha,
    files: [{ path: enrolledTest, sha256: digest(testBytes) }, { path: 'value.mjs', sha256: digest(initial) }],
  });
  assert.deepEqual({ root: await readdir(root), checkout: await readdir(checkout) }, before);
  assert.equal(await readFile(path.join(checkout, 'value.mjs'), 'utf8'), initial);
  assert.equal(await readFile(path.join(checkout, '.env'), 'utf8'), 'unrelated, edited bytes');
  assert.equal(await readFile(path.join(checkout, 'unrelated.txt'), 'utf8'), 'untracked, edited bytes');
});

macTest('committed evidence rejects dirty tracked files, aliases, incomplete scope, and cancellation', async (t) => {
  const { checkout, write, initial } = await fixture(t);
  const check = (paths, extras = {}) => readCommittedEvidence({ checkout, paths, ...extras });
  await write('untracked.mjs', initial);
  for (const paths of [
    [], ['value.mjs', 'value.mjs'], ['value.mjs', 'VALUE.mjs'], ['VALUE.mjs'],
    ['untracked.mjs'], ['.env'], ['../outside.mjs'], Array.from({ length: 25 }, (_, i) => `file-${i}.mjs`),
  ]) await assert.rejects(check(paths));
  await assert.rejects(check(['check.test.mjs'], { checkout: path.join(checkout, 'test') }), /worktree root/i);
  await assert.rejects(check(['value.mjs'], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await write('value.mjs', 'dirty working tree');
  await assert.rejects(check(['value.mjs']), /modified/i);
  assert.equal(await readFile(path.join(checkout, 'value.mjs'), 'utf8'), 'dirty working tree');
  await rm(path.join(checkout, 'value.mjs'));
  await symlink('untracked.mjs', path.join(checkout, 'value.mjs'));
  await assert.rejects(check(['value.mjs']), /regular unaliased/i);
  assert.equal((await lstat(path.join(checkout, 'value.mjs'))).isSymbolicLink(), true);
});

macTest('committed evidence rejects HEAD movement before returning digests', async (t) => {
  const { checkout, git, baseSha } = await fixture(t);
  let checkpoints = 0;
  const signal = {
    throwIfAborted() {
      // Move the actual Git ref at the final cooperative checkpoint, without racing a timer.
      if (++checkpoints === 3) {
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'concurrent HEAD');
      }
    },
  };
  await assert.rejects(readCommittedEvidence({ checkout, paths: ['value.mjs'], signal }), /HEAD changed/i);
  assert.notEqual(git('rev-parse', 'HEAD'), baseSha);
});
