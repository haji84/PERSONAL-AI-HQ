import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensurePrivateDirectory, readPrivateRuntimeToken } from '../app/private-directory.mjs';

function windowsAcl(command, env) {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, env: { ...process.env, ...env },
  });
}

async function applyWindowsFixtureOwner(filename) {
  if (process.platform !== 'win32') return;
  await windowsAcl(`
    $ErrorActionPreference = 'Stop'
    $file = $env:HQ_TEST_PRIVATE_TOKEN_PATH
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [IO.File]::GetAccessControl($file)
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) {
      $acl.SetOwner($identity.User)
      [IO.File]::SetAccessControl($file, $acl)
    }
  `, { HQ_TEST_PRIVATE_TOKEN_PATH: filename });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-private-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('hq-private-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

test('a new runtime is private under the actual host permission model and can be reopened', async t => {
  const root = await fixture(t), directory = path.join(root, 'runtime');
  await ensurePrivateDirectory(directory);
  await fs.writeFile(path.join(directory, 'receipt.txt'), 'private fixture');
  await ensurePrivateDirectory(directory);
  assert.equal(await fs.readFile(path.join(directory, 'receipt.txt'), 'utf8'), 'private fixture');
  if (process.platform !== 'win32') assert.equal((await fs.stat(directory)).mode & 0o077, 0);
});

test('Windows binds a new runtime to the user and leaves an existing admin-owned runtime unchanged',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await fixture(t);
    const existing = path.join(root, 'existing'), runtime = path.join(root, 'runtime');
    await fs.mkdir(existing);
    async function acl(directory) {
      const { stdout } = await windowsAcl(`
        $ErrorActionPreference = 'Stop'
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $acl = [IO.Directory]::GetAccessControl($env:HQ_TEST_ACL_DIRECTORY)
        [Console]::Out.Write((@{user=$identity.User.Value; defaultOwner=$identity.Owner.Value;
          owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
          protected=$acl.AreAccessRulesProtected; sddl=$acl.Sddl} | ConvertTo-Json -Compress))
      `, { HQ_TEST_ACL_DIRECTORY: directory });
      return JSON.parse(stdout);
    }
    const adminSid = 'S-1-5-32-544';
    const baseline = await acl(existing);
    if (baseline.owner === adminSid && baseline.user !== adminSid) {
      await assert.rejects(ensurePrivateDirectory(existing), /private runtime/i);
      assert.deepEqual(await acl(existing), baseline);
      assert.deepEqual(await fs.readdir(existing), []);
    }
    assert.equal(await ensurePrivateDirectory(runtime), runtime);
    const hardened = await acl(runtime);
    assert.equal(hardened.owner, hardened.user);
    if (baseline.defaultOwner === adminSid && baseline.owner === adminSid && baseline.user !== adminSid) {
      assert.equal(hardened.protected, true);
      const backup = JSON.parse(await fs.readFile(path.join(runtime, '.runtime-acl-backup.json'), 'utf8'));
      assert.equal(backup.scope, 'new-runtime-directory-only');
      assert.equal(backup.afterSddl, hardened.sddl);
    }
    await ensurePrivateDirectory(runtime);
    assert.deepEqual(await acl(runtime), hardened);
  });

test('an existing file is rejected without replacing its contents', async t => {
  const root = await fixture(t), file = path.join(root, 'existing');
  await fs.writeFile(file, 'retained');
  await assert.rejects(ensurePrivateDirectory(file), /private runtime/i);
  assert.equal(await fs.readFile(file, 'utf8'), 'retained');
});

test('a redirected runtime directory is rejected', async t => {
  const root = await fixture(t), target = path.join(root, 'target'), link = path.join(root, 'link');
  await ensurePrivateDirectory(target);
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensurePrivateDirectory(link), /private runtime/i);
});

test('WS credentials read only an owner file in the runtime directory, without changing it', async t => {
  const root = await fs.realpath(await fixture(t));
  const directory = path.join(root, 'runtime');
  await ensurePrivateDirectory(directory);
  const filename = path.join(directory, 'local.token');
  const token = 'abC_'.repeat(16);
  await fs.writeFile(filename, token + '\r\n', {mode: 0o600});
  await applyWindowsFixtureOwner(filename);
  assert.equal(await readPrivateRuntimeToken(directory, filename), token);
  assert.equal(await fs.readFile(filename, 'utf8'), token + '\r\n');
  const outside = path.join(root, 'outside.token');
  await fs.writeFile(outside, token + '\n', {mode: 0o600});
  for (const invalid of [outside, 'local.token', path.join(directory, 'missing.token')]) {
    await assert.rejects(readPrivateRuntimeToken(directory, invalid), /トークンを確認できません/);
  }
  assert.equal(await fs.readFile(outside, 'utf8'), token + '\n');
  const alias = path.join(directory, 'alias.token');
  await fs.link(filename, alias);
  await assert.rejects(readPrivateRuntimeToken(directory, filename), /トークンを確認できません/);
  await fs.unlink(alias);
  await fs.writeFile(filename, token + ' \n', {mode: 0o600});
  await assert.rejects(readPrivateRuntimeToken(directory, filename), /トークンを確認できません/);
});

test('POSIX WS token reading rejects broader access despite a valid token', {skip: process.platform === 'win32'}, async t => {
  const root = await fs.realpath(await fixture(t)), directory = path.join(root, 'runtime');
  await ensurePrivateDirectory(directory);
  const filename = path.join(directory, 'local.token');
  const token = 'EDv-'.repeat(16);
  await fs.writeFile(filename, token, {mode: 0o600});
  await fs.chmod(filename, 0o644);
  await assert.rejects(readPrivateRuntimeToken(directory, filename), /トークンを確認できません/);
  await fs.chmod(filename, 0o600);
  if (process.platform === 'darwin') {
    await promisify(execFile)('/bin/chmod', ['+a', 'everyone allow read', filename]);
    await assert.rejects(readPrivateRuntimeToken(directory, filename), /トークンを確認できません/);
  }
});

test('an existing directory that exposes future children is rejected without changing its ACL', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), directory = path.join(root, 'runtime');
  await ensurePrivateDirectory(directory);
  const execute = promisify(execFile);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = command => execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, env: { ...process.env, HQ_TEST_ACL_DIRECTORY: directory },
  });
  const { stdout: before } = await run(`
    $directory = $env:HQ_TEST_ACL_DIRECTORY
    $acl = [IO.Directory]::GetAccessControl($directory)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::InheritOnly, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($directory, $acl)
    [Console]::Out.Write(([IO.Directory]::GetAccessControl($directory)).Sddl)
  `);
  await assert.rejects(ensurePrivateDirectory(directory), /private runtime/i);
  const { stdout: after } = await run('[Console]::Out.Write(([IO.Directory]::GetAccessControl($env:HQ_TEST_ACL_DIRECTORY)).Sddl)');
  assert.equal(after, before);
});

test('Windows rejects a token with a broadly readable file ACL while preserving that ACL', {skip: process.platform !== 'win32'}, async t => {
  const root = await fs.realpath(await fixture(t)), directory = path.join(root, 'runtime');
  await ensurePrivateDirectory(directory);
  const filename = path.join(directory, 'local.token');
  await fs.writeFile(filename, 'abcD'.repeat(16));
  await applyWindowsFixtureOwner(filename);
  assert.equal(await readPrivateRuntimeToken(directory, filename), 'abcD'.repeat(16));
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const execute = promisify(execFile);
  const run = command => execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, env: {...process.env, HQ_TEST_PRIVATE_TOKEN_PATH: filename},
  });
  const {stdout: before} = await run(`
    $file = $env:HQ_TEST_PRIVATE_TOKEN_PATH
    $acl = [IO.File]::GetAccessControl($file)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [System.Security.AccessControl.FileSystemRights]::Read,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    [IO.File]::SetAccessControl($file, $acl)
    [Console]::Out.Write(([IO.File]::GetAccessControl($file)).Sddl)
  `);
  await assert.rejects(readPrivateRuntimeToken(directory, filename), /トークンを確認できません/);
  const {stdout: after} = await run('[Console]::Out.Write(([IO.File]::GetAccessControl($env:HQ_TEST_PRIVATE_TOKEN_PATH)).Sddl)');
  assert.equal(after, before);
});
