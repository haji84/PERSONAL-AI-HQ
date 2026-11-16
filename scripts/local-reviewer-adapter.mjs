// Optional synthetic advisory adapter; no approval/write authority or downloads.
import {readFile,lstat,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {sha256,verifyBundle,runBoundedProcess} from './local-builder-adapter.mjs';
const profile=JSON.parse(await readFile(new URL('../tests/fixtures/local-reviewer/manifest.json',import.meta.url)));
const builder=JSON.parse(await readFile(new URL('../tests/fixtures/local-builder/manifest.json',import.meta.url)));
const wrapper=fileURLToPath(new URL('./local-model-limit.py',import.meta.url));
const candidates=new Map([
 ['e1a894022d1a082987b87adecb623438c9e386d86b2b621cff4a5fe7fdf7edc8','def add(a, b):\n    return a - b'],
 ['25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974','def add(a, b):\n    return a + b'],
]);
export function assertDifferentModel(b,r){
 if(!b||!r||typeof b.family!=='string'||typeof r.family!=='string'||!/^[a-f0-9]{64}$/.test(b.sha256)||!/^[a-f0-9]{64}$/.test(r.sha256)||b.sha256===r.sha256||b.family===r.family)throw Error('Distinct model identity required');return true;
}
export function parseReviewResponse(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>102400)throw Error('Invalid advisory response');
 let r;try{r=JSON.parse(raw)}catch{throw Error('Reviewer must return JSON only')}
 if(!r||Object.keys(r).sort().join(',')!=='example,reason,verdict'||!['defect','no_defect','uncertain'].includes(r.verdict)||typeof r.reason!=='string'||!r.reason.trim().length||Buffer.byteLength(r.reason)>2048||!r.example||Object.keys(r.example).sort().join(',')!=='a,actual,b,required')throw Error('Invalid advisory schema');
 for(const k of ['a','b','actual','required'])if(!Number.isSafeInteger(r.example[k])||Math.abs(r.example[k])>(['a','b'].includes(k)?9:18))throw Error('Invalid numeric witness');
 return r;
}
export function buildReviewerInvocation(request,model){
 if(!request||Object.keys(request).sort().join(',')!=='baseSha,source'||!/^[a-f0-9]{40}$/.test(request.baseSha)||typeof request.source!=='string')throw Error('Invalid synthetic review request');
 const sourceSha256=sha256(request.source),promptSource=candidates.get(sourceSha256);if(!promptSource)throw Error('Unapproved synthetic candidate');
 const prompt=`<|im_start|>system\nYou are an independent code reviewer. Review the supplied function against its stated requirement. Give an honest advisory assessment; use uncertain when unsure.\n<|im_end|>\n<|im_start|>user\nRequirement: add(a,b) returns the sum of a and b.\nCandidate ID: ${sourceSha256}\n${promptSource}\nReturn JSON with verdict (defect, no_defect, or uncertain), a short reason, and example containing integers a,b,actual,required. Choose a,b between -9 and 9. Report what the supplied function actually returns and what the requirement requires; both values must be between -18 and 18. Do not output code or commands.\n<|im_end|>\n<|im_start|>assistant\n`;
 const grammar=String.raw`root ::= "{\"verdict\":" verdict ",\"reason\":" string ",\"example\":{\"a\":" input ",\"b\":" input ",\"actual\":" output ",\"required\":" output "}}"
verdict ::= "\"defect\"" | "\"no_defect\"" | "\"uncertain\""
input ::= "-"? [0-9]
output ::= "-"? ([0-9] | "1" [0-8])
string ::= "\"" ([^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F]{4}))+ "\""`;
 const args=['--model',model,'--offline','--threads','2','--threads-batch','2','--ctx-size','1024','--n-predict','256','--gpu-layers','0','--batch-size','128','--no-conversation','--simple-io','--no-display-prompt','--color','off','--temp','0','--seed','42','--reverse-prompt','}}','--grammar',grammar,'--prompt',prompt];
 return {prompt,args,grammar,promptSource,sourceSha256,promptSourceSha256:sha256(promptSource)};
}
export async function verifyReviewerArtifacts({artifacts,modelProfile=profile,runtimeProfile=builder.runtime}){
 const runtime=await verifyBundle(artifacts.runtimeDir,runtimeProfile.files),model=resolve(artifacts.modelFile),stat=await lstat(model);
 if(!stat.isFile()||stat.size!==modelProfile.size||sha256(await readFile(model))!==modelProfile.sha256)throw Error('Reviewer model hash mismatch');
 return {runtime,model};
}
export async function runLocalReviewer({request,artifacts,profileId=profile.id}){
 let stage='profile';const receipt={schema:1,advisoryOnly:true,authority:'none',modelExecuted:false,formatValid:false,status:'FAILED'};
 try{
  if(profileId!==profile.id||!artifacts||Object.keys(artifacts).sort().join(',')!=='modelFile,runtimeDir')throw Error('Unreviewed reviewer profile');
  assertDifferentModel({family:'qwen2',sha256:builder.model.sha256},profile);
  stage='model-artifact';const {runtime,model}=await verifyReviewerArtifacts({artifacts});
  const invocation=buildReviewerInvocation(request,model),wrapperHash=sha256(await readFile(wrapper));
  Object.assign(receipt,{kind:'observed-local-reviewer-process',profile:profile.id,modelSha256:profile.sha256,modelFamily:profile.family,builderModelSha256:builder.model.sha256,runtimeManifestSha256:sha256(JSON.stringify(builder.runtime)),wrapperSha256:wrapperHash,adapterSha256:sha256(await readFile(new URL(import.meta.url))),requestSha256:sha256(JSON.stringify(request)),baseSha:request.baseSha,sourceSha256:invocation.sourceSha256,promptSourceSha256:invocation.promptSourceSha256,promptSha256:sha256(invocation.prompt),grammarSha256:sha256(invocation.grammar),bounds:{threads:2,context:1024,maxTokens:256,wallMs:180000,maxBytes:102400,addressSpaceBytes:4294967296,rss:'unmeasured'}});
  const cwd=await mkdtemp(join(tmpdir(),'hq-local-reviewer-'));receipt.startedAt=new Date().toISOString();const start=performance.now();stage='process';
  const r=await runBoundedProcess('/usr/bin/python3',['-I','-S',wrapper,join(runtime,builder.runtime.executable),...invocation.args],{cwd,env:{PATH:'/usr/bin:/bin',HOME:cwd,LD_LIBRARY_PATH:runtime,OMP_NUM_THREADS:'2'},timeoutMs:180000,maxBytes:102400});
  Object.assign(receipt,{modelExecuted:true,launched:true,terminated:true,exitCode:r.exitCode,wallMs:Math.round(performance.now()-start),rawResponse:r.stdout,rawResponseSha256:sha256(r.stdout),rawStderr:r.stderr,stderrSha256:sha256(r.stderr),evidenceCompleteness:{outputComplete:true}});
  stage='integrity';await verifyReviewerArtifacts({artifacts});if(wrapperHash!==sha256(await readFile(wrapper)))throw Error('Wrapper changed');
  stage='format';const advisory=parseReviewResponse(r.stdout);receipt.formatValid=true;receipt.status='OBSERVED';return {advisory,receipt};
 }catch(e){const cause=e.receipt;e.receipt={...receipt,status:'FAILED',failedStage:stage,error:e.message,...(cause?{cause}:{} )};throw e}
}
