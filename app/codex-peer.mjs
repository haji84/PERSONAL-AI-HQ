import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const denied = () => new Error('本人のCodex App Serverのローカル接続を確認できません。');
const validPort = port => Number.isSafeInteger(port) && port > 0 && port <= 65535;
const processId = /^[1-9]\d{0,9}$/;
const windowsOwner = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$target = [int]$env:PERSONAL_AI_HQ_CODEX_PEER_PID
$process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $target)
if (-not $process -or -not $process.ExecutablePath) { throw 'Missing peer executable' }
$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $current) { throw 'Invalid peer owner' }
[Console]::Out.Write($process.ExecutablePath)
`;

async function macPeer(server, client) {
  const {stdout} = await execute('/usr/sbin/lsof', ['-a', '-nP', '-iTCP:' + server, '-sTCP:ESTABLISHED', '-Fpun'], {
    timeout: 1500, maxBuffer: 65536,
  });
  const exactSocket = 'n127.0.0.1:' + server + '->127.0.0.1:' + client;
  const uid = 'u' + process.getuid();
  const matches = stdout.split(/(?=^p\d)/m).map(row => row.trim().split('\n'))
    .filter(lines => lines.includes(exactSocket) && lines.includes(uid));
  if (matches.length !== 1) throw denied();
  const pid = matches[0][0].slice(1);
  if (!processId.test(pid)) throw denied();
  return (await execute('/bin/ps', ['-p', pid, '-o', 'comm='], {timeout: 1200, maxBuffer: 4096})).stdout.trim();
}

async function windowsPeer(server, client) {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const {stdout} = await execute(join(system, 'netstat.exe'), ['-ano', '-p', 'TCP'], {
    windowsHide: true, timeout: 1200, maxBuffer: 524288,
  });
  const local = '127.0.0.1:' + server;
  const remote = '127.0.0.1:' + client;
  const matches = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(fields => fields[0] === 'TCP' && fields[1] === local && fields[2] === remote && processId.test(fields.at(-1)));
  if (matches.length !== 1) throw denied();
  const {stdout: binary} = await execute(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', windowsOwner], {
      windowsHide: true, timeout: 3200, maxBuffer: 4096,
      env: {...process.env, PERSONAL_AI_HQ_CODEX_PEER_PID: matches[0].at(-1)},
    });
  return binary.trim();
}

export async function createCodexPeerVerifier(configured = process.env.HQ_CODEX_BIN) {
  try {
    const platform = process.platform;
    if (platform !== 'win32' && platform !== 'darwin') throw denied();
    const path = configured ?? ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'].find(file => platform === 'darwin' && existsSync(file));
    if (typeof path !== 'string' || !isAbsolute(path)) throw denied();
    const expected = await realpath(path);
    if (!(await stat(expected)).isFile()) throw denied();
    return async function verifyPeer({serverPort, clientPort}) {
      try {
        if (!validPort(serverPort) || !validPort(clientPort) || serverPort === clientPort) throw denied();
        const peer = await (platform === 'win32' ? windowsPeer(serverPort, clientPort) : macPeer(serverPort, clientPort));
        if (!isAbsolute(peer)) throw denied();
        const actual = await realpath(peer);
        if (platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) throw denied();
      } catch { throw denied(); }
    };
  } catch { throw denied(); }
}
