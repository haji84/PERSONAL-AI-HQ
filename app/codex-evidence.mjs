import {posix, win32} from 'node:path';

const evidenceStatuses = new Set(['inProgress', 'completed', 'failed', 'declined']);
const changeKinds = new Set(['add', 'update', 'delete']);
const pathActions = new Set(['read', 'listFiles', 'search']);
const unsafePath = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;
const credential = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,}|xox[a-z]-[a-z0-9-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)|\b(?:Bearer|Basic)\s+[a-z0-9+/_.=-]{8,}|\b(?:[A-Z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|secret|credential|authorization|cookie)["']?\s*(?:[:=]|\s+)\s*["']?\S|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const sensitiveCommand = /(?:^|[\s;&|"'()/\\])(?:printenv|env|set|export|secret-tool|vault)(?:\.exe)?(?=$|[\s;&|"'()])|\b(?:gh\s+auth\s+token|gcloud\s+secrets|aws\s+(?:secretsmanager|ssm\s+get-parameter)|security\s+find-\S*password|op\s+(?:read|item\s+get)|pass\s+show|git\s+credential|cmdkey|Get-Secret|Get-ChildItem\s+Env:)\b|\$env:|\bprocess\.env\b|(?:^|[\\/\s"'=])(?:\.env(?:\.[\w.-]+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\.json)?|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[a-z0-9_.-]+\.(?:pem|key|p12|pfx))(?=$|[\s"';&|])/iu;
const terminalFormatting = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|\u001b[P_^][^\u001b]*(?:\u001b\\|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu;
const quotedAbsolutePath = /(["'])((?:[a-z]:[\\/]|\\\\|\/)[^"'<>|\r\n]*?)\1/giu;
const absolutePathText = /(^|[\s="'(<:\u0060])((?:[a-z]:[\\/]|\\\\|\/)[^\s"'<>|;)\u0060]*)/giu;
const windowsWorkspace = /^[a-z]:[\\/]|^\\\\/i;
const posixShellLauncher = /^(["']?)\/(?:usr\/)?bin\/(?:bash|sh|zsh)\1[ \t]+-[a-z]*c[ \t]+/u;
const windowsShellLauncher = /^(["']?)(?:[a-z]:\\Windows\\System32\\(?:cmd\.exe|WindowsPowerShell\\v1\.0\\powershell\.exe)|cmd(?:\.exe)?|powershell(?:\.exe)?)\1(?:[ \t]+(?:\/[ds]|-NoProfile|-NonInteractive))*[ \t]+(?:\/c|-Command)[ \t]+/iu;
// Recognize the standard PowerShell 7 install and the Codex-owned packaged shell in recorded commands.
const powershell7Launcher = /^(["']?)(?:pwsh(?:\.exe)?|[a-z]:[\\/]Program Files[\\/](?:PowerShell[\\/]7|WindowsApps[\\/]OpenAI\.CodexPrimaryRuntime\.[a-z0-9.-]+_[\d.]+_(?:x64|arm64)__3k8sg7r9htsxt[\\/]dependencies[\\/]native[\\/]powershell)[\\/]pwsh\.exe)\1(?=[ \t]|$)/iu;
const powershell7Command = /^(?:[ \t]+-(?:NoLogo|NoProfile|NonInteractive))*[ \t]+-Command[ \t]+/iu;
const windowsCommandStart = /^(?:&[ \t]*)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'<>;&|]+))/u;
const powershell7Name = /^pwsh(?:\.(?:exe|cmd|bat|ps1))?$/iu;
const literalAbsolutePath = /(["'])((?:[a-z]:|[\\/])[^"'\r\n]*)\1|(?<![^\s"'=<>|;(&,\u0060])((?:[a-z]:|[\\/])[^\s"'<>|;)&,\u0060]*)/giu;
const unresolvedPath = /(?:^|[\s"'=<>|;(&,\\/\u0060])(?:\.\.(?=$|[\s"'\\/>|;)&,])|~(?:[\w.-]+)?(?=$|[\s"'\\/])|\$(?:\{[^}\r\n]+\}|(?:env:)?[a-z_][a-z0-9_]*)|%[a-z_][a-z0-9_]*%)/iu;

function relativeMetadata(workspace, value, rootAllowed = false, base = workspace) {
  if (typeof value !== 'string' || !value || value.length > 2048 || unsafePath.test(value) || credential.test(value)) return;
  const windows = windowsWorkspace.test(workspace);
  const style = windows ? win32 : posix;
  if ((!windows && (value.includes('\\') || /^[a-z]:/i.test(value))) || value.split(/[\\/]/).includes('..')) return;
  if (windows && (/^\\\\[?.]\\/.test(value) || value.replace(/^[a-z]:/i, '').includes(':'))) return;
  if (style.parse(value).root && (!style.isAbsolute(value) || (windows && /^[\\/](?![\\/])/.test(value)))) return;
  const target = style.resolve(base, value);
  const relative = style.relative(workspace, target);
  if (style.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + style.sep)) return;
  if (relative) return windows ? relative.replaceAll('\\', '/') : relative;
  if (rootAllowed) return '.';
}

function outsideCommandAction(actions, workspace, cwd) {
  if (!Array.isArray(actions)) return false;
  return actions.some(action => {
    if (!pathActions.has(action?.type)) return false;
    const {path} = action;
    if (path == null) return action.type === 'read';
    return typeof path !== 'string' || /^[~$%]/u.test(path) || relativeMetadata(workspace, path, true, cwd) === undefined;
  });
}

function commandInScope(command, workspace, cwd) {
  // The native shell wrapper is an executable, not a file argument. Check the payload.
  const windows = windowsWorkspace.test(workspace);
  const trimmed = windows ? command.trimStart() : command;
  const pwsh = windows && powershell7Launcher.exec(trimmed);
  let display = command;
  let payload;
  if (pwsh) {
    const args = trimmed.slice(pwsh[0].length);
    const flags = powershell7Command.exec(args);
    if (!flags) return;
    payload = args.slice(flags[0].length).trim();
    if (!payload || /^(?:"-"|'-'|-)(?:\s|$)|^(["'])\s*\1$/u.test(payload)) return;
    display = 'pwsh.exe' + args;
  } else {
    if (windows) {
      const start = windowsCommandStart.exec(trimmed);
      const executable = start?.[1] ?? start?.[2] ?? start?.[3];
      if (executable && powershell7Name.test(win32.basename(executable))) return;
    }
    payload = command.replace(windows ? windowsShellLauncher : posixShellLauncher, '');
  }
  if (unresolvedPath.test(payload)) return;
  for (const match of payload.matchAll(literalAbsolutePath)) {
    if (relativeMetadata(workspace, match[2] ?? match[3], true, cwd) === undefined) return;
  }
  return display;
}

function cleanText(value) {
  return value.replace(terminalFormatting, '').replace(/\r\n?/gu, '\n');
}

function displayText(text, workspace, limit) {
  // Locations in command and output text are display metadata too.
  let shown = text.replace(quotedAbsolutePath, (_match, quote, path) =>
    quote + (relativeMetadata(workspace, path, true) ?? '[外部パス]') + quote);
  shown = shown.replace(absolutePathText, (_match, prefix, path) =>
    prefix + (relativeMetadata(workspace, path, true) ?? '[外部パス]'));
  shown = shown.split(workspace).join('[作業先]');
  const cut = shown.slice(0, limit).replace(/[\ud800-\udbff]$/u, '');
  return {text: cut, truncated: shown.length > cut.length};
}

function commandEvidence(raw, workspace) {
  const {item} = raw;
  const entry = {type: 'command', id: item.id, status: item.status, outputState: 'unavailable'};
  const cwd = typeof item.cwd === 'string' && (posix.isAbsolute(item.cwd) || win32.isAbsolute(item.cwd))
    ? relativeMetadata(workspace, item.cwd, true) : undefined;
  if (cwd !== undefined) entry.cwd = cwd;
  if (Number.isSafeInteger(item.exitCode)) entry.exitCode = item.exitCode;
  if (Number.isSafeInteger(item.durationMs) && item.durationMs >= 0) entry.durationMs = item.durationMs;

  const command = typeof item.command === 'string' && item.command.length <= 16000 && cleanText(item.command);
  const scoped = cwd !== undefined && command && !credential.test(command) && !sensitiveCommand.test(command) &&
    !outsideCommandAction(item.commandActions, workspace, item.cwd) && commandInScope(command, workspace, item.cwd);
  if (!scoped) {
    entry.outputState = 'hidden';
    return entry;
  }
  const commandText = displayText(scoped, workspace, 1200);
  entry.command = commandText.text;
  if (commandText.truncated) entry.truncated = true;
  if (raw.outputDeferred === true) {
    if (item.status === 'completed') entry.outputState = 'deferred';
  } else if (typeof item.aggregatedOutput === 'string') {
    const output = cleanText(item.aggregatedOutput);
    if (credential.test(output)) entry.outputState = 'hidden';
    else if (!output.trim()) entry.outputState = 'empty';
    else {
      const outputText = displayText(output, workspace, 6000);
      entry.outputState = 'visible';
      entry.output = outputText.text;
      if (outputText.truncated) entry.truncated = true;
    }
  }
  return entry;
}

function fileEvidence(item, workspace) {
  if (!Array.isArray(item.changes)) return null;
  const changes = [];
  for (const change of item.changes.slice(0, 20)) {
    const kind = change?.kind?.type;
    if (!changeKinds.has(kind)) continue;
    const previous = relativeMetadata(workspace, change.path);
    const move = kind === 'update' && change.kind.move_path != null;
    const path = move ? relativeMetadata(workspace, change.kind.move_path) : previous;
    if (!path || !previous) continue;
    changes.push({path, kind, ...(move ? {from: previous} : {})});
  }
  if (!changes.length) return null;
  return {type: 'files', id: item.id, status: item.status, changes,
    ...(changes.length < item.changes.length ? {truncated: true} : {})};
}

export function turnEvidenceItem(raw, workspace) {
  const moderation = raw.item.moderation ?? raw.moderation;
  if (moderation?.moderated === true || (moderation?.display && moderation.display.mode !== 'show')) return null;
  if (!evidenceStatuses.has(raw.item.status)) return null;
  if (raw.item.type === 'commandExecution') return commandEvidence(raw, workspace);
  if (raw.item.type === 'fileChange') return fileEvidence(raw.item, workspace);
  return null;
}
