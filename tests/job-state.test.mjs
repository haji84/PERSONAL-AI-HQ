import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialJob,transition,saveNew,saveRevision,loadJob} from '../scripts/job-state.mjs';
const make=()=>initialJob({id:'demo-1',goal:'Synthetic task',acceptance:['test passes'],baseSha:'abc123'});
test('durable restart resumes exact state and event history',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-state-'));const file=join(dir,'state.json');
 try{const a=make();saveNew(file,a);const b=transition(a,'RUNNING',{expectedRevision:0,reason:'test start',attemptId:'attempt-1'});saveRevision(file,a,b);assert.deepEqual(loadJob(file),b);assert.equal(loadJob(file).attempts.length,1)}finally{rmSync(dir,{recursive:true,force:true})}
});
test('stale revision and duplicate create rejected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hq-state-'));const file=join(dir,'state.json');
 try{const a=make();saveNew(file,a);assert.throws(()=>saveNew(file,a));const b=transition(a,'RUNNING',{expectedRevision:0,reason:'start'});saveRevision(file,a,b);assert.throws(()=>saveRevision(file,a,b));assert.throws(()=>transition(b,'VERIFYING',{expectedRevision:0,reason:'stale'}))}finally{rmSync(dir,{recursive:true,force:true})}
});
test('cannot mark DONE without verified matching SHA',()=>{
 const a=make();const b=transition(a,'RUNNING',{expectedRevision:0,reason:'start'});const c=transition(b,'VERIFYING',{expectedRevision:1,reason:'tests'});
 assert.throws(()=>transition(c,'DONE',{expectedRevision:2,reason:'claim'}));
 assert.throws(()=>transition(c,'DONE',{expectedRevision:2,reason:'wrong',evidence:{kind:'MACHINE_VERIFIED',sourceSha:'other'}}));
 assert.equal(transition(c,'DONE',{expectedRevision:2,reason:'verified',evidence:{kind:'MACHINE_VERIFIED',sourceSha:'abc123'}}).state,'DONE');
});
