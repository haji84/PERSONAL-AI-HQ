#!/usr/bin/env node
// Bounded, synthetic-only proof. NOT an AI builder, independent AI reviewer or GitHub writer.
import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync,realpathSync,existsSync,lstatSync,renameSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {initialJob,transition,saveNew,loadJob,saveRevision} from './job-state.mjs';
const sha256=s=>createHash('sha256').update(s).digest('hex');
const SEED='def add(a, b):\n    return a - b\n';
const REPAIRED='def add(a, b):\n    return a + b\n';
const ID='synthetic-cycle-v1';
const CASES=[[1,2,3],[0,0,0],[-5,2,-3],[5,-7,-2],[-4,-6,-10],[9,9,18]];
const TESTER=['import json,runpy,sys',"f=runpy.run_path(sys.argv[1])['add']",'cases=json.loads(sys.argv[2])','failures=[]','for a,b,want in cases:',' try:','  got=f(a,b)','  if got!=want: failures.append([a,b,want,got])',' except Exception as e: failures.append([a,b,want,type(e).__name__])',"print(json.dumps({'cases':len(cases),'failedCases':len(failures),'failures':failures}))",'sys.exit(1 if failures else 0)'].join('\n')+'\n';
function testFixture(root){
 const r=spawnSync('python3',['-I','-c',TESTER,join(root,'fixture.py'),JSON.stringify(CASES)],{encoding:'utf8',timeout:5000,maxBuffer:10240});
 if(r.error || r.signal || ![0,1].includes(r.status))throw Error('Bounded synthetic tester unavailable');
 let data;try{data=JSON.parse(r.stdout)}catch{throw Error('Invalid test output')}
 if(data.cases!==6||!Number.isInteger(data.failedCases)||data.failedCases<0||data.failedCases>6)throw Error('Invalid test evidence');
 return {exit:r.status,passedCases:6-data.failedCases,failedCases:data.failedCases,outputSha256:sha256(r.stdout)};
}
function requireScratch(root){
 const real=realpathSync(resolve(root)); const temporary=realpathSync(tmpdir());
 if(!real.startsWith(temporary+sep))throw Error('Synthetic test requires scratch directory');
 return real;
}
function locked(root,fn){
 const f=join(root,'.continuation.lock');const fd=openSync(f,'wx',0o600);
 try{return fn()}finally{closeSync(fd);unlinkSync(f)}
}
function receipt(file,value){const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2))}finally{closeSync(fd)}}
function json(file){return JSON.parse(readFileSync(file,'utf8'))}
function assertSafeSource(root){
 const source=join(root,'fixture.py');const info=lstatSync(source);
 if(!info.isFile()||info.isSymbolicLink())throw Error('Unsafe synthetic fixture source');
 return source;
}
function replaceFixture(root){
 const source=assertSafeSource(root),tmp=join(root,'fixture.repaired.tmp');
 const fd=openSync(tmp,'wx',0o600);
 try{writeFileSync(fd,REPAIRED)}finally{closeSync(fd)}
 renameSync(tmp,source);
}
function receiptOnce(file,value){
 if(!existsSync(file)){receipt(file,value);return}
 if(JSON.stringify(json(file))!==JSON.stringify(value))throw Error('Conflicting persisted evidence');
}
function verifyPass(root,job){
 const source=readFileSync(assertSafeSource(root),'utf8');
 if(source!==REPAIRED)throw Error('Unverified repaired source');
 const observed=testFixture(root);
 if(observed.exit!==0||observed.failedCases!==0)throw Error('Repaired tests not passing');
 const evidence={kind:'observed-test-pass',sourceSha256:sha256(source),baseSha:job.baseSha,passedCases:observed.passedCases,outputSha256:observed.outputSha256,implementation:'scripted-synthetic-repair-not-model'};
 receiptOnce(join(root,'pass.json'),evidence);
 return evidence;
}
function execute(operation,root){
 const jobfile=join(root,'job.json'),source=join(root,'fixture.py');
 if(operation==='init'){
  const job=initialJob({id:ID,goal:'Repair synthetic arithmetic with measured tests',acceptance:['six immutable cases pass','distinct model review'],baseSha:sha256(SEED)});
  saveNew(jobfile,job);writeFileSync(source,SEED,{flag:'wx',mode:0o600});
  return {phase:'init',state:job.state};
 }
 let job=loadJob(jobfile);
 if(operation==='observe-failure'){
  if(job.state!=='QUEUED')throw Error('Duplicate or illegal initial attempt');
  assertSafeSource(root);if(sha256(readFileSync(source,'utf8'))!==job.baseSha)throw Error('Seed SHA mismatch');
  const observed=testFixture(root);if(observed.exit!==1||observed.failedCases===0)throw Error('Expected failing tests not observed');
  receiptOnce(join(root,'failure.json'),{kind:'observed-test-failure',sourceSha256:job.baseSha,...observed});
  const next=transition(job,'RUNNING',{expectedRevision:job.revision,reason:'failure-observed',attemptId:'synthetic-attempt-1'});
  saveRevision(jobfile,job,next);return {phase:'observed',state:next.state,failedCases:observed.failedCases};
 }
 if(operation==='resume'){
  if(job.state==='BLOCKED')return {phase:'resumed',state:'BLOCKED',reason:'independent-model-review-unavailable'};
  if(job.state==='VERIFYING'){
   verifyPass(root,job);
   const next=transition(job,'BLOCKED',{expectedRevision:job.revision,reason:'independent-model-review-unavailable'});
   saveRevision(jobfile,job,next);return {phase:'resumed',state:next.state,revision:next.revision};
  }
  if(job.state!=='RUNNING')throw Error('Missing observed failed state');
  const failure=json(join(root,'failure.json'));
  if(failure.kind!=='observed-test-failure'||failure.sourceSha256!==job.baseSha||failure.failedCases===0||failure.exit!==1)throw Error('Unverified prior failure');
  const current=readFileSync(assertSafeSource(root),'utf8');
  if(current!==SEED && current!==REPAIRED)throw Error('Unauthorized source mutation');
  if(current===SEED)replaceFixture(root);
  const evidence=verifyPass(root,job);
  const sourceSha256=evidence.sourceSha256;
  let next=transition(job,'VERIFYING',{expectedRevision:job.revision,reason:'real-tests-passed-scripted-synthetic',evidence});
  saveRevision(jobfile,job,next);job=next;
  next=transition(job,'BLOCKED',{expectedRevision:job.revision,reason:'independent-model-review-unavailable'});
  saveRevision(jobfile,job,next);
  return {phase:'resumed',state:next.state,revision:next.revision,sourceSha256};
 }
 if(operation==='status')return {phase:'status',state:job.state,revision:job.revision};
 throw Error('Unsupported operation');
}
try{
 const [operation,rootarg]=process.argv.slice(2);
 if(!['init','observe-failure','resume','status'].includes(operation)||!rootarg)throw Error('Usage: synthetic-continuation <init|observe-failure|resume|status> <existing-scratch-root>');
 const root=requireScratch(rootarg);const result=locked(root,()=>execute(operation,root));
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(e){process.stderr.write('SAFE_STOP: '+e.message+'\n');process.exitCode=2}
