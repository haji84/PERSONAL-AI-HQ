// Local-only durable continuation for a bounded public synthetic model probe.
// The injected seam is for tests; it is NEVER independent model execution proof.
import {realpathSync,lstatSync,existsSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync,fsyncSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadJob,transition,saveRevision} from './job-state.mjs';
import {SEEDED_SOURCE} from './local-builder-adapter.mjs';
import {runVerifiedCachedCycle} from './model-cycle-bridge.mjs';
const SHA40=/^[a-f0-9]{40}$/;
const digest=s=>createHash('sha256').update(s).digest('hex');
const allowedReasons=new Set(['builder-not-verified','builder-model-not-proven','review-source-unverified',
 'model-execution-unverified','review-inconclusive','independent-review-advisory-only',
 'independent-model-review-unverified']);
function scratch(path){
 if(typeof path!=='string')throw Error('Invalid scratch directory');
 const actual=realpathSync(resolve(path)),temporary=realpathSync(tmpdir());
 if(!actual.startsWith(temporary+sep)||lstatSync(path).isSymbolicLink())
  throw Error('Synthetic scratch boundary mismatch');
 return actual;
}
function safeText(path){
 const st=lstatSync(path);
 if(!st.isFile()||st.isSymbolicLink())throw Error('Unsafe synthetic file');
 return readFileSync(path,'utf8');
}
function newReceipt(path,value){
 const fd=openSync(path,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd)}finally{closeSync(fd)}
}
function block(root,job,reason){
 const next=transition(job,'BLOCKED',{expectedRevision:job.revision,reason});
 saveRevision(join(root,'job.json'),job,next);
 return {state:'BLOCKED',reason,nextTaskDispatched:false,releaseAuthorized:false,modelExecuted:false};
}
export async function continueModelCycle({root,baseSha,bridge}={}){
 if(!SHA40.test(baseSha??'')||typeof bridge!=='function')throw Error('Invalid bridge request');
 const dir=scratch(root),jobfile=join(dir,'job.json'),job=loadJob(jobfile);
 if(job.id!=='synthetic-cycle-v1'||job.baseSha!==digest(SEEDED_SOURCE))throw Error('Invalid stored synthetic job');
 if(job.state==='BLOCKED')return {state:'BLOCKED',reason:'already-blocked',nextTaskDispatched:false,releaseAuthorized:false,modelExecuted:false};
 if(job.state!=='RUNNING'||job.revision!==1)throw Error('Synthetic failed-test state required');
 if(safeText(join(dir,'fixture.py'))!==SEEDED_SOURCE)throw Error('Synthetic source mismatch');
 const fail=JSON.parse(safeText(join(dir,'failure.json')));
 if(fail.kind!=='observed-test-failure'||fail.sourceSha256!==job.baseSha||fail.exit!==1||
   !Number.isInteger(fail.failedCases)||fail.failedCases<=0)throw Error('Unverified test failure receipt');
 const intentFile=join(dir,'model-cycle-intent.json'),resultFile=join(dir,'model-cycle-result.json');
 if(existsSync(intentFile)){
  const intent=JSON.parse(safeText(intentFile));
  if(intent.baseSha!==baseSha||intent.jobRevision!==job.revision)throw Error('Model attempt identity mismatch');
  if(existsSync(resultFile)){
   const recorded=JSON.parse(safeText(resultFile));
   if(recorded.baseSha!==baseSha||recorded.reviewGate!=='NOT_AUTHORIZED')throw Error('Model result identity mismatch');
   return block(dir,job,'resume-after-recorded-model-attempt');
  }
  return block(dir,job,'incomplete-model-attempt-no-auto-retry');
 }
 // Intent is durable before any model invocation. A crash must not silently charge/retry.
 newReceipt(intentFile,{schema:1,baseSha,jobRevision:job.revision,sourceSha256:job.baseSha});
 let result;
 try{result=await bridge({baseSha})}
 catch{result={reason:'model-bridge-failed'}}
 const reason=allowedReasons.has(result?.reason)?result.reason:'model-bridge-failed';
 newReceipt(resultFile,{schema:1,baseSha,sourceSha256:job.baseSha,reviewGate:'NOT_AUTHORIZED',
  sourceKind:'injected-bridge-not-independent-proof',reason,
  builderClaimedObserved:result?.builder?.modelExecuted===true,
  reviewerClaimedObserved:result?.reviewer?.modelExecuted===true,
  releaseAuthorized:false,nextTaskDispatched:false});
 return block(dir,job,'model-cycle-advisory-only');
}
export async function continueVerifiedCachedModels({root,baseSha,builderArtifacts,reviewerArtifacts}={}){
 return continueModelCycle({root,baseSha,
  bridge:()=>runVerifiedCachedCycle({baseSha,builderArtifacts,reviewerArtifacts})});
}
