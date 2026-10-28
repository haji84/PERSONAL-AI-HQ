#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const DENY_PATH = /(^|\/)(\.env(?:\.[^/]*)?|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?\/|private\/|userdata\/)|\.(?:pem|p12|pfx|key|sqlite3?|db)$/i;
const RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{15,}\b/],
  ['generic-credential', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*['"]?(?!REPLACE_|EXAMPLE_|DUMMY_|\$\{|process\.env)[A-Za-z0-9_\/+.-]{16,}/i],
];
export function inspect(path, bytes) {
  const findings = [];
  if (DENY_PATH.test(path) && path !== '.env.example') findings.push('forbidden-path');
  if (bytes.length > MAX_BYTES) { findings.push('oversize-uninspected'); return findings; }
  if (bytes.includes(0)) { findings.push('binary-uninspected'); return findings; }
  const content = bytes.toString('utf8');
  for (const [name, regex] of RULES) if (regex.test(content)) findings.push(name);
  return findings;
}
function git(args) { return execFileSync('git', args, {encoding:'utf8', maxBuffer:8*1024*1024}); }
export function scanStaged() {
  const paths = execFileSync('git',['diff','--cached','--name-only','-z','--diff-filter=ACMR'],{maxBuffer:8*1024*1024}).toString('utf8').split('\0').filter(Boolean);
  let failures=0;
  for (const path of paths) {
    const blob = execFileSync('git',['show',':'+path],{maxBuffer:MAX_BYTES+1024*1024});
    const findings = inspect(path,blob);
    if(findings.length) { failures++; process.stderr.write('BLOCKED '+JSON.stringify(path)+' rules='+findings.join(',')+'\n'); }
  }
  return failures;
}
export function scanTracked() {
  const paths=git(['ls-files','-z']).split('\0').filter(Boolean);
  let failures=0;
  for(const path of paths) {
    const bytes=readFileSync(resolve(path));
    const findings=inspect(path,bytes);
    if(findings.length) {failures++;process.stderr.write('BLOCKED '+JSON.stringify(path)+' rules='+findings.join(',')+'\n');}
  }
  return failures;
}
if(process.argv[1] && import.meta.url===new URL('file://'+resolve(process.argv[1])).href) {
  try {
    const count=process.argv.includes('--staged')?scanStaged():scanTracked();
    if(count) {process.stderr.write('Secret guard rejected '+count+' file(s). No secret values printed.\n');process.exitCode=1;}
    else process.stdout.write('Secret guard passed. This is heuristic detection, not proof of absence.\n');
  } catch (e) {process.stderr.write('Secret guard failed closed: '+e.name+'\n');process.exitCode=2;}
}
