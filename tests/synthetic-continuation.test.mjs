import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=new URL('../scripts/synthetic-continuation.mjs',import.meta.url).pathname;
function call(op,root){return spawnSync(process.execPath,[runner,op,root],{encoding:'utf8',timeout:10000});}
function parse(file){return JSON.parse(readFileSync(file,'utf8'));}

test('different OS processes prove observed failure, repair, tests and blocked review gate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-continuation-'));
 try{
  let r=call('init',dir);assert.equal(r.status,0,r.stderr);assert.equal(parse(join(dir,'job.json')).state,'QUEUED');
  r=call('observe-failure',dir);assert.equal(r.status,0,r.stderr);
  assert.equal(parse(join(dir,'job.json')).state,'RUNNING');
  const failure=parse(join(dir,'failure.json'));assert.equal(failure.kind,'observed-test-failure');assert.ok(failure.failedCases>0);
  r=call('resume',dir);assert.equal(r.status,0,r.stderr);
  const job=parse(join(dir,'job.json')),pass=parse(join(dir,'pass.json'));
  assert.equal(job.state,'BLOCKED');assert.equal(job.revision,3);
  assert.equal(job.attempts.length,1);
  assert.equal(pass.kind,'observed-test-pass');assert.equal(pass.passedCases,6);
  assert.notEqual(pass.sourceSha256,failure.sourceSha256);
  assert.match(readFileSync(join(dir,'fixture.py'),'utf8'),/return a \+ b/);
  assert.match(job.events.at(-1).reason,/independent-model-review-unavailable/);
  const snapshot=readFileSync(join(dir,'job.json'),'utf8');
  r=call('resume',dir);assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(join(dir,'job.json'),'utf8'),snapshot);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('injected corrupted failure receipt rejects unverified repair',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-continuation-'));
 try{
  assert.equal(call('init',dir).status,0);
  assert.equal(call('observe-failure',dir).status,0);
  const receipt=parse(join(dir,'failure.json'));
  receipt.sourceSha256='0'.repeat(64);
  writeFileSync(join(dir,'failure.json'),JSON.stringify(receipt));
  const r=call('resume',dir);assert.notEqual(r.status,0);
  assert.match(readFileSync(join(dir,'fixture.py'),'utf8'),/return a - b/);
  assert.equal(parse(join(dir,'job.json')).state,'RUNNING');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('replay after a crash between observed failure and state transition is idempotent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-continuation-'));
 try{
  assert.equal(call('init',dir).status,0);
  const queued=readFileSync(join(dir,'job.json'),'utf8');
  assert.equal(call('observe-failure',dir).status,0);
  // Simulate state write not occurring while the failure receipt survived.
  writeFileSync(join(dir,'job.json'),queued);
  const r=call('observe-failure',dir);
  assert.equal(r.status,0,r.stderr);
  assert.equal(parse(join(dir,'job.json')).state,'RUNNING');
  assert.equal(parse(join(dir,'job.json')).attempts.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('replay after crash during verification uses exact receipt without duplicate work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-continuation-'));
 try{
  assert.equal(call('init',dir).status,0);
  assert.equal(call('observe-failure',dir).status,0);
  const running=readFileSync(join(dir,'job.json'),'utf8');
  assert.equal(call('resume',dir).status,0);
  // Simulate a crash before state transition following a durable PASS receipt.
  writeFileSync(join(dir,'job.json'),running);
  let r=call('resume',dir);assert.equal(r.status,0,r.stderr);
  assert.equal(parse(join(dir,'job.json')).state,'BLOCKED');
  assert.equal(parse(join(dir,'job.json')).revision,3);
  const verifying=parse(join(dir,'job.json'));
  verifying.state='VERIFYING';verifying.revision=2;verifying.events.pop();
  writeFileSync(join(dir,'job.json'),JSON.stringify(verifying));
  r=call('resume',dir);assert.equal(r.status,0,r.stderr);
  assert.equal(parse(join(dir,'job.json')).state,'BLOCKED');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('rejects a symlinked scratch source during failing baseline',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-continuation-'));
 const other=mkdtempSync(join(tmpdir(),'hq-target-'));
 try{
  assert.equal(call('init',dir).status,0);
  const external=join(other,'outside.py');
  writeFileSync(external,readFileSync(join(dir,'fixture.py'),'utf8'));
  unlinkSync(join(dir,'fixture.py'));symlinkSync(external,join(dir,'fixture.py'));
  const r=call('observe-failure',dir);
  assert.notEqual(r.status,0);
  assert.equal(parse(join(dir,'job.json')).state,'QUEUED');
  assert.match(readFileSync(external,'utf8'),/return a - b/);
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(other,{recursive:true,force:true})}
});

test('rejects a swapped symlink before repaired code write',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-continuation-'));
 const other=mkdtempSync(join(tmpdir(),'hq-target-'));
 try{
  assert.equal(call('init',dir).status,0);
  assert.equal(call('observe-failure',dir).status,0);
  const external=join(other,'outside.py');
  writeFileSync(external,readFileSync(join(dir,'fixture.py'),'utf8'));
  unlinkSync(join(dir,'fixture.py'));symlinkSync(external,join(dir,'fixture.py'));
  const r=call('resume',dir);
  assert.notEqual(r.status,0);
  assert.equal(parse(join(dir,'job.json')).state,'RUNNING');
  assert.match(readFileSync(external,'utf8'),/return a - b/);
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(other,{recursive:true,force:true})}
});
