// Exact-source advisory review for the existing bounded synthetic addition task.
// No downloads, GitHub authority, workflow activation or general-purpose code execution.
import {readFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {sha256,runBoundedProcess} from './local-builder-adapter.mjs';
import {runArithmeticCheck} from './synthetic-builder-proof.mjs';
import {checkWitness} from './synthetic-review-proof.mjs';
import {buildReviewerInvocation,parseReviewResponse,verifyReviewerArtifacts,assertDifferentModel} from './local-reviewer-adapter.mjs';
const profile=JSON.parse(await readFile(new URL('../tests/fixtures/local-reviewer/manifest.json',import.meta.url)));
const builder=JSON.parse(await readFile(new URL('../tests/fixtures/local-builder/manifest.json',import.meta.url)));
const wrapper=fileURLToPath(new URL('./local-model-limit.py',import.meta.url));
const templateSource='def add(a,b): return a + b';
const approvedCanonical='def add(a, b):\n    return a + b';
const HASH=/^[a-f0-9]{64}$/;
export async function prepareGeneratedReview(request,model){
 if(!request||Object.keys(request).sort().join(',')!=='baseSha,source'||
    !/^[a-f0-9]{40}$/.test(request.baseSha??'')||typeof request.source!=='string'||
    Buffer.byteLength(request.source)>2048||!/^[a-zA-Z0-9_(),:+*\- \t\r\n]+$/.test(request.source))
  throw Error('Invalid bounded generated review request');
 const preflight=await runArithmeticCheck(request.source),oracle=await checkWitness(request.source);
 if(preflight.status!=='PASS'||preflight.caseCount!==6||oracle.testStatus!=='PASS'||
    preflight.testsSha256!==oracle.testsSha256||preflight.canonicalSource!==approvedCanonical||
    oracle.canonicalSource!==preflight.canonicalSource)
  throw Error('Generated source outside approved arithmetic scope');
 // Reuse the existing reviewed grammar and resource bounds, not its historical code specimen.
 const template=buildReviewerInvocation({baseSha:request.baseSha,source:templateSource},model);
 const sourceSha256=sha256(request.source);
 const marker=`Candidate ID: ${template.sourceSha256}\n${template.promptSource}\nReturn JSON`;
 if(!template.prompt.includes(marker))throw Error('Reviewer template changed');
 const prompt=template.prompt.replace(marker,`Candidate ID: ${sourceSha256}\n${request.source}\nReturn JSON`);
 const args=[...template.args],index=args.indexOf('--prompt');
 if(index<0||args[index+1]!==template.prompt)throw Error('Reviewer prompt argument changed');
 args[index+1]=prompt;
 return {...template,prompt,args,promptSource:request.source,sourceSha256,
  promptSourceSha256:sourceSha256,preflight,canonicalSourceSha256:sha256(preflight.canonicalSource)};
}
async function observedReviewer({request,artifacts}){
 let stage='preflight';const receipt={kind:'observed-local-reviewer-process',modelExecuted:false,
  advisoryOnly:true,authority:'none',status:'FAILED'};
 try{
  if(!artifacts||Object.keys(artifacts).sort().join(',')!=='modelFile,runtimeDir')throw Error('Invalid artifacts');
  assertDifferentModel({family:'qwen2',sha256:builder.model.sha256},profile);
  stage='model-artifact';const {runtime,model}=await verifyReviewerArtifacts({artifacts});
  stage='source-check';const invocation=await prepareGeneratedReview(request,model);
  const wrapperHash=sha256(await readFile(wrapper));
  Object.assign(receipt,{baseSha:request.baseSha,sourceSha256:invocation.sourceSha256,
   promptSourceSha256:invocation.promptSourceSha256,canonicalSourceSha256:invocation.canonicalSourceSha256,
   testsSha256:invocation.preflight.testsSha256,requestSha256:sha256(JSON.stringify(request)),
   promptSha256:sha256(invocation.prompt),grammarSha256:sha256(invocation.grammar),
   modelSha256:profile.sha256,builderModelSha256:builder.model.sha256,modelFamily:profile.family,
   adapterSha256:sha256(await readFile(new URL(import.meta.url))),wrapperSha256:wrapperHash});
  const cwd=await mkdtemp(join(tmpdir(),'hq-generated-review-'));stage='process';
  const start=performance.now();receipt.startedAt=new Date().toISOString();
  const r=await runBoundedProcess('/usr/bin/python3',['-I','-S',wrapper,join(runtime,builder.runtime.executable),...invocation.args],
   {cwd,env:{PATH:'/usr/bin:/bin',HOME:cwd,LD_LIBRARY_PATH:runtime,OMP_NUM_THREADS:'2'},timeoutMs:180000,maxBytes:102400});
  Object.assign(receipt,{modelExecuted:true,launched:true,terminated:true,exitCode:r.exitCode,
   wallMs:Math.round(performance.now()-start),rawResponse:r.stdout,rawResponseSha256:sha256(r.stdout),
   stderrSha256:sha256(r.stderr)});
  stage='integrity';await verifyReviewerArtifacts({artifacts});
  if(wrapperHash!==sha256(await readFile(wrapper)))throw Error('Reviewer wrapper changed');
  stage='format';const advisory=parseReviewResponse(r.stdout);receipt.status='OBSERVED';
  return {advisory,receipt};
 }catch(e){e.receipt={...receipt,status:'FAILED',failedStage:stage};throw e}
}
function observedIdentity(receipt,request){
 return receipt?.kind==='observed-local-reviewer-process'&&receipt.modelExecuted===true&&
  receipt.exitCode===0&&receipt.modelSha256===profile.sha256&&
  receipt.baseSha===request.baseSha&&receipt.sourceSha256===sha256(request.source)&&
  receipt.promptSourceSha256===sha256(request.source)&&
  receipt.requestSha256===sha256(JSON.stringify(request))&&HASH.test(receipt.rawResponseSha256??'');
}
async function evaluate({request,reviewer,actual=false}){
 const invocation=await prepareGeneratedReview(request,'/host-selected/reviewer.gguf');
 const result={status:'PENDING',authority:'none',advisoryOnly:true,modelExecuted:false,
  baseSha:request.baseSha,sourceSha256:invocation.sourceSha256,
  promptSourceSha256:invocation.promptSourceSha256,canonicalSourceSha256:invocation.canonicalSourceSha256,
  testsSha256:invocation.preflight.testsSha256,testCaseCount:6,witnessValid:false,advisoryAgrees:false};
 let stage='review-process';
 try{
  const observed=await reviewer({request});const receipt=observed.receipt;
  if(receipt?.sourceSha256!==undefined&&receipt.sourceSha256!==result.sourceSha256)throw Error('Wrong reviewed source');
  result.modelExecuted=actual&&observedIdentity(receipt,request);
  if(actual&&!result.modelExecuted)throw Error('Model identity unverified');
  if(result.modelExecuted){
   result.reviewerModelSha256=receipt.modelSha256;
   result.reviewerResponseSha256=receipt.rawResponseSha256;
   result.requestSha256=receipt.requestSha256;
   result.promptSha256=receipt.promptSha256;
  }
  stage='format';const advisory=parseReviewResponse(JSON.stringify(observed.advisory));
  stage='witness';const witness=await checkWitness(request.source,advisory.example);
  const retest=await runArithmeticCheck(request.source);
  if(retest.status!=='PASS'||retest.testsSha256!==result.testsSha256||witness.testsSha256!==result.testsSha256||
     witness.canonicalSource!==invocation.preflight.canonicalSource)throw Error('Generated review tests changed');
  result.witnessValid=witness.witnessValid===true;
  result.advisoryAgrees=result.witnessValid&&!witness.mismatch&&advisory.verdict==='no_defect';
  result.status=result.advisoryAgrees?'ADVISORY_AGREEMENT':'INCONCLUSIVE';
 }catch(e){
  result.status='FAILED';result.failedStage=stage;
  if(actual&&observedIdentity(e.receipt,request)){
   result.modelExecuted=true;
   result.reviewerModelSha256=e.receipt.modelSha256;
   result.reviewerResponseSha256=e.receipt.rawResponseSha256;
  }
 }
 result.reviewReceiptSha256=sha256(JSON.stringify(result));
 return result;
}
export async function reviewGeneratedSource({request,reviewer}){
 if(typeof reviewer!=='function')throw Error('Reviewer required');
 return evaluate({request,reviewer,actual:false});
}
export async function runActualGeneratedReview({request,artifacts}){
 return evaluate({request,reviewer:args=>observedReviewer({...args,artifacts}),actual:true});
}
