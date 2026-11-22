import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const root=resolve('.');
const git=(dir,args)=>spawnSync('git',args,{cwd:dir,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
test('real Git hook allows safe commit and rejects synthetic secrets',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-hook-e2e-'));
 try {
  assert.equal(git(dir,['init']).status,0);
  assert.equal(git(dir,['config','user.email','test@example.invalid']).status,0);
  assert.equal(git(dir,['config','user.name','Synthetic Tester']).status,0);
  mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'.githooks'));
  copyFileSync(join(root,'scripts/secret-guard.mjs'),join(dir,'scripts/secret-guard.mjs'));
  copyFileSync(join(root,'scripts/install-hooks.mjs'),join(dir,'scripts/install-hooks.mjs'));
  copyFileSync(join(root,'.githooks/pre-commit'),join(dir,'.githooks/pre-commit'));
  const install=spawnSync(process.execPath,['scripts/install-hooks.mjs'],{cwd:dir,encoding:'utf8'});
  assert.equal(install.status,0,install.stderr);
  writeFileSync(join(dir,'safe.txt'),'safe synthetic text\n');
  assert.equal(git(dir,['add','safe.txt']).status,0);
  assert.equal(git(dir,['commit','-m','safe']).status,0);
  writeFileSync(join(dir,'token.txt'),'ghp_'+'A'.repeat(30));
  assert.equal(git(dir,['add','token.txt']).status,0);
  const blocked=git(dir,['commit','-m','synthetic token']);
  assert.notEqual(blocked.status,0);
  assert.match(blocked.stderr,/BLOCKED/);
  assert.doesNotMatch(blocked.stderr,/ghp_A{20}/);
  assert.equal(git(dir,['reset','--hard','HEAD']).status,0);
  writeFileSync(join(dir,'key.txt'),['-----BEGIN','PRIVATE KEY-----'].join(' '));
  assert.equal(git(dir,['add','key.txt']).status,0);
  assert.notEqual(git(dir,['commit','-m','synthetic key']).status,0);
  assert.equal(git(dir,['reset','--hard','HEAD']).status,0);
  writeFileSync(join(dir,'.env'),'synthetic\n');
  assert.equal(git(dir,['add','-f','.env']).status,0);
  assert.notEqual(git(dir,['commit','-m','forbidden path']).status,0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
