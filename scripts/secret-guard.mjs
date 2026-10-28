#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  let content;
  try { content = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
  catch { findings.push('encoding-uninspected'); return findings; }
  for (const [name, regex] of RULES) if (regex.test(content)) findings.push(name);
  return findings;
}
// Git data, not the checkout, is the inspected subject. Preserve GIT_INDEX_FILE
// for real Git hooks (including temporary indexes used by partial commits).
function git(args, maxBuffer = 8 * 1024 * 1024) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    maxBuffer, stdio:['ignore','pipe','pipe'],
    env:{...process.env, GIT_NO_REPLACE_OBJECTS:'1'},
  });
}
function decode(bytes) { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
function oid(output) {
  const value = decode(output).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('invalid object id');
  return value;
}
function scanTree(tree) {
  // Parsing the NUL-delimited tree, rather than paths from a diff, includes all
  // types and avoids ambiguous pathspec/revision syntax for unusual names.
  const records = decode(git(['ls-tree','-r','-z','--full-tree',tree])).split('\0');
  if (records.pop() !== '') throw new Error('invalid tree output');
  let failures = 0;
  for (const record of records) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('invalid tree entry');
    const [,mode,type,blob,path] = match;
    let findings;
    if (!['100644','100755'].includes(mode) || type !== 'blob') {
      findings = ['unsupported-mode'];
    } else {
      const sizeText = decode(git(['cat-file','-s',blob])).trim();
      if (!/^\d+$/.test(sizeText)) throw new Error('invalid blob size');
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size > MAX_BYTES) findings = ['oversize-uninspected'];
      else {
        const bytes = git(['cat-file','blob',blob], MAX_BYTES + 1);
        if (bytes.length !== size) throw new Error('blob size mismatch');
        findings = inspect(path,bytes);
      }
    }
    if (findings.length) {
      failures++;
      process.stderr.write('BLOCKED '+JSON.stringify(path)+' rules='+findings.join(',')+'\n');
    }
  }
  return failures;
}
export function scanStaged() {
  return scanTree(oid(git(['write-tree'])));
}
export function scanCommit(commit) {
  if (commit !== undefined && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit)) throw new Error('full commit SHA required');
  if (commit !== undefined && decode(git(['cat-file','-t',commit])).trim() !== 'commit') throw new Error('commit object required');
  const resolved = oid(git(['rev-parse','--verify',(commit ?? 'HEAD')+'^{commit}']));
  if (commit !== undefined && resolved !== commit.toLowerCase()) throw new Error('commit identity mismatch');
  // Only the full resolved identity is used after this point.
  process.stdout.write('Inspecting commit '+resolved+'\n');
  return scanTree(resolved);
}
export function scanTracked() { return scanCommit(); }
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  try {
    const args = process.argv.slice(2);
    let count;
    if (args.length === 0) count = scanTracked();
    else if (args.length === 1 && args[0] === '--staged') count = scanStaged();
    else if (args.length === 2 && args[0] === '--commit') count = scanCommit(args[1]);
    else throw new Error('invalid arguments');
    if(count) {process.stderr.write('Secret guard rejected '+count+' file(s). No secret values printed.\n');process.exitCode=1;}
    else process.stdout.write('Secret guard passed. This is heuristic detection, not proof of absence.\n');
  } catch (e) {process.stderr.write('Secret guard failed closed: '+e.name+'\n');process.exitCode=2;}
}
