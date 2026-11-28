import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('Use start-mac.command on macOS.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required.');
if (!process.env.HQ_CODEX_BIN) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation'],
  { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
  const install = stdout.trim();
  if (!install) throw new Error('The installed Codex desktop was not found.');
  const command = join(install, 'app', 'resources', 'codex.exe');
  await access(command);
  process.env.HQ_CODEX_BIN = command;
}
const { startOwnerApp } = await import('./server.mjs');
const loopbackUrl = process.env.HQ_CODEX_LOOPBACK_URL;
const app = await startOwnerApp({ directory: process.env.HQ_PRIVATE_DIRECTORY, port: Number(process.env.HQ_PORT ?? 4328),
  loopbackUrl, loopbackTokenFile: process.env.HQ_CODEX_LOOPBACK_TOKEN_FILE, plan: process.env.HQ_CHATGPT_PLAN === '1' });
console.log(JSON.stringify({ url: app.url, signInFile: app.signInFile, ...(loopbackUrl ? {} : {codexWrite: false}) }));
process.once('SIGINT', () => { void app.close(); });
process.once('SIGTERM', () => { void app.close(); });
