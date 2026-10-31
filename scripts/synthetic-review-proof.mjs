// Host-hidden expectations and deterministic advisory checking. No approval authority.
import {readFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {sha256,runBoundedProcess} from './local-builder-adapter.mjs';
import {runArithmeticCheck} from './synthetic-builder-proof.mjs';
import {runLocalReviewer,parseReviewResponse,buildReviewerInvocation,verifyReviewerArtifacts} from './local-reviewer-adapter.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const oracle=fileURLToPath(new URL('./review-witness-check.py',import.meta.url));
const recoveryContract=JSON.parse(await readFile(new URL('../tests/fixtures/local-reviewer/recovery-predecessor.json',import.meta.url)));
const fixtures=[
 {source:'def add(a, b):\n    return a - b\n',sha256:'e1a894022d1a082987b87adecb623438c9e386d86b2b621cff4a5fe7fdf7edc8',expected:'defect',origin:'host-seeded'},
 {source:'def add(a,b): return a + b',sha256:'25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974',expected:'no_defect',origin:'observed-Qwen-output',originalResponseSha256:'6caa3c55f5ed5bc1ccedaa1cee83f866952ee508f271e9887ac895d7621360a0',upstreamRecoveredInputComplete:false},
];
const frozenFiles=['scripts/local-reviewer-adapter.mjs','scripts/synthetic-review-proof.mjs','scripts/local-model-limit.py','scripts/review-witness-check.py','scripts/local-builder-adapter.mjs','scripts/synthetic-python-check.py','scripts/synthetic-builder-proof.mjs','tests/fixtures/local-reviewer/manifest.json','tests/fixtures/local-builder/manifest.json','tests/fixtures/local-reviewer/recovery-predecessor.json'];
export async function captureReviewIdentity(){
 const values={};for(const path of frozenFiles)values[path]=sha256(await readFile(join(root,path)));
 values.hostExpectedMap=sha256(JSON.stringify(fixtures));return values;
}
export function assertFrozenIdentity(before,after){if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Frozen review identity changed')}
export function assertPromptNormalization(invocation,pre,oracleResult){
 if(invocation.promptSource!==pre.canonicalSource||invocation.promptSource!==oracleResult.canonicalSource||invocation.promptSourceSha256!==sha256(pre.canonicalSource))throw Error('Prompt normalization mismatch');
}
export function terminalizeProofFailure(result,error,stage,selected=fixtures){
 result.status='INVALIDATED';result.error=error.message;
 for(const c of result.cases){c.caseAgreement=false;if(c.status==='PENDING'){c.status='FAILED';c.failedStage=stage;c.error=error.message}else if(c.status!=='SKIPPED'){c.priorStatus=c.status;c.status='INVALIDATED'}}
 for(const f of [...selected].sort((a,b)=>a.sha256.localeCompare(b.sha256)))if(!result.cases.some(c=>c.sourceSha256===f.sha256))result.cases.push({sourceSha256:f.sha256,origin:f.origin,status:'SKIPPED',reason:`earlier ${stage} failure`,modelExecuted:false,formatValid:false,witnessValid:false,caseAgreement:false});
 return result;
}
export async function checkWitness(source,example=null){
 const cwd=await mkdtemp(join(tmpdir(),'hq-review-oracle-'));
 const r=await runBoundedProcess('/usr/bin/python3',['-I','-S',oracle],{cwd,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBytes:65536,input:JSON.stringify({source,example})});
 const v=JSON.parse(r.stdout);if(!['PASS','ASSERTION_FAILURE'].includes(v.testStatus)||v.caseCount!==6||!/^[a-f0-9]{64}$/.test(v.testsSha256)||!/^[a-f0-9]{64}$/.test(v.astSha256))throw Error('Invalid oracle response');return v;
}
export function selectReviewFixtures(hashes){
 if(hashes===undefined)return fixtures.map(f=>({...f}));
 if(!Array.isArray(hashes)||hashes.length<1||hashes.length>2||new Set(hashes).size!==hashes.length||hashes.some(h=>!fixtures.some(f=>f.sha256===h)))throw Error('Invalid review fixture selector');
 return fixtures.filter(f=>hashes.includes(f.sha256)).map(f=>({...f}));
}
export function validateReviewPredecessor(bytes,contract=recoveryContract){
 if(!Buffer.isBuffer(bytes)||bytes.length!==contract.receiptSize||sha256(bytes)!==contract.receiptSha256)throw Error('Unpinned review predecessor');
 let prior;try{prior=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('Invalid predecessor JSON')}
 const c=prior.cases?.find(c=>c.sourceSha256===contract.sourceSha256),r=c?.processReceipt;
 if(prior.actualModelProof!==true||prior.modelInvocationsAttempted!==2||c?.status!=='FAILED'||c?.failedStage!=='format'||c?.formatValid!==false||c?.witnessValid!==false||c?.caseAgreement!==false||typeof r?.rawResponse!=='string'||r.modelSha256!==contract.modelSha256||sha256(r.rawResponse)!==contract.rawResponseSha256||r.rawResponseSha256!==contract.rawResponseSha256)throw Error('Invalid predecessor failure identity');
 let response;try{response=JSON.parse(r.rawResponse)}catch{throw Error('Invalid predecessor model response')}
 if(response.reason!=='')throw Error('Predecessor was not empty-reason failure');
 return {receiptSha256:contract.receiptSha256,receiptBytes:contract.receiptSize,sourceSha256:contract.sourceSha256,rawResponseSha256:contract.rawResponseSha256,originalOutcome:'schema-rejected-empty-reason-unchanged'};
}
// Injection is a test seam, not actual-model proof or authority.
export async function runReviewProof({baseSha,reviewer,selectedSourceHashes}){
 if(!/^[a-f0-9]{40}$/.test(baseSha))throw Error('Invalid base');
 const selected=selectReviewFixtures(selectedSourceHashes);
 const frozen=await captureReviewIdentity();const result={schema:1,status:'OBSERVED',advisoryOnly:true,authority:'none',actualModelProof:false,selectedCaseCount:selected.length,reviewCompetenceClaim:'only measured agreement on selected synthetic fixtures; no security/release authority',baseSha,frozenIdentity:frozen,cases:[]};let stop,outerStage='preflight';
 try{
  for(const f of [...selected].sort((a,b)=>a.sha256.localeCompare(b.sha256))){
   const c={sourceSha256:f.sha256,origin:f.origin,...(f.originalResponseSha256?{originalResponseSha256:f.originalResponseSha256,upstreamRecoveredInputComplete:false}:{}),modelExecuted:false,formatValid:false,witnessValid:false,caseAgreement:false,status:'PENDING'};result.cases.push(c);
   if(stop){c.status='SKIPPED';c.reason=stop;continue}
   outerStage='integrity';assertFrozenIdentity(frozen,await captureReviewIdentity());if(sha256(f.source)!==f.sha256)throw Error('Fixture hash changed');
   outerStage='oracle';const pre=await runArithmeticCheck(f.source),interpretation=await checkWitness(f.source);
   if(pre.testsSha256!==interpretation.testsSha256||pre.status!==interpretation.testStatus||pre.canonicalSource!==interpretation.canonicalSource)throw Error('Oracle disagreement');
   c.oracleBefore=interpretation;c.fixedTestsBefore=pre;
   const request={baseSha,source:f.source};const invocation=buildReviewerInvocation(request,'/host-selected/model.gguf');
   outerStage='normalization';assertPromptNormalization(invocation,pre,interpretation);
   c.requestSha256=sha256(JSON.stringify(request));c.promptSourceSha256=invocation.promptSourceSha256;c.promptSha256=sha256(invocation.prompt);c.grammarSha256=sha256(invocation.grammar);
   try{
    const observed=await reviewer({request});c.processReceipt=observed.receipt;
    c.executionClaimed=observed.receipt?.modelExecuted===true;
    const advisory=parseReviewResponse(JSON.stringify(observed.advisory));c.formatValid=true;c.advisory=advisory;c.reasonEvidenceClass='AI_ASSERTED';
    c.oracleAfter=await checkWitness(f.source,advisory.example);c.fixedTestsAfter=await runArithmeticCheck(f.source);
    if(c.oracleAfter.testsSha256!==pre.testsSha256||c.fixedTestsAfter.testsSha256!==pre.testsSha256||c.fixedTestsAfter.status!==pre.status)throw Error('Tests changed');
    c.witnessValid=c.oracleAfter.witnessValid;
    const justified=advisory.verdict==='defect'?c.oracleAfter.mismatch:advisory.verdict==='no_defect'?!c.oracleAfter.mismatch&&c.oracleAfter.testStatus==='PASS':false;
    c.caseAgreement=c.witnessValid&&justified&&advisory.verdict===f.expected;c.status=c.caseAgreement?'ADVISORY_AGREEMENT':'INCONCLUSIVE';
   }catch(e){
    c.status='FAILED';c.error=e.message;if(e.receipt)c.processReceipt=e.receipt;c.executionClaimed=c.processReceipt?.modelExecuted===true;
    const stage=e.receipt?.failedStage??'verification';c.failedStage=stage;if(stage!=='format')stop=`earlier ${stage} failure`;
   }
   outerStage='integrity';assertFrozenIdentity(frozen,await captureReviewIdentity());
  }
  assertFrozenIdentity(frozen,await captureReviewIdentity());return result;
 }catch(e){return terminalizeProofFailure(result,e,outerStage,selected)}
}
export async function runActualReviewProof({baseSha,artifacts,selectedSourceHashes}){
 const selected=selectReviewFixtures(selectedSourceHashes);
 const head=(await runBoundedProcess('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBytes:65536})).stdout.trim();if(baseSha!==head)throw Error('Review base does not match HEAD');
 const dirty=Boolean((await runBoundedProcess('/usr/bin/git',['status','--porcelain'],{cwd:root,env:{PATH:'/usr/bin:/bin'},timeoutMs:5000,maxBytes:65536})).stdout.trim());
 await verifyReviewerArtifacts({artifacts});
 let invocations=0;const result=await runReviewProof({baseSha,selectedSourceHashes,reviewer:({request})=>{if(++invocations>selected.length)throw Error('Review call budget exceeded');return runLocalReviewer({request,artifacts})}});
 try{await verifyReviewerArtifacts({artifacts})}catch(e){terminalizeProofFailure(result,e,'artifacts',selected)}
 for(const c of result.cases)c.modelExecuted=c.processReceipt?.kind==='observed-local-reviewer-process'&&c.processReceipt?.modelExecuted===true&&c.processReceipt?.modelSha256==='decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33';
 return {...result,repository:{head,dirty},modelInvocationsAttempted:invocations,actualModelProof:result.status!=='INVALIDATED'&&result.cases.every(c=>c.processReceipt?.kind==='observed-local-reviewer-process'&&c.modelExecuted)};
}

export async function runActualReviewRecovery({baseSha,artifacts,predecessorBytes}){
 const predecessor=validateReviewPredecessor(predecessorBytes);
 const selected=selectReviewFixtures([recoveryContract.sourceSha256]);
 const invocation=buildReviewerInvocation({baseSha,source:selected[0].source},'/host-selected/model.gguf');
 if(sha256(invocation.prompt)!==recoveryContract.promptSha256)throw Error('Recovery prompt changed');
 const result=await runActualReviewProof({baseSha,artifacts,selectedSourceHashes:[recoveryContract.sourceSha256]});
 if(result.modelInvocationsAttempted>recoveryContract.maxFreshCalls)throw Error('Recovery call budget violated');
 return {...result,scope:'single-fixture-structural-recovery',predecessor,originalPairOutcome:'one accepted advisory and one schema rejection remain unchanged',maxFreshCalls:1};
}
