// Optional local-only Qwen builder -> SmolLM2 reviewer bridge.
// This is a bounded public synthetic fixture experiment, never a merge or write gate.
import {SEEDED_SOURCE} from './local-builder-adapter.mjs';
import {runBoundedRecovery,runCachedRecovery} from './synthetic-builder-proof.mjs';
import {runReviewProof,runActualReviewProof} from './synthetic-review-proof.mjs';
const PINNED_REVIEW_SOURCE_SHA='25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974';
const PINNED_BUILDER_MODEL_SHA='1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32';
const BLOCKED=(reason,builder,reviewer={status:'NOT_RUN',modelExecuted:false})=>({
 state:'BLOCKED',reason,builder,reviewer,releaseAuthorized:false,nextTaskDispatched:false,
 scope:'public-synthetic-arithmetic-only',crossActionsPersistenceVerified:false
});
function summarizeRecovery(recovery,observed=false){
 const attempt=recovery.attempts?.at(-1);
 return {status:recovery.status,attempts:recovery.attempts?.length??0,
  sourceSha256:attempt?.sourceSha256??null,
  modelExecuted:observed&&attempt?.model?.kind==='observed-local-model-process'&&
   attempt.model.launched===true&&attempt.model.exitCode===0&&
   attempt.model.modelSha256===PINNED_BUILDER_MODEL_SHA&&
   /^[a-f0-9]{64}$/.test(attempt.model.rawResponseSha256??'')};
}
function summarizeReview(result,observed=false){
 const c=result.cases?.[0];
 return {status:c?.status??'NOT_RUN',cases:result.cases?.length??0,
  modelExecuted:observed===true&&result.actualModelProof===true&&
   result.cases?.length===1&&c?.modelExecuted===true&&c?.caseAgreement===true};
}
export async function runSyntheticBridge({baseSha,builder,reviewer}={}){
 if(!/^[a-f0-9]{40}$/.test(baseSha??'')||typeof builder!=='function'||typeof reviewer!=='function')
  throw Error('Invalid synthetic bridge inputs');
 const recovery=await runBoundedRecovery({baseSha,initialSource:SEEDED_SOURCE,sourceOrigin:'host-seeded',builder,maxCalls:2});
 const b=summarizeRecovery(recovery);
 if(b.status!=='PASS')return BLOCKED('builder-not-verified',b);
 if(b.sourceSha256!==PINNED_REVIEW_SOURCE_SHA)return BLOCKED('review-source-unverified',b);
 const review=await runReviewProof({baseSha,selectedSourceHashes:[b.sourceSha256],reviewer});
 const v=summarizeReview(review);
 return BLOCKED(v.status==='ADVISORY_AGREEMENT'?'model-execution-unverified':'review-inconclusive',b,v);
}
// Explicit opt-in only: actual cached, digest-pinned llama.cpp and distinct model weights.
// No downloads, GitHub writes, checkout mutation, secrets, credentials or deployment.
export async function runVerifiedCachedCycle({baseSha,builderArtifacts,reviewerArtifacts}={}){
 if(!/^[a-f0-9]{40}$/.test(baseSha??''))throw Error('Full Git HEAD SHA required');
 const recovery=await runCachedRecovery({baseSha,initialSource:SEEDED_SOURCE,sourceOrigin:'host-seeded',
  artifacts:builderArtifacts,maxCalls:2});
 const b=summarizeRecovery(recovery,true);
 if(b.status!=='PASS'||!b.modelExecuted)return BLOCKED('builder-model-not-proven',b);
 if(b.sourceSha256!==PINNED_REVIEW_SOURCE_SHA)return BLOCKED('review-source-unverified',b);
 const review=await runActualReviewProof({baseSha,artifacts:reviewerArtifacts,
  selectedSourceHashes:[b.sourceSha256]});
 const v=summarizeReview(review,true);
 // Even a real two-model advisory on one fixed fixture has no security/merge authority.
 return BLOCKED(v.modelExecuted?'independent-review-advisory-only':'independent-model-review-unverified',b,v);
}
