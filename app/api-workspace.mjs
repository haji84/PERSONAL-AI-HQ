import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertWindowsPrivateWorkspace, isOrdinaryWindowsPathComponent } from './private-directory.mjs';

const SANDBOX = '/usr/bin/sandbox-exec';
const MAX_FILES = 24;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_WORKSPACE_BYTES = 384 * 1024;
const MAX_REVISIONS = 8;
const VERIFY_TIMEOUT_MS = 15_000;
const MAX_RUNNER_OUTPUT = 16 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const windows = process.platform === 'win32';
const workspaceMarker = '.hq-owned-workspace';
const execute = promisify(execFile);

function sourcePath(input) {
  if (typeof input !== 'string' || input.length > 240) throw new Error('Invalid API source path');
  const components = input.split('/');
  const reserved = /(?:^|[._-])(?:credential[s]?|secret[s]?|token[s]?|private[-_]key[s]?|id_rsa|id_ed25519)(?:[._-]|$)/i;
  if (
    !components.every((part) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part) && !reserved.test(part))
    || (windows && !components.every(isOrdinaryWindowsPathComponent))
    || /\.(?:key|pem|pfx|p12|crt|cer|sqlite[0-9]*|db|log)$/i.test(input)
  ) throw new Error('Invalid API source path');
  return input;
}

export function canonicalApiWorkspacePath(input, platformPath = path) {
  const invalid = () => new Error('API workspace paths must be absolute and canonical');
  if (typeof input !== 'string' || !platformPath.isAbsolute(input) ||
      platformPath.normalize(input) !== input || /[\x00-\x1f\x7f"]/.test(input)) throw invalid();
  if (platformPath.sep === '\\') {
    const names = input.slice(3);
    if (!/^[A-Za-z]:\\/.test(input) || (names && !names.split('\\').every(isOrdinaryWindowsPathComponent))) throw invalid();
  } else if (input.includes('\\')) {
    throw invalid();
  }
  return input;
}

async function canonicalDirectory(input) {
  const directory = canonicalApiWorkspacePath(input);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || await realpath(directory) !== directory) {
    throw new Error('API workspace directory must exist without aliases');
  }
  return stat;
}

async function missing(filename) {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function exactFile(root, relative, { allowMissing = false } = {}) {
  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    const names = await readdir(current);
    const aliases = names.filter((name) => name.toLowerCase() === part.toLowerCase());
    if (aliases.length === 0 && allowMissing && await missing(path.join(current, part))) {
      return null;
    }
    if (aliases.length !== 1 || aliases[0] !== part) throw new Error('API source entry is missing or aliased');
    current = path.join(current, part);
    const stat = await lstat(current);
    if (index < parts.length - 1 && stat.isDirectory()) continue;
    if (index === parts.length - 1 && stat.isFile() && stat.nlink === 1 && await realpath(current) === current) {
      return { current, stat };
    }
    throw new Error('API source entries must be regular unaliased files');
  }
  throw new Error('Invalid API source path');
}

async function diskBytes({ current, stat }, maxBytes = MAX_FILE_BYTES) {
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const observed = await handle.stat();
    if (
      !observed.isFile() || observed.nlink !== 1 || observed.dev !== stat.dev || observed.ino !== stat.ino
      || observed.uid !== stat.uid
      || observed.size > maxBytes
    ) throw new Error('API source file changed or exceeds its size limit');
    const buffer = Buffer.alloc(Math.min(maxBytes, observed.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (after.size !== bytesRead || bytesRead > maxBytes || after.ctimeMs !== observed.ctimeMs) {
      throw new Error('API source file changed or exceeds its size limit');
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readBoundedWorkspaceFile(root, relative, maxBytes) {
  const parts = relative.split('/');
  if (relative.length > 240 || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) ||
      part === '.' || part === '..' || /\.$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid workspace evidence path');
  }
  const file = await exactFile(root, relative);
  if (file.stat.size > maxBytes) throw new Error('Workspace evidence exceeds its size limit');
  const bytes = await diskBytes(file, maxBytes);
  const [named, actual] = await Promise.all([lstat(file.current), realpath(file.current)]);
  if (!named.isFile() || named.nlink !== 1 || named.dev !== file.stat.dev || named.ino !== file.stat.ino ||
      named.ctimeMs !== file.stat.ctimeMs || actual !== file.current) {
    throw new Error('Workspace evidence changed during reading');
  }
  return bytes;
}

export function readOnlyGitInvocation(checkout, args) {
  const env = {
    PATH: windows ? process.env.PATH : '/usr/bin:/bin',
    ...(windows && process.env.SystemRoot && {SystemRoot:process.env.SystemRoot}),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  };
  return {executable:windows ? 'git' : '/usr/bin/git',
    args:['--no-replace-objects', '--literal-pathspecs', '-c', 'protocol.allow=never', '-C', checkout, ...args], env};
}

function git(checkout, args) {
  try {
    const command = readOnlyGitInvocation(checkout, args);
    return execFileSync(command.executable, command.args, {env:command.env,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_FILE_BYTES + 1024, timeout: 3000});
  } catch {
    throw new Error('Could not read the approved API source from Git');
  }
}

async function readWindowsGit(checkout, args, signal) {
  try {
    const command = readOnlyGitInvocation(checkout, args);
    const {stdout} = await execute(command.executable, command.args, {env: command.env, encoding: 'buffer',
      windowsHide: true, maxBuffer: MAX_FILE_BYTES + 1024, timeout: 3000, signal});
    return stdout;
  } catch {
    signal?.throwIfAborted();
    throw new Error('Could not read the approved API source from Git');
  }
}

function textBytes(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES || text.includes('\0')) {
    throw new Error('API source must be bounded UTF-8 text');
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_FILE_BYTES || UTF8.decode(bytes) !== text) throw new Error('API source must be bounded UTF-8 text');
  return bytes;
}

function makeEntries(files, testPaths) {
  if (
    !Array.isArray(files) || files.length === 0 || files.length > MAX_FILES
    || !Array.isArray(testPaths) || testPaths.length === 0 || testPaths.length > MAX_FILES
  ) throw new Error('Explicit API source and test paths are required');
  const entries = new Map();
  const tests = new Set(testPaths.map(sourcePath));
  if (tests.size !== testPaths.length || testPaths.some((name) => !/\.(?:test|spec)\.(?:[mc]?js|[mc]?ts)$/.test(name))) {
    throw new Error('Explicit immutable Node test files are required');
  }
  for (const file of files) {
    const name = sourcePath(file?.path);
    if (
      entries.has(name) || typeof file.writable !== 'boolean'
      || ('create' in file && typeof file.create !== 'boolean')
      || (file.create && !file.writable) || (tests.has(name) && file.writable)
    ) throw new Error('API source entries must be distinct with immutable tests');
    entries.set(name, { name, writable: file.writable, create: file.create === true, inContext: true });
  }
  for (const name of tests) {
    if (!entries.has(name)) entries.set(name, { name, writable: false, create: false, inContext: false });
  }
  if (entries.size > MAX_FILES) throw new Error('API workspace has too many sources');
  const spellings = new Map();
  for (const name of entries.keys()) {
    for (let entry = name; entry !== '.'; entry = path.dirname(entry)) {
      const alias = entry.toLowerCase();
      if (spellings.has(alias) && spellings.get(alias) !== entry) throw new Error('API workspace contains aliased paths');
      if (entry !== name && entries.has(entry)) throw new Error('API workspace has conflicting file paths');
      spellings.set(alias, entry);
    }
  }
  return entries;
}

function requireCheckoutRoot(checkout, output) {
  const root = output.toString('utf8').replace(/\r?\n$/, '');
  if ((windows ? path.normalize(root) : root) !== checkout) {
    throw new Error('API workspace checkout must be the canonical Git worktree root');
  }
}

function checkedHead(output) {
  const head = output.toString('utf8').trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('Invalid Git HEAD for API workspace');
  return head;
}

function checkoutHead(checkout) {
  requireCheckoutRoot(checkout, git(checkout, ['rev-parse', '--show-toplevel']));
  return checkedHead(git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}']));
}

async function windowsCheckoutHead(checkout, signal) {
  requireCheckoutRoot(checkout, await readWindowsGit(checkout, ['rev-parse', '--show-toplevel'], signal));
  return checkedHead(await readWindowsGit(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'], signal));
}

async function committedFile(checkout, baseSha, name, tree, { ownerUid, signal } = {}) {
  const [mode, actualPath] = tree.split('\t');
  if (!/^100(?:644|755) blob [a-f0-9]{40,64}$/.test(mode) || actualPath !== name + '\0') {
    throw new Error('API source must be a regular Git HEAD file');
  }
  const file = await exactFile(checkout, name);
  if (ownerUid !== undefined && file.stat.uid !== ownerUid) throw new Error('API evidence file must belong to the checkout owner');
  const readGit = windows ? readWindowsGit : git;
  const bytes = await readGit(checkout, ['cat-file', 'blob', `${baseSha}:${name}`], signal);
  if (!bytes.equals(await diskBytes(file))) throw new Error('Approved API source has been modified since Git HEAD');
  return bytes;
}

export async function readCommittedEvidence({ checkout, paths, signal, includeBytes = false, workspaceProject }) {
  signal?.throwIfAborted();
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) {
    throw new Error('A bounded list of committed API evidence paths is required');
  }
  const names = Array.from(paths, sourcePath);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error('Committed API evidence paths must be distinct and unaliased');
  }
  const root = await canonicalDirectory(checkout);
  const ownerUid = process.getuid?.();
  if (windows) {
    await checkWindowsEvidenceScope(checkout, names, workspaceProject, signal);
  } else if (ownerUid === undefined || root.uid !== ownerUid) {
    throw new Error('API evidence checkout must belong to the current user');
  }
  const readHead = windows ? windowsCheckoutHead : checkoutHead;
  const readGit = windows ? readWindowsGit : git;
  const head = await readHead(checkout, signal);
  const files = [];
  let size = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const tree = await readGit(checkout, ['ls-tree', '-z', head, '--', name], signal);
    const bytes = await committedFile(checkout, head, name, tree.toString('utf8'), { ownerUid, signal });
    size += bytes.length;
    if (size > MAX_WORKSPACE_BYTES) throw new Error('Committed API evidence exceeds its size limit');
    files.push({ path: name, sha256: hash(bytes), ...(includeBytes ? {bytes} : {}) });
  }
  signal?.throwIfAborted();
  if (await readHead(checkout, signal) !== head) throw new Error('API evidence Git HEAD changed during readback');
  signal?.throwIfAborted();
  return { head, files };
}

function checkedEvidenceBytes(checkout, name, ownerUid, maxBytes) {
  const filename = path.join(checkout, name);
  if (realpathSync(filename) !== filename) throw new Error('API evidence path changed');
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || (ownerUid !== undefined && before.uid !== BigInt(ownerUid)) ||
        before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new Error('API evidence file is outside its scope');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(length) !== before.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) {
      throw new Error('API evidence changed during readback');
    }
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

async function checkWindowsEvidenceScope(checkout, names, workspaceProject, signal) {
  if (typeof workspaceProject !== 'string' || !workspaceProject || workspaceProject.length > 100) {
    throw new Error('API evidence workspace requires an approved project');
  }
  await assertWindowsPrivateWorkspace(checkout, [workspaceMarker, ...names], signal);
  if (!workspaceMarkerMatches(checkout, workspaceProject)) {
    throw new Error('API evidence workspace does not match the approved project');
  }
}

const workspaceMarkerMatches = (checkout, project) =>
  checkedEvidenceBytes(checkout, workspaceMarker, undefined, 100).toString('utf8').trim() === project;
const evidenceEntries = files => Array.from(files, ({path: name, sha256}) => ({name: sourcePath(name), sha256}));
const matchingEvidence = (checkout, evidence, owner) => evidence.every(({name, sha256}) =>
  hash(checkedEvidenceBytes(checkout, name, owner, MAX_FILE_BYTES)) === sha256);

// The Git blobs were already checked. At dispatch, make sure the same revision and working bytes are still present.
export function checkedEvidenceIsCurrent({ checkout, head, files, requireClean = false }) {
  try {
    const owner = process.getuid?.();
    if (owner === undefined || realpathSync(canonicalApiWorkspacePath(checkout)) !== checkout) return false;
    if (checkoutHead(checkout) !== head || !matchingEvidence(checkout, evidenceEntries(files), owner)) return false;
    if (requireClean) {
      const index = git(checkout, ['ls-files', '-v', '-z']).toString('utf8').split('\0');
      if (index.some(entry => entry && !entry.startsWith('H '))) return false;
      const status = git(checkout, ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status',
        '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).toString('utf8');
      if (status !== '' && status !== '?? .hq-owned-workspace\0') return false;
    }
    return checkoutHead(checkout) === head;
  } catch { return false; }
}

export async function prepareArtifactEvidenceReadback({ checkout, head, files, workspaceProject, signal }) {
  if (!windows) return () => checkedEvidenceIsCurrent({checkout, head, files});
  try {
    const evidence = evidenceEntries(files);
    const names = evidence.map(({name}) => name);
    await checkWindowsEvidenceScope(checkout, names, workspaceProject, signal);
    if (await windowsCheckoutHead(checkout, signal) !== head) return null;
    // The caller checks working bytes after the last asynchronous read, even when listing several projects.
    return () => {
      try {
        return !signal?.aborted && workspaceMarkerMatches(checkout, workspaceProject) &&
          matchingEvidence(checkout, evidence);
      } catch { return false; }
    };
  } catch { return null; }
}

async function snapshot(checkout, baseSha, entries, signal) {
  let size = 0;
  for (const entry of entries.values()) {
    signal?.throwIfAborted();
    const { name, create } = entry;
    const tree = git(checkout, ['ls-tree', '-z', baseSha, '--', name]).toString('utf8');
    if (create) {
      if (tree || await exactFile(checkout, name, { allowMissing: true })) throw new Error('New API source already exists');
      entry.original = null;
      continue;
    }
    const bytes = await committedFile(checkout, baseSha, name, tree);
    entry.original = UTF8.decode(bytes);
    size += textBytes(entry.original).length;
    if (size > MAX_WORKSPACE_BYTES) throw new Error('API workspace exceeds its source size limit');
  }
}

// The trusted runner stays separate from the test file processes. Each child has
// Node's restrictive permissions in addition to the inherited macOS profile.
const RUNNER = `
import { run } from 'node:test';
const [directory, ...tests] = process.argv.slice(2);
let status = [];
for (const file of tests) {
  let summary;
  let passedTests = 0;
  let loggedBytes = 0;
  const stream = run({
    files: [file], isolation: 'process', concurrency: 1,
    execArgv: ['--permission', '--allow-fs-read=' + directory, '--disable-proto=throw'],
  });
  for await (const { type, data } of stream) {
    if (type === 'test:summary' && data.file === undefined) summary = data;
    if (type === 'test:pass' && data.file === file && data.name !== file && data.line > 0 && !data.skip && !data.todo) passedTests++;
    if (type === 'test:stdout' || type === 'test:stderr') {
      loggedBytes += Buffer.byteLength(data.message);
      if (loggedBytes > 65536) process.exit(2);
    }
  }
  const counts = summary?.counts;
  status.push({
    passed: summary?.success === true && passedTests > 0 && counts.failed === 0
      && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0,
    passedTests, failedTests: counts?.failed ?? 0,
  });
}
process.stdout.write(JSON.stringify(status));
if (status.some(result => !result.passed)) process.exitCode = 1;
`;

const READINESS_TEST = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('isolated test child can read its workspace and cannot read the outer runner', () => {
  assert.ok(readFileSync(new URL(import.meta.url)).length > 0);
  assert.throws(() => readFileSync(new URL('../run-tests.mjs', import.meta.url)), {code: 'ERR_ACCESS_DENIED'});
});
`;

function sandboxProfile(node, runner, candidate) {
  const quote = (text) => JSON.stringify(text);
  const ancestors = [];
  for (let directory = path.dirname(candidate); directory !== '/'; directory = path.dirname(directory)) {
    ancestors.push(`(literal ${quote(directory)})`);
  }
  return `(version 1)
(deny default)
(allow process-exec (literal ${quote(node)}))
(allow process-fork)
(allow sysctl-read)
(allow file-read-data (literal "/"))
(allow file-read-metadata ${ancestors.join(" ")})
(allow file-read*
  (literal ${quote(runner)}) (literal ${quote(node)}) (literal "/dev/null")
  (subpath ${quote(candidate)})
  (subpath "/usr/lib") (subpath "/System/Library")
  (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/Cellar")
  (subpath "/usr/local/lib"))`;
}

function runVerification({ node, runner, candidate, tests, signal, jobSignal }) {
  return new Promise((resolve) => {
    const stopSignal = jobSignal ? (signal ? AbortSignal.any([jobSignal, signal]) : jobSignal) : signal;
    if (stopSignal?.aborted) {
      resolve({ passed: false, exitCode: null, output: 'Verification cancelled' });
      return;
    }
    const child = spawn(SANDBOX, ['-p', sandboxProfile(node, runner, candidate), node, runner, candidate,
      ...tests.map((name) => path.join(candidate, name))], {
      cwd: candidate, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', OPENSSL_CONF: '/dev/null' },
    });
    let size = 0;
    const stdout = [];
    let reason;
    const stop = (message) => {
      if (!reason) reason = message;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    };
    const abort = () => stop('Verification cancelled');
    const timer = setTimeout(() => stop('Verification timed out'), VERIFY_TIMEOUT_MS);
    stopSignal?.addEventListener('abort', abort, { once: true });
    if (stopSignal?.aborted) abort();
    const capture = (channel, chunk) => {
      size += chunk.length;
      if (size > MAX_RUNNER_OUTPUT) stop('Verification output limit exceeded');
      else if (channel === 'stdout') stdout.push(chunk);
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.on('error', () => stop('macOS sandbox launcher failed'));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      stopSignal?.removeEventListener('abort', abort);
      if (reason) {
        resolve({ passed: false, exitCode, output: reason });
        return;
      }
      let results;
      try {
        results = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      } catch {
        // Child diagnostics can include untrusted text. Return bounded facts only.
      }
      if (!Array.isArray(results) || results.length !== tests.length || !results.every((result) =>
        typeof result?.passed === 'boolean' && Number.isSafeInteger(result.passedTests) && Number.isSafeInteger(result.failedTests))) {
        resolve({ passed: false, exitCode, output: 'Sandboxed execution produced no complete Node test report' });
        return;
      }
      const output = results.map((result, index) => `${tests[index]}: ${result.passedTests} passed, ${result.failedTests} failed`).join('\n');
      resolve({ passed: exitCode === 0 && results.every((result) => result.passed), exitCode, output });
    });
  });
}

async function assertCandidate(candidate, contents) {
  const directories = new Map([['.', new Set()]]);
  for (const [name, text] of contents) {
    if (text === null) continue;
    const file = await exactFile(candidate, name);
    const bytes = await diskBytes(file);
    if (file.stat.uid !== process.getuid() || (file.stat.mode & 0o077) !== 0 || !bytes.equals(textBytes(text))) {
      throw new Error('Verified API candidate content changed');
    }
    for (let entry = name; entry !== '.'; entry = path.dirname(entry)) {
      const directory = path.dirname(entry);
      if (!directories.has(directory)) directories.set(directory, new Set());
      directories.get(directory).add(path.basename(entry));
    }
  }
  for (const [directory, expected] of directories) {
    const filename = path.resolve(candidate, directory);
    const stat = await canonicalDirectory(filename);
    const names = await readdir(filename);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || names.length !== expected.size || names.some((name) => !expected.has(name))) {
      throw new Error('Verified API candidate directory changed');
    }
  }
}

async function enrolledSnapshot({ checkout, files, testPaths, priorChanges = [], signal }) {
  await canonicalDirectory(checkout);
  const baseSha = checkoutHead(checkout);
  const entries = makeEntries(files, testPaths);
  await snapshot(checkout, baseSha, entries, signal);
  for (const {path: relative, sha256} of priorChanges) {
    signal?.throwIfAborted();
    try {
      const name = sourcePath(relative);
      const entry = entries.get(name);
      const bytes = entry ? Buffer.from(entry.original ?? '') :
        await committedFile(checkout, baseSha, name, git(checkout, ['ls-tree', '-z', baseSha, '--', name]).toString('utf8'));
      if (entry?.original === null || hash(bytes) !== sha256) throw new Error('Verified source has changed');
    } catch (cause) {
      throw Object.assign(new Error('Previously verified changes require a checked handover', {cause}), {code: 'API_CANDIDATE_HANDOVER_REQUIRED'});
    }
  }
  return { baseSha, entries };
}

export async function readAdvisoryWorkspace({ checkout, files, testPaths, priorChanges, signal }) {
  signal?.throwIfAborted();
  const { baseSha, entries } = await enrolledSnapshot({ checkout, files, testPaths, priorChanges, signal });
  if (checkoutHead(checkout) !== baseSha) throw new Error('API advice Git HEAD changed during readback');
  return { baseSha, files: [...entries.values()].filter(entry => entry.inContext).map(entry =>
    ({ path: entry.name, text: entry.original, writable: false })) };
}

export async function prepareApiWorkspace({ checkout, jobRoot, files, testPaths, priorChanges, signal }, verifyInSandbox = runVerification) {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Isolated API development requires a macOS Node 24 sandbox');
  }
  signal?.throwIfAborted();
  await access(SANDBOX, constants.X_OK);
  const node = canonicalApiWorkspacePath(await realpath(process.execPath));
  const parent = await canonicalDirectory(path.dirname(canonicalApiWorkspacePath(jobRoot)));
  if (parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0 || jobRoot === checkout || jobRoot.startsWith(checkout + '/')) {
    throw new Error('API job directory must be outside the checkout with a private owner-only parent');
  }
  const { baseSha, entries } = await enrolledSnapshot({ checkout, files, testPaths, priorChanges, signal });
  signal?.throwIfAborted();
  await mkdir(jobRoot, { mode: 0o700 });
  const runner = path.join(jobRoot, 'run-tests.mjs');
  const readiness = path.join(jobRoot, 'readiness');
  const probe = path.join(readiness, 'readiness.test.mjs');
  try {
    await writeFile(runner, RUNNER, { flag: 'wx', mode: 0o400 });
    await mkdir(readiness, { mode: 0o700 });
    await writeFile(probe, READINESS_TEST, { flag: 'wx', mode: 0o400 });
    const result = await verifyInSandbox({node, runner, candidate: readiness, tests: [path.basename(probe)], signal});
    signal?.throwIfAborted();
    if (result?.passed !== true || result.exitCode !== 0) throw new Error('Isolated test did not complete successfully');
    await rm(readiness, {recursive: true});
    signal?.throwIfAborted();
  } catch (cause) {
    await rm(jobRoot, {recursive: true, force: true});
    signal?.throwIfAborted();
    throw Object.assign(new Error('Isolated workspace verification is unavailable', {cause}), {code: 'API_ISOLATION_UNAVAILABLE'});
  }
  let contents = new Map([...entries].map(([name, entry]) => [name, entry.original]));
  const tests = [...testPaths];
  let sequence = 0;
  let busy = false;
  let tested;

  return Object.freeze({
    context() {
      return {
        baseSha,
        files: [...entries.values()].filter((entry) => entry.inContext).map(({ name, writable }) =>
          ({ path: name, text: contents.get(name), writable })),
      };
    },
    async apply(changes) {
      signal?.throwIfAborted();
      if (busy) throw new Error('Cannot edit during API verification');
      if (!Array.isArray(changes) || changes.length > MAX_FILES) throw new Error('Invalid API replacement list');
      const replacement = new Map(contents);
      const seen = new Set();
      for (const change of changes) {
        const name = sourcePath(change?.path);
        if (!entries.get(name)?.writable || seen.has(name)) throw new Error('API replacement is unauthorized or duplicated');
        textBytes(change.text);
        seen.add(name);
        replacement.set(name, change.text);
      }
      const size = [...replacement.values()].reduce((total, text) => total + (text === null ? 0 : textBytes(text).length), 0);
      if (size > MAX_WORKSPACE_BYTES) throw new Error('API workspace exceeds its source size limit');
      contents = replacement;
      tested = undefined;
    },
    async verify({ signal: verifySignal } = {}) {
      if (busy) throw new Error('API workspace is already in use');
      if (sequence >= MAX_REVISIONS) throw new Error('Too many API workspace verification attempts');
      tested = undefined;
      if (signal?.aborted || verifySignal?.aborted) return { passed: false, exitCode: null, output: 'Verification cancelled' };
      busy = true;
      try {
        const candidatePath = path.join(jobRoot, `candidate-${++sequence}`);
        await mkdir(candidatePath, { mode: 0o700 });
        for (const [name, text] of contents) {
          if (text === null) continue;
          const destination = path.join(candidatePath, name);
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await writeFile(destination, textBytes(text), { flag: 'wx', mode: 0o600 });
        }
        await assertCandidate(candidatePath, contents);
        const runnerBytes = await diskBytes(await exactFile(jobRoot, 'run-tests.mjs'));
        if (!runnerBytes.equals(Buffer.from(RUNNER))) throw new Error('API test runner content changed');
        const result = await verifyInSandbox({ node, runner, candidate: candidatePath, tests, signal: verifySignal, jobSignal: signal });
        if (result.passed) {
          await assertCandidate(candidatePath, contents);
          if (signal?.aborted || verifySignal?.aborted) return { passed: false, exitCode: null, output: 'Verification cancelled' };
          tested = { candidatePath, verification: result };
        }
        return { ...result };
      } finally {
        busy = false;
      }
    },
    async finish() {
      signal?.throwIfAborted();
      if (busy || !tested) throw new Error('API candidate has not been verified');
      const { candidatePath, verification } = tested;
      const verifiedContents = contents;
      await assertCandidate(candidatePath, verifiedContents);
      if (busy || tested?.candidatePath !== candidatePath) throw new Error('API candidate changed during finalization');
      const changes = [];
      for (const [name, text] of verifiedContents) {
        const original = entries.get(name).original;
        if (text !== original) {
          changes.push({
            path: name, beforeSha256: original === null ? null : hash(textBytes(original)),
            sha256: hash(textBytes(text)), bytes: textBytes(text).length,
          });
        }
      }
      return { baseSha, candidatePath, changes, verification: { ...verification } };
    },
  });
}
