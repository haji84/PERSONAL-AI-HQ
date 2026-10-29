// Local-only durable continuation. Checkpoint integrity is not security/release approval.
import {realpathSync,lstatSync,existsSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync,fsyncSync,fstatSync,constants} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadJob,transition,saveRevision} from './job-state.mjs';
import {SEEDED_SOURCE} from './local-builder-adapter.mjs';
import {runVerifiedCachedCycle} from './model-cycle-bridge.mjs';
import {saveReviewCheckpoint,loadReviewCheckpoint} from './review-checkpoint.mjs';
const SHA40=/^[a-f0-9]{40}$/,HASH64=/^[a-f0-9]{64}$/;
const digest=s=>createHash('sha256').update(s).digest('hex');
const safeReviewStatus=new Set(['NOT_RUN','ADVISORY_AGREEMENT','INCONCLUSIVE','FAILED','SKIPPED']);
const allowedReasons=new Set(['builder-not-verified','builder-model-not-proven','review-source-unverified',
 'model-execution-unverified','review-inconclusive','independent-review-advisory-only','independent-model-review-unverified']);
function scratch(path){
 if(typeof path!=='string')throw Error('Invalid scratch directory');
 const actual=realpathSync(resolve(path)),temporary=realpathSync(tmpdir());
 if(!actual.startsWith(temporary+sep)||lstatSync(path).isSymbolicLink())throw Error('Synthetic scratch boundary mismatch');
 return actual;
}
function safeText(path){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=fstatSync(fd);if(!s.isFile()||s.size>65536)throw Error('Unsafe synthetic file');
  return new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(fd));
 }finally{closeSync(fd)}
}
function newReceipt(path,value){
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd)}finally{closeSync(fd)}
}
function block(root,job,reason,checkpointSha256=null){
 const evidence=checkpointSha256?{kind:'LOCAL_REVIEW_CHECKPOINT',checkpointSha256,authority:'none'}:null;
 const next=transition(job,'BLOCKED',{expectedRevision:job.revision,reason,evidence});
 saveRevision(join(root,'job.json'),job,next);
 return {state:'BLOCKED',reason,nextTaskDispatched:false,releaseAuthorized:false,modelExecuted:false,
  checkpointVerified:checkpointSha256!==null};
}
function verifiedSavedResult(dir,baseSha){
 const path=join(dir,'model-cycle-result.json');
 if(!existsSync(path))return null;
 const recorded=JSON.parse(safeText(path));
 if(recorded.schema!==1||recorded.baseSha!==baseSha||recorded.reviewGate!=='NOT_AUTHORIZED'||
    recorded.releaseAuthorized!==false||recorded.nextTaskDispatched!==false)throw Error('Model result identity mismatch');
 if('reviewCheckpointSha256' in recorded){
  const checkpoint=loadReviewCheckpoint(join(dir,'review-checkpoint.json'),{baseSha,expectedDigest:recorded.reviewCheckpointSha256});
  if(checkpoint.review.sourceSha256!==recorded.builderSourceSha256||checkpoint.review.status!==recorded.reviewerStatus)
   throw Error('Checkpoint model-result binding mismatch');
 }
 return recorded;
}
async function continueLocked({dir,baseSha,bridge,sourceKind}){
 const job=loadJob(join(dir,'job.json'));
 if(job.id!=='synthetic-cycle-v1'||job.baseSha!==digest(SEEDED_SOURCE))throw Error('Invalid stored synthetic job');
 const intentFile=join(dir,'model-cycle-intent.json'),resultFile=join(dir,'model-cycle-result.json');
 const recorded=verifiedSavedResult(dir,baseSha);
 if(recorded&&!existsSync(intentFile))throw Error('Model attempt intent missing');
 if(job.state==='BLOCKED')return {state:'BLOCKED',reason:'already-blocked',nextTaskDispatched:false,
  releaseAuthorized:false,modelExecuted:false,checkpointVerified:!!recorded?.reviewCheckpointSha256};
 if(job.state!=='RUNNING'||job.revision!==1)throw Error('Synthetic failed-test state required');
 if(safeText(join(dir,'fixture.py'))!==SEEDED_SOURCE)throw Error('Synthetic source mismatch');
 const fail=JSON.parse(safeText(join(dir,'failure.json')));
 if(fail.kind!=='observed-test-failure'||fail.sourceSha256!==job.baseSha||fail.exit!==1||
    !Number.isInteger(fail.failedCases)||fail.failedCases<=0)throw Error('Unverified test failure receipt');
 if(existsSync(intentFile)){
  const intent=JSON.parse(safeText(intentFile));
  if(intent.baseSha!==baseSha||intent.jobRevision!==job.revision)throw Error('Model attempt identity mismatch');
  if(recorded)return block(dir,job,'resume-after-recorded-model-attempt',recorded.reviewCheckpointSha256??null);
  return block(dir,job,'incomplete-model-attempt-no-auto-retry');
 }
 newReceipt(intentFile,{schema:1,baseSha,jobRevision:job.revision,sourceSha256:job.baseSha});
 let result;
 try{result=await bridge({baseSha})}catch{result={reason:'model-bridge-failed'}}
 const reason=allowedReasons.has(result?.reason)?result.reason:'model-bridge-failed';
 let checkpointSha256=null;
 if(result?.generatedSource!==undefined){
  checkpointSha256=saveReviewCheckpoint(join(dir,'review-checkpoint.json'),{
   baseSha,source:result.generatedSource,review:result.reviewer}).sha256;
 }
 newReceipt(resultFile,{schema:1,baseSha,sourceSha256:job.baseSha,reviewGate:'NOT_AUTHORIZED',sourceKind,reason,
  builderClaimedObserved:result?.builder?.modelExecuted===true,reviewerClaimedObserved:result?.reviewer?.modelExecuted===true,
  builderSourceSha256:HASH64.test(result?.builder?.sourceSha256??'')?result.builder.sourceSha256:null,
  builderModelSha256:HASH64.test(result?.builder?.modelSha256??'')?result.builder.modelSha256:null,
  builderResponseSha256:HASH64.test(result?.builder?.responseSha256??'')?result.builder.responseSha256:null,
  reviewerStatus:safeReviewStatus.has(result?.reviewer?.status)?result.reviewer.status:'UNKNOWN',
  ...(checkpointSha256?{reviewCheckpointSha256:checkpointSha256}:{}),
  releaseAuthorized:false,nextTaskDispatched:false});
 verifiedSavedResult(dir,baseSha);
 return block(dir,job,'model-cycle-advisory-only',checkpointSha256);
}
async function continueWithLock({root,baseSha,bridge,sourceKind}){
 if(!SHA40.test(baseSha??'')||typeof bridge!=='function')throw Error('Invalid bridge request');
 const repoRoot=fileURLToPath(new URL('..',import.meta.url));
 const observedHead=execFileSync('/usr/bin/git',['--no-replace-objects','rev-parse','HEAD'],
  {cwd:repoRoot,env:{PATH:'/usr/bin:/bin'},timeout:5000,maxBuffer:4096,encoding:'utf8'}).trim();
 if(baseSha!==observedHead)throw Error('Git HEAD mismatch');
 const dir=scratch(root),lock=join(dir,'.continuation.lock');
 let fd;try{fd=openSync(lock,'wx',0o600)}catch{throw Error('Local model cycle is locked; stale locks require explicit recovery')}
 try{return await continueLocked({dir,baseSha,bridge,sourceKind})}finally{closeSync(fd);unlinkSync(lock)}
}
export async function continueModelCycle({root,baseSha,bridge}={}){
 return continueWithLock({root,baseSha,bridge,sourceKind:'injected-bridge-not-independent-proof'});
}
export async function continueVerifiedCachedModels({root,baseSha,builderArtifacts,reviewerArtifacts}={}){
 return continueWithLock({root,baseSha,sourceKind:'pinned-local-model-cycle-not-security-approval',
  bridge:()=>runVerifiedCachedCycle({baseSha,builderArtifacts,reviewerArtifacts})});
}
