import { execFile } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const invalid = () => new Error('A private runtime directory is required');
// Paths are passed as data in the child environment, never interpolated into
// PowerShell. Only a newly created empty runtime may receive a narrower DACL.
const windowsCheck = `
$ErrorActionPreference = 'Stop'
$directory = $env:PERSONAL_AI_HQ_DIRECTORY_CHECK
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User.Value
$trusted = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
function Test-Private($acl) {
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid) { return $false }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { return $false }
  }
  return $true
}
$item = [IO.DirectoryInfo]::new($directory)
if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid runtime' }
$before = [IO.Directory]::GetAccessControl($directory)
$changed = $false
if (-not (Test-Private $before)) {
  if ($env:PERSONAL_AI_HQ_DIRECTORY_CREATED -ne '1' -or $before.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid) { throw 'Runtime is not private' }
  $restricted = [System.Security.AccessControl.DirectorySecurity]::new()
  $restricted.SetOwner($identity.User)
  $restricted.SetAccessRuleProtection($true, $false)
  foreach ($sid in $trusted) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $restricted.AddAccessRule($rule)
  }
  try {
    [IO.Directory]::SetAccessControl($directory, $restricted)
    if (-not (Test-Private ([IO.Directory]::GetAccessControl($directory)))) { throw 'Runtime remains accessible' }
    $changed = $true
  } catch { [IO.Directory]::SetAccessControl($directory, $before); throw }
}
[Console]::Out.Write((@{private=$true; changed=$changed; beforeSddl=$before.Sddl; afterSddl=([IO.Directory]::GetAccessControl($directory)).Sddl} | ConvertTo-Json -Compress))
`;

export async function ensurePrivateDirectory(input) {
  const directory = resolve(input);
  let created = false;
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw invalid();
    return directory;
  }
  try {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', windowsCheck], {
      windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
      env: { ...process.env, PERSONAL_AI_HQ_DIRECTORY_CHECK: directory, PERSONAL_AI_HQ_DIRECTORY_CREATED: created ? '1' : '0' },
    });
    const result = JSON.parse(stdout.trim());
    if (result.private !== true) throw invalid();
    if (result.changed) await writeFile(join(directory, '.runtime-acl-backup.json'), JSON.stringify({
      createdAt: new Date().toISOString(), scope: 'new-runtime-directory-only',
      beforeSddl: result.beforeSddl, afterSddl: result.afterSddl,
    }), { flag: 'wx', mode: 0o600 });
    return directory;
  } catch (cause) {
    const problem = invalid();
    problem.cause = new Error(String(cause.stderr ?? cause.message).slice(0, 1800));
    throw problem;
  }
}
