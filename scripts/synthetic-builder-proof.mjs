// Host-seeded arithmetic repair proof. Never grants job/review/merge authority.
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir,platform,release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBoundedProcess,runLocalBuilder,sha256,SEEDED_SOURCE,parseSyntheticProposal} from './local-builder-adapter.mjs';
const checker=fileURLToPath(new URL('./synthetic-python-check.py',import.meta.url));
export function parseCheckerOutput(raw){
 const r=JSON.parse(raw);
 if(!['PASS','ASSERTION_FAILURE','SAFETY_REJECTED'].includes(r.status)||!/^[a-f0-9]{64}$/.test(r.testsSha256)||typeof r.pythonVersion!=='string'||(r.status==='PASS'&&r.caseCount!==6)||(r.status==='ASSERTION_FAILURE'&&typeof r.failure!=='string'))throw Error('Invalid checker result');
 return r;
}
export function assertBaselineFailure(r){
 if(r?.status!=='ASSERTION_FAILURE'||typeof r.failure!=='string')throw Error('Baseline must have actual assertion failure');
}
export function assertTestIntegrity({checkerBefore,checkerAfter,testsBefore,testsAfter}){
 if(checkerBefore!==checkerAfter||testsBefore!==testsAfter)throw Error('Immutable test/checker changed');
}
export async function runArithmeticCheck(source){
 const cwd=await mkdtemp(join(tmpdir(),'hq-arithmetic-'));
 const r=await runBoundedProcess('/usr/bin/python3',['-I','-S',checker],{cwd,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBytes:65536,input:JSON.stringify({source})});
 return parseCheckerOutput(r.stdout);
}
// Dependency injection is only an unverified orchestration test seam.
export async function runSyntheticProof({baseSha,builder,initialSource=SEEDED_SOURCE,recovery=false,expectedIdentity}){
 let stage='host-preflight';
 const evidence={schema:1,status:'RUNNING',inferenceVerified:false,scope:recovery?'candidate-informed-synthetic-recovery-not-full-autonomy':'host-seeded-synthetic-repair-not-full-autonomy',baseSha};
 try{
  evidence.checkerSha256=sha256(await readFile(checker));
  evidence.contractSha256=sha256(await readFile(new URL('./builder-contract.mjs',import.meta.url)));
  evidence.proofRunnerSha256=sha256(await readFile(new URL(import.meta.url)));
  const repoCwd=fileURLToPath(new URL('..',import.meta.url));
  const gitOptions={cwd:repoCwd,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBytes:65536};
  const head=(await runBoundedProcess('/usr/bin/git',['rev-parse','HEAD'],gitOptions)).stdout.trim();
  const dirty=Boolean((await runBoundedProcess('/usr/bin/git',['status','--porcelain'],gitOptions)).stdout.trim());
  evidence.repository={head,dirty};evidence.initialSourceSha256=sha256(initialSource);if(!recovery)evidence.seedSha256=sha256(SEEDED_SOURCE);
  stage='baseline';evidence.baseline=await runArithmeticCheck(initialSource);assertBaselineFailure(evidence.baseline);
  evidence.testsSha256=evidence.baseline.testsSha256;
  if(expectedIdentity){stage='integrity';assertRecoveryIdentity(expectedIdentity,evidence)}
  const request={taskId:'synthetic-add-v1',baseSha,failure:evidence.baseline.failure,...(recovery?{currentSource:evidence.baseline.canonicalSource,currentSourceSha256:sha256(evidence.baseline.canonicalSource),testsSha256:evidence.baseline.testsSha256}:{})};
  stage='model';const generated=await builder({request});evidence.model=generated.receipt;
  stage='proposal';const proposal=parseSyntheticProposal(JSON.stringify({schema:1,baseSha:generated.proposal?.baseSha,changes:generated.proposal?.changes}),request);
  evidence.proposal=proposal;evidence.generatedSource=proposal.changes[0].content;evidence.sourceSha256=sha256(evidence.generatedSource);
  stage='apply';const sandbox=await mkdtemp(join(tmpdir(),'hq-synthetic-proof-'));
  const appliedPath=join(sandbox,'fixture.py');await writeFile(appliedPath,evidence.generatedSource,{flag:'wx'});
  const appliedSource=await readFile(appliedPath,'utf8');evidence.appliedSourceSha256=sha256(appliedSource);
  stage='retest';evidence.retest=await runArithmeticCheck(appliedSource);
  stage='integrity';assertTestIntegrity({checkerBefore:evidence.checkerSha256,checkerAfter:sha256(await readFile(checker)),testsBefore:evidence.baseline.testsSha256,testsAfter:evidence.retest.testsSha256});
  if(appliedSource!==evidence.generatedSource||sha256(await readFile(appliedPath))!==evidence.sourceSha256)throw Error('Applied source changed');
  evidence.host={node:process.version,os:platform(),kernel:release(),python:evidence.retest.pythonVersion,hermetic:false};
  stage='retest';if(evidence.retest.status!=='PASS')throw Error(`Generated repair failed: ${evidence.retest.status}`);
  return {...evidence,status:'PASS',evidenceCompleteness:{modelReceipt:Boolean(evidence.model),proposalAvailable:true,retestAvailable:true}};
 }catch(e){
  if(stage==='model'&&e.receipt)evidence.model=e.receipt;
  const cause=e.receipt;
  e.receipt={...evidence,status:'FAILED',failedStage:stage,error:e.message,evidenceCompleteness:{modelReceipt:Boolean(evidence.model),proposalAvailable:Boolean(evidence.proposal),retestAvailable:Boolean(evidence.retest)},...(cause&&stage!=='model'?{cause}:{} )};throw e;
 }
}
export async function runCachedSyntheticProof({baseSha,artifacts}){
 const head=(await runBoundedProcess('/usr/bin/git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBytes:65536})).stdout.trim();
 if(baseSha!==head)throw Error('Requested base does not match HEAD');
 const r=await runSyntheticProof({baseSha,builder:({request})=>runLocalBuilder({request,artifacts})});
 return {...r,inferenceVerified:true,verificationMeaning:'observed-local-process-only-not-independent-review'};
}

// Canonical AST digests are format-insensitive, not formal semantic equivalence proofs.
export function assertRecoveryIdentity(initial,attempt){
 if(initial.checkerSha256!==attempt.checkerSha256||initial.testsSha256!==attempt.testsSha256)throw Error('Recovery checker/tests changed');
}
export async function runBoundedRecovery({baseSha,initialSource,sourceOrigin,builder,maxCalls=2}){
 if(!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>2||!['host-seeded','recovered-incomplete','recorded-candidate-claim'].includes(sourceOrigin))throw Error('Invalid recovery bounds/origin');
 const checkerSha256=sha256(await readFile(checker));
 const initialCheck=await runArithmeticCheck(initialSource);assertBaselineFailure(initialCheck);
 const identity={checkerSha256,testsSha256:initialCheck.testsSha256};
 const inputProvenance={origin:sourceOrigin,complete:false,note:'origin is a host claim; incomplete input provenance is never upgraded'};
 // The trusted Python AST digest detects semantically identical repairs regardless of formatting.
 const seenAst=new Set([initialCheck.semanticSha256]),attempts=[];let current=initialCheck.canonicalSource;
 for(let i=0;i<maxCalls;i++){
  try{
   const result=await runSyntheticProof({baseSha,builder,initialSource:current,recovery:true,expectedIdentity:identity});
   try{assertRecoveryIdentity(identity,result)}catch(e){e.receipt={...result,status:'FAILED',failedStage:'integrity',error:e.message};throw e}
   attempts.push(result);
   return {status:'PASS',semanticNoOp:false,inferenceVerified:false,inputProvenance,initialCheck,attempts};
  }catch(e){
   const receipt=e.receipt??{status:'FAILED',failedStage:'unknown',error:e.message};attempts.push(receipt);
   if(receipt.failedStage!=='retest'||receipt.retest?.status!=='ASSERTION_FAILURE')return {status:'BLOCKED',reason:'non-repairable-stage',inferenceVerified:false,inputProvenance,initialCheck,attempts};
   const next=receipt.retest;
   try{assertRecoveryIdentity(identity,receipt)}catch(e){receipt.failedStage='integrity';receipt.error=e.message;return {status:'BLOCKED',reason:'identity-changed',inferenceVerified:false,inputProvenance,initialCheck,attempts};}
   if(!/^[a-f0-9]{64}$/.test(next.semanticSha256??''))
    return {status:'BLOCKED',reason:'unverified-retest-semantics',semanticNoOp:false,
      inferenceVerified:false,inputProvenance,initialCheck,attempts};
   if(seenAst.has(next.semanticSha256)){
    receipt.semanticNoOp=true;
    return {status:'BLOCKED',reason:'repeated-canonical-ast-failure',semanticNoOp:true,
      inferenceVerified:false,inputProvenance,initialCheck,attempts};
   }
   seenAst.add(next.semanticSha256);current=next.canonicalSource;
  }
 }
 return {status:'BLOCKED',reason:'corrective-call-budget-exhausted',semanticNoOp:false,inferenceVerified:false,inputProvenance,initialCheck,attempts};
}
// Report only bounded, public-synthetic retest facts; never serialize model code,
// exception text, the raw assertion or a fabricated zero-case count.
const FIXED_ARITHMETIC_CASES=[[2,3,5],[-4,3,-1],[0,0,0],[3,2,5],[-3,-2,-5],[9,0,9]];
export function summarizeRetestDiagnostic(attempt){
 const result={outcome:'UNVERIFIED',caseId:null,observedCaseCount:null};
 if(attempt?.failedStage!=='retest')return {...result,outcome:'NOT_RETEST'};
 const retest=attempt?.retest;
 const safetyCodes=new Set(['SOURCE_BOUNDS','SYNTAX_ERROR','STRUCTURAL_LIMIT','FUNCTION_SHAPE','ARGUMENT_SHAPE','EXPRESSION_NOT_ALLOWED','INPUT_FORMAT']);
 if(retest?.status==='SAFETY_REJECTED')return {...result,outcome:'SAFETY_REJECTED',
  ...(safetyCodes.has(retest.rejectCode)?{rejectCode:retest.rejectCode}:{})};
 if(retest?.status!=='ASSERTION_FAILURE')return result;
 const summary={...result,outcome:'ASSERTION_FAILURE'};
 // Only recognise a case from the fixed trusted six. An unfamiliar message stays unverified.
 if(typeof retest.failure!=='string'||retest.failure.length>120)return summary;
 const m=/^add\((-?\d{1,4}), (-?\d{1,4})\): expected (-?\d{1,6}), got (-?\d{1,30})$/.exec(retest.failure);
 if(!m)return summary;
 const index=FIXED_ARITHMETIC_CASES.findIndex(([a,b,want])=>
   a===Number(m[1])&&b===Number(m[2])&&want===Number(m[3]));
 if(index<0)return summary;
 return {...summary,caseId:'case-'+(index+1)};
}
export function summarizeModelProcesses(attempts){
 return {launchedProcesses:attempts.filter(a=>a.model?.launched===true).length,completedOutputProcesses:attempts.filter(a=>a.model?.kind==='observed-local-model-process'&&typeof a.model.rawResponse==='string').length};
}
export async function runCachedRecovery({baseSha,initialSource,sourceOrigin,artifacts,maxCalls=2}){
 const head=(await runBoundedProcess('/usr/bin/git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBytes:65536})).stdout.trim();
 if(baseSha!==head)throw Error('Requested base does not match HEAD');
 let modelInvocationsAttempted=0;
 const r=await runBoundedRecovery({baseSha,initialSource,sourceOrigin,maxCalls,builder:({request})=>{modelInvocationsAttempted++;return runLocalBuilder({request,artifacts})}});
 return {...r,modelInvocationsAttempted,...summarizeModelProcesses(r.attempts),verificationMeaning:'local synthetic recovery only, not independent review or full initial provenance'};
}
