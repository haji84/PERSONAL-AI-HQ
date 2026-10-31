import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
const scriptPath=new URL('./fixtures/state-authority-local-worker.mjs',import.meta.url).pathname;
const schemaPath=new URL('../workers/state-authority/schema.sql',import.meta.url);
const claim={jobId:'job',idempotencyKey:'claim',expectedRevision:0,expectedEpoch:0,ttlMs:300000};
async function runtime(t,{persist,initialize=true}={}){
 const mf=new Miniflare({cf:false,host:'127.0.0.1',modules:true,scriptPath,compatibilityDate:'2026-07-30',d1Databases:{HQ_STATE:'synthetic-test'},...(persist?{d1Persist:persist}:{})});let closed=false;const close=async()=>{if(!closed){closed=true;await mf.dispose()}};t.after(close);
 const send=async(path,body,headers={})=>{const r=await mf.dispatchFetch('https://local/'+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 const sql=async(sql,params=[])=>send('__test/sql',{sql,params});
 if(initialize)await mf.dispatchFetch('https://local/__test/schema',{method:'POST',body:await readFile(schemaPath,'utf8')});
 return {send,sql,mf,close};
}
test('actual local D1 creates one fenced claim and exact retry receipt',async t=>{
 const {send,sql}=await runtime(t);
 const a=await send('v1/claim',claim);assert.equal(a.status,200);assert.equal(a.body.revision,1);assert.equal(a.body.epoch,1);
 assert.deepEqual(await send('v1/claim',claim),a);
 const rows=await sql('SELECT COUNT(*) AS n FROM hq_events');assert.equal(rows.body.results[0].n,1);
});
test('actual local D1 contention and mismatched idempotency races fail closed',async t=>{
 const {send,sql}=await runtime(t);
 const results=await Promise.all([send('v1/claim',claim),send('v1/claim',{...claim,ttlMs:1000},{'x-test-execution':'run-2'})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await sql('SELECT COUNT(*) AS n FROM hq_events')).body.results[0].n,1);
 assert.equal((await sql('SELECT COUNT(*) AS n FROM hq_receipts')).body.results[0].n,1);
});
test('actual local D1 rejects stale writes with no receipt/event mutation',async t=>{
 const {send,sql}=await runtime(t);await send('v1/claim',claim);
 const c={jobId:'job',idempotencyKey:'commit',expectedRevision:1,expectedEpoch:1,state:'RUNNING'};
 assert.equal((await send('v1/commit',c,{'x-test-execution':'other'})).status,409);
 assert.equal((await send('v1/commit',{...c,expectedRevision:0})).status,409);
 await sql('UPDATE hq_jobs SET expires_ms=0');
 assert.equal((await send('v1/commit',c)).status,409);
 assert.equal((await sql('SELECT COUNT(*) AS n FROM hq_events')).body.results[0].n,1);
});
test('actual local D1 preserves state across release/reclaim and never exits approval',async t=>{
 const {send}=await runtime(t);await send('v1/claim',claim);
 assert.equal((await send('v1/commit',{jobId:'job',idempotencyKey:'wait',expectedRevision:1,expectedEpoch:1,state:'AWAITING_APPROVAL'})).status,200);
 assert.equal((await send('v1/commit',{jobId:'job',idempotencyKey:'bypass',expectedRevision:2,expectedEpoch:1,state:'QUEUED'})).status,409);
 const released=await send('v1/release',{jobId:'job',idempotencyKey:'release',expectedRevision:2,expectedEpoch:1});assert.equal(released.status,200);
 const reclaimed=await send('v1/claim',{...claim,idempotencyKey:'reclaim',expectedRevision:3,expectedEpoch:1},{'x-test-execution':'run-2'});
 assert.equal(reclaimed.status,200);assert.equal(reclaimed.body.state,'AWAITING_APPROVAL');assert.equal(reclaimed.body.epoch,2);
});
test('actual local D1 rolls back state and event when dependent receipt fails',async t=>{
 const {send,sql}=await runtime(t);
 await sql("CREATE TRIGGER reject_receipt BEFORE INSERT ON hq_receipts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.equal((await send('v1/claim',claim)).status,503);
 for(const table of ['hq_jobs','hq_events','hq_receipts'])assert.equal((await sql(`SELECT COUNT(*) AS n FROM ${table}`)).body.results[0].n,0);
});
test('actual local D1 recovers lost response and reports genuinely unknown failure',async t=>{
 const {send,sql}=await runtime(t);
 assert.equal((await send('v1/claim',claim,{'x-test-fault':'before'})).status,503);
 const a=await send('v1/claim',claim,{'x-test-fault':'after'});assert.equal(a.status,200);
 assert.deepEqual(await send('v1/claim',claim),a);
 assert.equal((await sql('SELECT COUNT(*) AS n FROM hq_events')).body.results[0].n,1);
});
test('actual local D1 same-key races independently cover changed body and principal',async t=>{
 const {send,sql}=await runtime(t);
 for(const variant of ['body','principal','same']){
  const c={...claim,jobId:variant};
  const results=await Promise.all([send('v1/claim',c,{'x-test-barrier':variant}),send('v1/claim',variant==='body'?{...c,ttlMs:1000}:c,{'x-test-barrier':variant,...(variant==='principal'?{'x-test-subject':'other'}:{})})]);
  assert.deepEqual(results.map(r=>r.status).sort(),variant==='same'?[200,200]:[200,409]);
 }
 assert.equal((await sql('SELECT COUNT(*) AS n FROM hq_events')).body.results[0].n,3);
});
test('actual local D1 expiry equality, renewal and exhausted counters fail safely',async t=>{
 const {send,sql}=await runtime(t);const first=await send('v1/claim',claim);
 const renewed=await send('v1/renew',{...claim,idempotencyKey:'renew',expectedRevision:1,expectedEpoch:1,ttlMs:1000});assert.equal(renewed.status,200);assert.ok(renewed.body.expiresMs>=first.body.expiresMs);
 await sql("UPDATE hq_jobs SET expires_ms=CAST(strftime('%s','now') AS INTEGER)*1000");
 assert.equal((await send('v1/renew',{...claim,idempotencyKey:'late',expectedRevision:2,expectedEpoch:1})).status,409);
 const reacquire=await send('v1/claim',{...claim,idempotencyKey:'new',expectedRevision:2,expectedEpoch:1});assert.equal(reacquire.status,200);assert.equal(reacquire.body.epoch,2);
 await sql('UPDATE hq_jobs SET revision=9007199254740991,epoch=9007199254740991,expires_ms=0');
 assert.equal((await send('v1/claim',{...claim,idempotencyKey:'overflow',expectedRevision:Number.MAX_SAFE_INTEGER,expectedEpoch:Number.MAX_SAFE_INTEGER})).status,409);
});
test('actual local D1 restart retains state and historical receipt without renewing lease',async t=>{
 const persist=await mkdtemp(join(tmpdir(),'hq-d1-test-'));t.after(()=>rm(persist,{recursive:true,force:true}));
 const one=await runtime(t,{persist});const receipt=await one.send('v1/claim',claim);
 await one.send('v1/commit',{jobId:'job',idempotencyKey:'work',expectedRevision:1,expectedEpoch:1,state:'RUNNING'});
 await one.close();
 const two=await runtime(t,{persist,initialize:false});assert.deepEqual(await two.send('v1/claim',claim),receipt);
 const inspect=await two.send('v1/inspect',{jobId:'job'});assert.equal(inspect.body.job.revision,2);assert.equal(inspect.body.job.state,'RUNNING');
 assert.equal((await two.send('v1/claim',claim,{'x-test-execution':'new-run'})).status,409);
 await two.sql('UPDATE hq_jobs SET expires_ms=0');
 const reclaimed=await two.send('v1/claim',{...claim,idempotencyKey:'new-run',expectedRevision:2,expectedEpoch:1},{'x-test-execution':'new-run'});assert.equal(reclaimed.body.epoch,2);
 assert.equal((await two.send('v1/release',{jobId:'job',idempotencyKey:'stale',expectedRevision:3,expectedEpoch:1})).status,409);
});
test('actual local D1 inspect caps event metadata and rejects cross-scope access',async t=>{
 const {send,sql}=await runtime(t);await send('v1/claim',claim);
 await sql("WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<55) INSERT INTO hq_events SELECT 'synthetic/hq','goal-1','job',x,'renew','QUEUED',1,0,NULL FROM n");
 const result=await send('v1/inspect',{jobId:'job'});assert.equal(result.body.events.length,50);assert.equal(result.body.truncated,true);
 assert.equal((await send('v1/inspect',{jobId:'job',goal:'other'})).status,400);
});
test('actual local D1 rejects millisecond-expired lease within the same second',async t=>{
 const {send,sql}=await runtime(t);await send('v1/claim',{...claim,ttlMs:1001});
 // Select a stable mid-second window so the regression cannot hide behind rounding.
 for(let attempt=0;attempt<100;attempt++){
  const now=(await sql("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now")).body.results[0].now;
  assert.ok(Number.isSafeInteger(now));
  if(now%1000>=200&&now%1000<700)break;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 await sql("UPDATE hq_jobs SET expires_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)-1");
 assert.equal((await send('v1/renew',{...claim,idempotencyKey:'expired-ms',expectedRevision:1,expectedEpoch:1})).status,409);
 assert.equal((await sql('SELECT COUNT(*) AS n FROM hq_events')).body.results[0].n,1);
 assert.equal((await sql('SELECT COUNT(*) AS n FROM hq_receipts')).body.results[0].n,1);
 assert.equal((await sql('SELECT revision FROM hq_jobs')).body.results[0].revision,1);
});
test('actual local D1 invalid transitions do not update counters events or receipts',async t=>{
 const {send,sql}=await runtime(t);await send('v1/claim',claim);
 for(const state of ['VERIFYING','QUEUED','DONE']){
  const result=await send('v1/commit',{jobId:'job',idempotencyKey:'invalid-'+state,expectedRevision:1,expectedEpoch:1,state});
  assert.equal(result.status,state==='DONE'?400:409);
 }
 assert.equal((await sql('SELECT revision FROM hq_jobs')).body.results[0].revision,1);
 for(const table of ['hq_events','hq_receipts'])assert.equal((await sql(`SELECT COUNT(*) AS n FROM ${table}`)).body.results[0].n,1);
});
test('actual local D1 repository and goal keys isolate identical job and receipt IDs',async t=>{
 const {send,sql}=await runtime(t);await send('v1/claim',claim);
 for(const [repository,goal] of [['other/hq','goal-1'],['synthetic/hq','other-goal']]){
  await sql("INSERT INTO hq_jobs SELECT ?,?,job_id,state,revision,epoch,holder,expires_ms,mutation_ms,last_operation FROM hq_jobs WHERE repository='synthetic/hq' AND goal='goal-1'",[repository,goal]);
  await sql("INSERT INTO hq_events SELECT ?,?,job_id,revision,operation,state,epoch,mutation_ms,evidence_digest FROM hq_events WHERE repository='synthetic/hq' AND goal='goal-1'",[repository,goal]);
  await sql("INSERT INTO hq_receipts SELECT ?,?,job_id,idempotency_key,principal,request_digest,result_json FROM hq_receipts WHERE repository='synthetic/hq' AND goal='goal-1'",[repository,goal]);
 }
 const snapshots={};for(const table of ['hq_jobs','hq_events','hq_receipts'])snapshots[table]=(await sql(`SELECT * FROM ${table} WHERE repository!='synthetic/hq' OR goal!='goal-1' ORDER BY repository,goal`)).body.results;
 assert.equal((await send('v1/commit',{jobId:'job',idempotencyKey:'work',expectedRevision:1,expectedEpoch:1,state:'RUNNING'})).status,200);
 assert.equal((await send('v1/inspect',{jobId:'job'})).body.job.state,'RUNNING');
 for(const table of ['hq_jobs','hq_events','hq_receipts'])assert.deepEqual((await sql(`SELECT * FROM ${table} WHERE repository!='synthetic/hq' OR goal!='goal-1' ORDER BY repository,goal`)).body.results,snapshots[table]);
});
test('actual local D1 renew release and reclaim preserve every existing task state',async t=>{
 const {send,sql}=await runtime(t);
 for(const state of ['RUNNING','VERIFYING','BLOCKED','AWAITING_APPROVAL']){
  const c={...claim,jobId:state};await send('v1/claim',c);await sql('UPDATE hq_jobs SET state=? WHERE job_id=?',[state,state]);
  const renew=await send('v1/renew',{...c,idempotencyKey:'renew',expectedRevision:1,expectedEpoch:1});assert.equal(renew.body.state,state);
  const release=await send('v1/release',{jobId:state,idempotencyKey:'release',expectedRevision:2,expectedEpoch:1});assert.equal(release.body.state,state);
  const reacquire=await send('v1/claim',{...c,idempotencyKey:'next',expectedRevision:3,expectedEpoch:1},{'x-test-execution':'next-run'});assert.equal(reacquire.body.state,state);assert.equal(reacquire.body.epoch,2);
 }
});
