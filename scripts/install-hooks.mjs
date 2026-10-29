#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
const hook=resolve('.githooks/pre-commit');
try {
  chmodSync(hook,0o755);
  if((statSync(hook).mode & 0o111)===0) throw new Error('hook is not executable');
  execFileSync('git',['config','--local','core.hooksPath','.githooks'],{stdio:'pipe'});
  const installed=execFileSync('git',['config','--local','--get','core.hooksPath'],{encoding:'utf8'}).trim();
  if(installed!=='.githooks') throw new Error('hook path mismatch');
  process.stdout.write('Local Git pre-commit hook installed and executable.\n');
} catch(e) {
  process.stderr.write('Hook installation failed: '+e.name+'\n');
  process.exitCode=1;
}
