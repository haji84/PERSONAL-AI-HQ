// Optional local-only Qwen builder -> SmolLM2 reviewer bridge.
// Bounded public synthetic evidence only; no security-review or merge authority.
import {SEEDED_SOURCE,sha256} from './local-builder-adapter.mjs';
import {runBoundedRecovery,runCachedRecovery} from './synthetic-builder-proof.mjs';
import {runReviewProof} from './synthetic-review-proof.mjs';
import {reviewGeneratedSource,runActualGeneratedReview} from './generated-review.mjs';
const PINNED_REVIEW_SOURCE_SHA='25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974';
const PINNED_BUILDER_MODEL_SHA='1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32';
const BLOCKED=(reason,builder,reviewer={status:'NOT_RUN',modelExecuted:false})=>({
 state:'BLOCKED',reason,builder,reviewer,releaseAuthorized:false,nextTaskDispatched:false,
 scope:'public-synthetic-arithmetic-only',crossActionsPersistenceVerified:false
});
function summarizeRecovery(recovery,observed=false){
 const attempt=recovery.attempts?.at(-1);
 const modelExecuted=observed&&attempt?.model?.kind==='observed-local-model-process'&&
   attempt.model.launched===true&&attempt.model.exitCode===0&&
   attempt.model.modelSha256===PINNED_BUILDER_MODEL_SHA&&
   /^[a-f0-9]{64}$/.test(attempt.model.rawResponseSha256??'');
 return {status:recovery.status,attempts:recovery.attempts?.length??0,
  sourceSha256:attempt?.sourceSha256??null,modelExecuted,
  ...(modelExecuted?{modelSha256:attempt.model.modelSha256,responseSha256:attempt.model.rawResponseSha256}:{})};
}
// Historical fixed-fixture test seam retained so old evidence is not reclassified.
export async function runSyntheticBridge({baseSha,builder,reviewer}={}){
 if(!/^[a-f0-9]{40}$/.test(baseSha??'')||typeof builder!=='function'||typeof reviewer!=='function')
  throw Error('Invalid synthetic bridge inputs');
 const recovery=await runBoundedRecovery({baseSha,initialSource:SEEDED_SOURCE,sourceOrigin:'host-seeded',builder,maxCalls:2});
 const b=summarizeRecovery(recovery);
 if(b.status!=='PASS')return BLOCKED('builder-not-verified',b);
 if(b.sourceSha256!==PINNED_REVIEW_SOURCE_SHA)return BLOCKED('review-source-unverified',b);
 const review=await runReviewProof({baseSha,selectedSourceHashes:[b.sourceSha256],reviewer});
 const c=review.cases?.[0],v={status:c?.status??'NOT_RUN',cases:review.cases?.length??0,modelExecuted:false};
 return BLOCKED(v.status==='ADVISORY_AGREEMENT'?'model-execution-unverified':'review-inconclusive',b,v);
}
async function reviewRecovery({baseSha,recovery,reviewer,reviewerArtifacts,actual}){
 const b=summarizeRecovery(recovery,actual);
 if(b.status!=='PASS'||(actual&&!b.modelExecuted))return BLOCKED('builder-not-verified',b);
 const source=recovery.attempts?.at(-1)?.generatedSource;
 if(typeof source!=='string'||sha256(source)!==b.sourceSha256)return BLOCKED('review-source-unverified',b);
 let review;
 try{
  const request={baseSha,source};
  review=actual?await runActualGeneratedReview({request,artifacts:reviewerArtifacts}):
   await reviewGeneratedSource({request,reviewer});
 }catch{return BLOCKED('review-source-unverified',b)}
 const accepted=review.status==='ADVISORY_AGREEMENT'&&review.advisoryAgrees===true;
 const reason=actual?(accepted&&review.modelExecuted?'independent-review-advisory-only':'independent-model-review-unverified'):
  (accepted?'model-execution-unverified':'review-inconclusive');
 // Original source and bounded review evidence remain local for restart verification.
 return {...BLOCKED(reason,b,review),generatedSource:source};
}
export async function runGeneratedSyntheticCycle({baseSha,builder,reviewer}={}){
 if(!/^[a-f0-9]{40}$/.test(baseSha??'')||typeof builder!=='function'||typeof reviewer!=='function')
  throw Error('Invalid synthetic bridge inputs');
 const recovery=await runBoundedRecovery({baseSha,initialSource:SEEDED_SOURCE,sourceOrigin:'host-seeded',builder,maxCalls:2});
 return reviewRecovery({baseSha,recovery,reviewer,actual:false});
}
// Explicit local opt-in only; cached, digest-pinned runtime and different model weights.
export async function runVerifiedCachedCycle({baseSha,builderArtifacts,reviewerArtifacts}={}){
 if(!/^[a-f0-9]{40}$/.test(baseSha??''))throw Error('Full Git HEAD SHA required');
 const recovery=await runCachedRecovery({baseSha,initialSource:SEEDED_SOURCE,sourceOrigin:'host-seeded',
  artifacts:builderArtifacts,maxCalls:2});
 return reviewRecovery({baseSha,recovery,reviewerArtifacts,actual:true});
}
