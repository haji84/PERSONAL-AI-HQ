import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const head=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
let api;try{api=await import('../scripts/model-cycle-state.mjs')}catch{}
const runner=new URL('../scripts/synthetic-continuation.mjs',import.meta.url).pathname;
function localRun(operation,dir){return spawnSync(process.execPath,[runner,operation,dir],{encoding:'utf8',timeout:15000});}
async function workspace(fn){
 const dir=mkdtempSync(join(tmpdir(),'hq-model-cycle-'));
 try{
  assert.equal(localRun('init',dir).status,0);
  assert.equal(localRun('observe-failure',dir).status,0);
  return await fn(dir);
 }finally{rmSync(dir,{force:true,recursive:true})}
}
function stored(dir){return JSON.parse(readFileSync(join(dir,'job.json'),'utf8'))}
const fake=async()=>({state:'BLOCKED',reason:'model-execution-unverified',builder:{modelExecuted:false},reviewer:{modelExecuted:false},releaseAuthorized:false,nextTaskDispatched:false});

test('model-cycle state adapter exists and supports local cached-only wiring',()=>{
 assert.equal(typeof api?.continueModelCycle,'function');
 assert.equal(typeof api?.continueVerifiedCachedModels,'function');
});
test('after real observed failing tests, a mock bridge records receipt but cannot mark DONE',async()=>{
 await workspace(async dir=>{
  let calls=0;
  const r=await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{calls++;return fake()}});
  assert.equal(calls,1);
  assert.equal(r.state,'BLOCKED');
  const j=stored(dir);
  assert.equal(j.state,'BLOCKED');
  assert.equal(j.revision,2);
  assert.equal(j.attempts.length,1);
  const receipt=JSON.parse(readFileSync(join(dir,'model-cycle-result.json'),'utf8'));
  assert.equal(receipt.reviewGate,'NOT_AUTHORIZED');
  assert.equal(receipt.sourceKind,'injected-bridge-not-independent-proof');
  await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{calls++;return fake()}});
  assert.equal(calls,1);
 });
});
test('crash intent without a model receipt fails closed without calling the model again',async()=>{
 await workspace(async dir=>{
  writeFileSync(join(dir,'model-cycle-intent.json'),JSON.stringify({baseSha:head,jobRevision:1}));
  let invoked=false;
  const r=await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{invoked=true;return fake()}});
  assert.equal(invoked,false);
  assert.equal(r.state,'BLOCKED');
  assert.match(stored(dir).events.at(-1).reason,/incomplete-model-attempt/);
 });
});
test('a bridge exception never authorizes release or prints model raw output',async()=>{
 await workspace(async dir=>{
  const r=await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{throw Error('synthetic-sensitive-sentinel')}});
  assert.equal(r.state,'BLOCKED');
  const content=readFileSync(join(dir,'model-cycle-result.json'),'utf8');
  assert.doesNotMatch(content,/synthetic-sensitive-sentinel/);
  assert.equal(stored(dir).state,'BLOCKED');
 });
});
test('wrong job SHA blocks before invoking any model',async()=>{
 await workspace(async dir=>{
  let calls=0;
  await assert.rejects(api.continueModelCycle({root:dir,baseSha:'0'.repeat(40),bridge:async()=>{calls++;return fake()}}),/invalid|mismatch/i);
  assert.equal(calls,0);
 });
});

test('model receipts expose only bounded source identity and review stage, not raw model text',async()=>{
 await workspace(async dir=>{
  const r=await api.continueModelCycle({root:dir,baseSha:head,
   bridge:async()=>({state:'BLOCKED',reason:'review-source-unverified',
     builder:{modelExecuted:true,sourceSha256:'b'.repeat(64),rawResponse:'PRIVATE_MODEL_OUTPUT_SENTINEL'},
     reviewer:{modelExecuted:false,status:'NOT_RUN'},releaseAuthorized:false})});
  assert.equal(r.state,'BLOCKED');
  const raw=readFileSync(join(dir,'model-cycle-result.json'),'utf8');
  const receipt=JSON.parse(raw);
  assert.equal(receipt.builderSourceSha256,'b'.repeat(64));
  assert.equal(receipt.reviewerStatus,'NOT_RUN');
  assert.equal(receipt.reason,'review-source-unverified');
  assert.doesNotMatch(raw,/PRIVATE_MODEL_OUTPUT_SENTINEL/);
 });
});

test('failed retest diagnostics survive persisted restart without leaking raw source or error',async()=>{
 await workspace(async dir=>{
  const r=await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>({
   state:'BLOCKED',reason:'builder-not-verified',
   builder:{modelExecuted:false,retestDiagnostic:{outcome:'ASSERTION_FAILURE',caseId:'case-1',
    observedCaseCount:null,rawSource:'PRIVATE_SOURCE',rawFailure:'PRIVATE_FAILURE'}},
   reviewer:{status:'NOT_RUN',modelExecuted:false},releaseAuthorized:false
  })});
  assert.equal(r.state,'BLOCKED');
  const filename=join(dir,'model-cycle-result.json');
  const raw=readFileSync(filename,'utf8'),saved=JSON.parse(raw);
  assert.deepEqual(saved.builderRetestDiagnostic,
   {outcome:'ASSERTION_FAILURE',caseId:'case-1',observedCaseCount:null});
  assert.doesNotMatch(raw,/PRIVATE_SOURCE|PRIVATE_FAILURE|rawFailure|rawSource/);
  let calls=0;
  await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{calls++;throw Error('MUST_NOT_RETRY')}});
  assert.equal(calls,0);
  assert.deepEqual(JSON.parse(readFileSync(filename,'utf8')).builderRetestDiagnostic,saved.builderRetestDiagnostic);
 });
});

test('model-cycle persistence rejects untrusted retest labels and fabricated zero-case counts',async()=>{
 await workspace(async dir=>{
  await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>({
   reason:'builder-not-verified',
   builder:{modelExecuted:false,retestDiagnostic:{outcome:'PRIVATE_KIND',caseId:'case-99',
    observedCaseCount:0,failedAssertion:'PRIVATE_ASSERTION'}},
   reviewer:{status:'NOT_RUN',modelExecuted:false}
  })});
  const saved=readFileSync(join(dir,'model-cycle-result.json'),'utf8');
  assert.deepEqual(JSON.parse(saved).builderRetestDiagnostic,
   {outcome:'UNVERIFIED',caseId:null,observedCaseCount:null});
  assert.doesNotMatch(saved,/PRIVATE_KIND|PRIVATE_ASSERTION|case-99|failedAssertion/);
 });
});

test('persisted retest report preserves only recognized safety rejection code',async()=>{
 await workspace(async dir=>{
  await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>({
   reason:'builder-not-verified',
   builder:{modelExecuted:false,retestDiagnostic:{outcome:'SAFETY_REJECTED',caseId:null,
    observedCaseCount:null,rejectCode:'FUNCTION_SHAPE',privateText:'PRIVATE_MODEL_OUTPUT'}},
   reviewer:{status:'NOT_RUN',modelExecuted:false}
  })});
  const file=join(dir,'model-cycle-result.json');
  const raw=readFileSync(file,'utf8');
  assert.deepEqual(JSON.parse(raw).builderRetestDiagnostic,
   {outcome:'SAFETY_REJECTED',caseId:null,observedCaseCount:null,rejectCode:'FUNCTION_SHAPE'});
  assert.doesNotMatch(raw,/PRIVATE_MODEL_OUTPUT|privateText/);
  await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{throw Error('MUST_NOT_RETRY')}});
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).builderRetestDiagnostic,
   {outcome:'SAFETY_REJECTED',caseId:null,observedCaseCount:null,rejectCode:'FUNCTION_SHAPE'});
 });
 await workspace(async dir=>{
  await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>({
   reason:'builder-not-verified',
   builder:{retestDiagnostic:{outcome:'SAFETY_REJECTED',caseId:null,
    observedCaseCount:0,rejectCode:'PRIVATE_UNTRUSTED_CODE'}},
   reviewer:{status:'NOT_RUN'}
  })});
  const raw=readFileSync(join(dir,'model-cycle-result.json'),'utf8');
  assert.deepEqual(JSON.parse(raw).builderRetestDiagnostic,
   {outcome:'SAFETY_REJECTED',caseId:null,observedCaseCount:null});
  assert.doesNotMatch(raw,/PRIVATE_UNTRUSTED_CODE/);
 });
});

test('model state persists only a boolean AST no-op signal and never claims reviewer proof',async()=>{
 await workspace(async dir=>{
  let calls=0;
  const result=await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{
   calls++;
   return {state:'BLOCKED',reason:'builder-not-verified',
    builder:{semanticNoOp:true,modelExecuted:false,rawSource:'PRIVATE_OUTPUT'},
    reviewer:{status:'NOT_RUN',modelExecuted:false},
    releaseAuthorized:false,nextTaskDispatched:false};
  }});
  assert.equal(result.state,'BLOCKED');
  const raw=readFileSync(join(dir,'model-cycle-result.json'),'utf8');
  const saved=JSON.parse(raw);
  assert.equal(saved.builderSemanticNoOp,true);
  assert.equal(saved.reviewerStatus,'NOT_RUN');
  assert.equal(saved.releaseAuthorized,false);
  assert.equal(saved.nextTaskDispatched,false);
  assert.doesNotMatch(raw,/PRIVATE_OUTPUT/);
  await api.continueModelCycle({root:dir,baseSha:head,bridge:async()=>{calls++;throw Error('MUST_NOT_RUN')}});
  assert.equal(calls,1);
 });
});
