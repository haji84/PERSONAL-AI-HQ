import { execFile } from 'node:child_process';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const invalid = () => new Error('A private runtime directory is required');
const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsOwnerACL = `
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User.Value
$trusted = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
function Test-Private($acl) {
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid) { return $false }
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl -or
      -not ($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)) { return $false }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { return $false }
  }
  return $true
}
`;
// Paths are passed as data in the child environment, never interpolated into
// PowerShell. Only a newly created empty runtime may receive a narrower DACL.
const windowsCheck = `
$ErrorActionPreference = 'Stop'
$directory = $env:PERSONAL_AI_HQ_DIRECTORY_CHECK
${windowsOwnerACL}
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
const windowsFileCheck = `
$ErrorActionPreference = 'Stop'
${windowsOwnerACL}
$directory = [IO.DirectoryInfo]::new($env:PERSONAL_AI_HQ_DIRECTORY_CHECK)
$file = [IO.FileInfo]::new($env:PERSONAL_AI_HQ_PRIVATE_FILE_CHECK)
if (-not $directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    -not $file.Exists -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid private file' }
if (-not (Test-Private ([IO.Directory]::GetAccessControl($directory.FullName))) -or
    -not (Test-Private ([IO.File]::GetAccessControl($file.FullName)))) { throw 'File is not private' }
[Console]::Out.Write('private')
`;

const windowsWorkspaceCheck = String.raw`
$ErrorActionPreference = 'Stop'
${windowsOwnerACL}
function Read-ExactChild([string]$parent, [string]$name, [bool]$isDirectory) {
  $exact = $null
  foreach ($entry in [IO.DirectoryInfo]::new($parent).EnumerateFileSystemInfos()) {
    if ([string]::Equals($entry.Name, $name, [StringComparison]::OrdinalIgnoreCase)) {
      if ($null -ne $exact -or -not [string]::Equals($entry.Name, $name, [StringComparison]::Ordinal)) { throw 'Ambiguous entry' }
      $exact = $entry
    }
  }
  if ($null -eq $exact -or -not $exact.Exists -or
      ($exact.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Device)) -or
      ($isDirectory -ne ($exact -is [IO.DirectoryInfo]))) { throw 'Invalid entry' }
  return $exact
}
function Assert-OwnedEntry($item, [bool]$isDirectory) {
  $acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($item.FullName) }
         else { [IO.File]::GetAccessControl($item.FullName) }
  if (-not (Test-Private $acl)) { throw 'Entry is not private' }
}
$directory = $env:PERSONAL_AI_HQ_WORKSPACE_CHECK
$drive = [IO.Path]::GetPathRoot($directory)
if ([IO.DriveInfo]::new($drive).DriveType -ne [IO.DriveType]::Fixed) { throw 'Nonlocal drive' }
$parent = $drive
foreach ($name in $directory.Substring($drive.Length).Split([char]92)) {
  $workspace = Read-ExactChild $parent $name $true
  $parent = $workspace.FullName
}
Assert-OwnedEntry $workspace $true
$checkedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$files = [string]$env:PERSONAL_AI_HQ_WORKSPACE_FILES
if ($files.Length -gt 0) {
  foreach ($relative in $files.Split([char]10)) {
    $parent = $workspace.FullName
    $parts = $relative.Split([char]47)
    for ($index = 0; $index -lt $parts.Length; $index++) {
      $isDirectory = $index -lt ($parts.Length - 1)
      $path = [IO.Path]::Combine($parent, $parts[$index])
      if (-not $isDirectory -or -not $checkedDirectories.Contains($path)) {
        $item = Read-ExactChild $parent $parts[$index] $isDirectory
        Assert-OwnedEntry $item $isDirectory
        if ($isDirectory) { [void]$checkedDirectories.Add($path) }
      }
      $parent = $path
    }
  }
}
[Console]::Out.Write('private')
`;

export function isOrdinaryWindowsPathComponent(name) {
  return name.length > 0 && name.length <= 255 && name.isWellFormed() &&
    !/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/u.test(name) && !name.endsWith('.') && !name.endsWith(' ') &&
    !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/iu.test(name.split('.', 1)[0].trimEnd());
}

function validWindowsDirectory(directory) {
  return typeof directory === 'string' && /^[A-Za-z]:\\/.test(directory) && directory.length <= 4096 &&
    directory.slice(3).split('\\').every(isOrdinaryWindowsPathComponent);
}

export async function assertWindowsPrivateWorkspace(directory, relativeFiles, signal) {
  const rejected = () => new Error('A private Windows workspace is required');
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32' || !validWindowsDirectory(directory) || !validWindowsDirectory(systemRoot) ||
      !Array.isArray(relativeFiles) || relativeFiles.length > 64) throw rejected();
  const files = [...new Set(relativeFiles)];
  if (files.some(file => typeof file !== 'string' || file.length > 240 ||
      !file.split('/').every(isOrdinaryWindowsPathComponent))) throw rejected();
  try {
    signal?.throwIfAborted();
    if (realpathSync.native(directory) !== directory) throw rejected();
    const { stdout } = await execute(powershell(), ['-NoProfile', '-NonInteractive', '-Command', windowsWorkspaceCheck], {
      cwd: systemRoot, windowsHide: true, timeout: 10_000, maxBuffer: 1024, signal,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
        PERSONAL_AI_HQ_WORKSPACE_CHECK: directory, PERSONAL_AI_HQ_WORKSPACE_FILES: files.join('\n') },
    });
    signal?.throwIfAborted();
    if (stdout !== 'private' || files.some(file => {
      const target = win32.join(directory, file);
      const info = lstatSync(target);
      return !info.isFile() || info.nlink !== 1 || realpathSync.native(target) !== target;
    })) throw rejected();
  } catch { throw rejected(); }
}

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
    const { stdout } = await execute(powershell(), ['-NoProfile', '-NonInteractive', '-Command', windowsCheck], {
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

export async function readPrivateRuntimeToken(runtime, input) {
  const rejected = () => new Error('Codex接続用の本人専用トークンを確認できません。');
  const maxTokenFileBytes = 130;
  let handle;
  try {
    if (typeof input !== 'string' || !isAbsolute(input)) throw rejected();
    const directory = resolve(runtime);
    const filename = resolve(input);
    if (dirname(filename) !== directory) throw rejected();
    const [folder, file, realFolder, realFile] = await Promise.all([lstat(directory), lstat(filename), realpath(directory), realpath(filename)]);
    if (!folder.isDirectory() || !file.isFile() || file.nlink !== 1 || realFolder !== directory || realFile !== filename ||
        file.size < 43 || file.size > maxTokenFileBytes) throw rejected();
    if (process.platform === 'win32') {
      const {stdout} = await execute(powershell(), ['-NoProfile', '-NonInteractive', '-Command', windowsFileCheck], {
        windowsHide: true, timeout: 10000, maxBuffer: 1024,
        env: {...process.env, PERSONAL_AI_HQ_DIRECTORY_CHECK: directory, PERSONAL_AI_HQ_PRIVATE_FILE_CHECK: filename},
      });
      if (stdout.trim() !== 'private') throw rejected();
    } else {
      const uid = process.getuid?.();
      if (uid === undefined || [folder, file].some(entry => entry.uid !== uid || (entry.mode & 0o077) !== 0)) throw rejected();
      if (process.platform === 'darwin') {
        for (const entry of [directory, filename]) {
          const {stdout} = await execute('/bin/ls', ['-Plde', entry], {env: {LC_ALL: 'C'}, timeout: 2000, maxBuffer: 8192});
          if (!stdout || stdout.trimEnd().includes('\n')) throw rejected();
        }
      }
    }
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    const bytes = Buffer.alloc(maxTokenFileBytes + 1);
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.ino !== file.ino || after.dev !== file.dev ||
        file.ctimeMs !== after.ctimeMs || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs ||
        bytesRead !== file.size || after.size !== bytesRead) throw rejected();
    const token = bytes.subarray(0, bytesRead).toString('utf8').replace(/\r?\n$/, '');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw rejected();
    return token;
  } catch { throw rejected(); }
  finally { await handle?.close(); }
}
