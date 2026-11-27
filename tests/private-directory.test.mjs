import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensurePrivateDirectory } from '../app/private-directory.mjs';

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
