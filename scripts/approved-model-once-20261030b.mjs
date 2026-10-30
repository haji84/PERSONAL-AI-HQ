#!/usr/bin/env node
// New separate single-use owner approval (2026-10-30b). No GitHub/cloud writes, private inputs, keys, or retries.
// This one-shot is intentionally not a persistent AI runtime.
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SEEDED_SOURCE,sha256} from './local-builder-adapter.mjs';
import {runCachedRecovery,summarizeRetestDiagnostic} from './synthetic-builder-proof.mjs';
import {runActualGeneratedReview} from './generated-review.mjs';
import {continueModelCycle} from './model-cycle-state.mjs';
import {loadReviewCheckpoint} from './review-checkpoint.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url));
const builderManifest=JSON.parse(readFileSync(new URL('../tests/fixtures/local-builder/manifest.json',import.meta.url)));
const reviewerManifest=JSON.parse(readFileSync(new URL('../tests/fixtures/local-reviewer/manifest.json',import.meta.url)));
const HASH=/^[a-f0-9]{64}$/;
const allowedStages=new Set(['preflight','baseline','model','proposal','apply','retest','integrity','source-check','model-artifact','process','format','review-process','witness']);
const digest=v=>typeof v==='string'&&HASH.test(v)?v:null;
const root=mkdtempSync(join(tmpdir(),'hq-approved-once-'));
let phase='preflight';
const evidence={schema:1,kind:'owner-approved-one-shot-20261030b',status:'FAIL',
  builderCalls:0,reviewerCalls:0,builderObserved:false,reviewerObserved:false,
  modelSourceBound:false,localCheckpointVerified:false,separateProcessResume:false,
  state:'BLOCKED',releaseAuthorized:false,nextTaskDispatched:false,remotePersistence:false,
  independentSecurityApproval:false,orchestration:'explicit-real-adapters-via-unprivileged-injection-seam'};
function ensure(ok){if(!ok)throw Error('bounded-proof-check-failed')}
function runSeed(operation){
 const r=spawnSync(process.execPath,[join(repo,'scripts/synthetic-continuation.mjs'),operation,root],
   {cwd:repo,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:15000,maxBuffer:65536});
 ensure(r.status===0);
}
try{
 const baseSha=execFileSync('/usr/bin/git',['--no-replace-objects','rev-parse','HEAD'],
   {cwd:repo,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000,maxBuffer:4096}).trim();
 ensure(/^[a-f0-9]{40}$/.test(baseSha)&&baseSha===process.env.HQ_APPROVED_SOURCE_SHA);
 evidence.sourceHead=baseSha;
 const runtimeDir=process.env.HQ_PROBE_RUNTIME_DIR;
 const builderFile=process.env.HQ_PROBE_BUILDER_FILE;
 const reviewerFile=process.env.HQ_PROBE_REVIEWER_FILE;
 ensure(runtimeDir&&builderFile&&reviewerFile);
 runSeed('init');runSeed('observe-failure');
 const state=await continueModelCycle({root,baseSha,bridge:async()=>{
  phase='qwen';evidence.builderCalls++;
  ensure(evidence.builderCalls===1);
  const recovery=await runCachedRecovery({baseSha,initialSource:SEEDED_SOURCE,
    sourceOrigin:'host-seeded',artifacts:{runtimeDir,modelFile:builderFile},maxCalls:1});
  evidence.builderInvocationsAttempted=recovery.modelInvocationsAttempted;
  evidence.builderProcessesLaunched=recovery.launchedProcesses;
  const attempt=recovery.attempts?.at(-1),model=attempt?.model;
  evidence.builderStatus=recovery.status==='PASS'?'PASS':'BLOCKED';
  evidence.builderFailureStage=allowedStages.has(attempt?.failedStage)?attempt.failedStage:null;
  evidence.builderObserved=model?.kind==='observed-local-model-process'&&model.launched===true&&
    model.exitCode===0&&model.modelSha256===builderManifest.model.sha256&&digest(model.rawResponseSha256)!==null;
  evidence.builderModelSha256=digest(model?.modelSha256);
  evidence.builderResponseSha256=digest(model?.rawResponseSha256);
  evidence.generatedSourceSha256=digest(attempt?.sourceSha256);
  evidence.immutableTestsSha256=digest(attempt?.testsSha256);
  evidence.builderRetestDiagnostic=summarizeRetestDiagnostic(attempt);
  evidence.retestCases=attempt?.retest?.status==='PASS'&&attempt.retest.caseCount===6?6:null;
  ensure(recovery.modelInvocationsAttempted===1&&recovery.attempts?.length===1);
  if(recovery.status!=='PASS'||!evidence.builderObserved||attempt?.retest?.status!=='PASS'){
    evidence.failedPhase='qwen';
    return {state:'BLOCKED',reason:'builder-not-verified',
      builder:{modelExecuted:evidence.builderObserved,sourceSha256:evidence.generatedSourceSha256,
        modelSha256:evidence.builderModelSha256,responseSha256:evidence.builderResponseSha256,
        retestDiagnostic:evidence.builderRetestDiagnostic},
      reviewer:{status:'NOT_RUN',modelExecuted:false},releaseAuthorized:false,nextTaskDispatched:false};
  }
  const source=attempt.generatedSource;
  ensure(typeof source==='string'&&sha256(source)===attempt.sourceSha256);
  phase='smollm2';evidence.reviewerCalls++;
  ensure(evidence.reviewerCalls===1);
  const review=await runActualGeneratedReview({request:{baseSha,source},artifacts:{runtimeDir,modelFile:reviewerFile}});
  evidence.reviewerStatus=['ADVISORY_AGREEMENT','INCONCLUSIVE','FAILED'].includes(review.status)?review.status:'UNKNOWN';
  evidence.reviewerFailureStage=allowedStages.has(review.failedStage)?review.failedStage:null;
  evidence.reviewerObserved=review.modelExecuted===true&&review.reviewerModelSha256===reviewerManifest.sha256;
  evidence.reviewerModelSha256=digest(review.reviewerModelSha256);
  evidence.reviewerResponseSha256=digest(review.reviewerResponseSha256);
  evidence.reviewReceiptSha256=digest(review.reviewReceiptSha256);
  evidence.reviewedSourceSha256=digest(review.sourceSha256);
  evidence.promptSourceSha256=digest(review.promptSourceSha256);
  evidence.witnessValid=review.witnessValid===true;
  evidence.advisoryAgrees=review.advisoryAgrees===true;
  evidence.modelSourceBound=review.baseSha===baseSha&&review.sourceSha256===sha256(source)&&
    review.promptSourceSha256===sha256(source)&&review.testsSha256===attempt.testsSha256;
  phase='checkpoint';
  return {state:'BLOCKED',reason:review.status==='ADVISORY_AGREEMENT'?'independent-review-advisory-only':'independent-model-review-unverified',
    builder:{modelExecuted:evidence.builderObserved,sourceSha256:attempt.sourceSha256,
      modelSha256:model.modelSha256,responseSha256:model.rawResponseSha256,
      retestDiagnostic:evidence.builderRetestDiagnostic},
    reviewer:review,generatedSource:source,releaseAuthorized:false,nextTaskDispatched:false};
 }});
 const receipt=JSON.parse(readFileSync(join(root,'model-cycle-result.json'),'utf8'));
 evidence.localCheckpointSha256=digest(receipt.reviewCheckpointSha256);
 evidence.builderRetestStored=JSON.stringify(receipt.builderRetestDiagnostic)===
   JSON.stringify(evidence.builderRetestDiagnostic);
 evidence.state=state.state;
 if(evidence.localCheckpointSha256){
  const saved=loadReviewCheckpoint(join(root,'review-checkpoint.json'),{baseSha,expectedDigest:evidence.localCheckpointSha256});
  evidence.localCheckpointVerified=saved.review.sourceSha256===evidence.generatedSourceSha256&&
    saved.review.reviewReceiptSha256===evidence.reviewReceiptSha256&&state.checkpointVerified===true;
  phase='resume';
  const moduleUrl=new URL('./model-cycle-state.mjs',import.meta.url).href;
  const program=`import {continueModelCycle} from ${JSON.stringify(moduleUrl)};
const r=await continueModelCycle({root:${JSON.stringify(root)},baseSha:${JSON.stringify(baseSha)},bridge:async()=>{throw Error('MUST_NOT_RUN')}});
if(r.state!=='BLOCKED'||r.checkpointVerified!==true||r.releaseAuthorized!==false)process.exit(3);
process.stdout.write('CHECKPOINT_RESUME_VERIFIED');`;
  const restarted=spawnSync(process.execPath,['--input-type=module','-e',program],
    {cwd:repo,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:15000,maxBuffer:65536});
  evidence.separateProcessResume=restarted.status===0&&restarted.stdout==='CHECKPOINT_RESUME_VERIFIED';
 }
 ensure(evidence.builderRetestStored===true&&evidence.builderCalls===1&&evidence.reviewerCalls===1&&
  evidence.builderObserved&&evidence.reviewerObserved&&
  evidence.modelSourceBound&&evidence.reviewerStatus==='ADVISORY_AGREEMENT'&&evidence.witnessValid&&
  evidence.advisoryAgrees&&evidence.localCheckpointVerified&&evidence.separateProcessResume&&
  state.state==='BLOCKED'&&state.releaseAuthorized===false&&state.nextTaskDispatched===false);
 evidence.status='PASS_BOUNDED_TWO_MODEL_LOCAL_PROOF';
}catch{
 evidence.failedPhase??=phase;
 process.exitCode=2;
}finally{
 // Never print prompts, code, raw model responses, environment, or host paths.
 console.log('HQ_APPROVED_ONESHOT_RESULT='+JSON.stringify(evidence));
 rmSync(root,{recursive:true,force:true});
}
