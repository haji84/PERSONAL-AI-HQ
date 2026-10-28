// Optional, synthetic-only local builder. No authority, network, download or shell.
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,readdir,lstat,readlink,realpath,mkdtemp} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {parseBuilderResponse} from './builder-contract.mjs';
export const SEEDED_SOURCE='def add(a, b):\n    return a - b\n';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const manifest=JSON.parse(await readFile(new URL('../tests/fixtures/local-builder/manifest.json',import.meta.url),'utf8'));
export function validateSyntheticRequest(r){
 if(!r||!['baseSha,failure,taskId','baseSha,currentSource,currentSourceSha256,failure,taskId,testsSha256'].includes(Object.keys(r).sort().join(','))||r.taskId!=='synthetic-add-v1'||!/^[a-f0-9]{40}$/.test(r.baseSha)||typeof r.failure!=='string'||!/^add\(-?\d{1,4}, -?\d{1,4}\): expected -?\d{1,6}, got -?\d{1,30}$/.test(r.failure))throw Error('Invalid synthetic request');
 if('currentSource' in r&&(!/^def add\(a, b\):\n    return [ab0-9()+* -]{1,512}$/.test(r.currentSource)||sha256(r.currentSource)!==r.currentSourceSha256||!/^[a-f0-9]{64}$/.test(r.testsSha256)))throw Error('Invalid canonical recovery source');
 return r;
}
export async function verifyBundle(dir,expected){
 const root=await realpath(dir);const names=(await readdir(root)).sort();
 if(JSON.stringify(names)!==JSON.stringify(Object.keys(expected).sort()))throw Error('Unexpected runtime bundle members');
 for(const name of names){
  if(name!==basename(name)||name==='.'||name==='..')throw Error('Invalid bundle path');
  const p=join(root,name),s=await lstat(p),e=expected[name];
  if(e.link){
   if(!s.isSymbolicLink()||await readlink(p)!==e.link)throw Error('Invalid bundle symlink');
   let target=name;const seen=new Set();
   while(expected[target]?.link){
    if(seen.has(target)||seen.size>names.length)throw Error('Cyclic bundle link');
    seen.add(target);target=expected[target].link;
    if(target!==basename(target)||target==='.'||target==='..')throw Error('Escaping bundle link');
   }
   if(!expected[target]?.sha256||await realpath(p)!==join(root,target))throw Error('Escaping bundle link');
  }else if(!s.isFile()||sha256(await readFile(p))!==e.sha256)throw Error('Runtime hash mismatch');
 }
 return root;
}
// Low-level host API; never accepts command/args/env from model or Issue payload.
export function runBoundedProcess(command,args,{cwd,env,timeoutMs,maxBytes,input=''}={}){
 return new Promise((resolveResult,reject)=>{
  let child;try{child=spawn(command,args,{cwd,env,shell:false,stdio:['pipe','pipe','pipe']})}catch(e){reject(e);return}
  const out=[],err=[];let bytes=0,reason,launched=false;
  child.on('spawn',()=>{launched=true});
  const kill=why=>{reason??=why;child.kill('SIGKILL')};
  const timer=setTimeout(()=>kill('process timeout'),timeoutMs);
  for(const [stream,chunks] of [[child.stdout,out],[child.stderr,err]])stream.on('data',b=>{bytes+=b.length;if(bytes>maxBytes)kill('process output overflow');else chunks.push(b)});
  child.on('error',e=>{reason??=e.message});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  child.on('close',(code,signal)=>{
   clearTimeout(timer);const stdoutBytes=Buffer.concat(out),stderrBytes=Buffer.concat(err);
   const measured={launched,terminated:true,exitCode:code,signal,observedBytes:bytes,capturedBytes:stdoutBytes.length+stderrBytes.length,captureTruncated:bytes>maxBytes,capturedStdoutSha256:sha256(stdoutBytes),capturedStderrSha256:sha256(stderrBytes),stdoutBase64:stdoutBytes.toString('base64'),stderrBase64:stderrBytes.toString('base64'),evidenceCompleteness:{outputComplete:!reason,retainedAllObservedBytes:bytes<=maxBytes}};
   const fail=(message,stage)=>{const e=Error(message);e.receipt={...measured,schema:1,status:'FAILED',failedStage:stage,error:message};reject(e)};
   if(reason||code!==0)return fail(reason??`process exit ${code} ${signal??''}`,'process');
   try{const decode=b=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);resolveResult({stdout:decode(stdoutBytes),stderr:decode(stderrBytes),exitCode:code,bytes})}
   catch{return fail('Invalid UTF-8 process output','decode')}
  });
 });
}
export function parseSyntheticProposal(raw,request){
 validateSyntheticRequest(request);
 const p=parseBuilderResponse(raw,{expectedBaseSha:request.baseSha,allowedPaths:['fixture.py']});
 if(p.changes.length!==1||!p.changes[0].content.trim()||p.changes[0].content===SEEDED_SOURCE)throw Error('Empty or unchanged repair');
 return p;
}
export function acceptObservedResponse(raw,request,receipt){
 const observed={...receipt,rawResponse:raw,rawResponseSha256:sha256(raw)};
 try{const proposal=parseSyntheticProposal(raw,request);return {proposal,receipt:{...observed,proposalDigest:proposal.digest}}}
 catch(e){e.receipt={...observed,schema:1,status:'FAILED',failedStage:'proposal-parse',error:e.message,evidenceCompleteness:{outputComplete:true,proposalAvailable:false}};throw e}
}
export function buildSyntheticInvocation(request,model){
 validateSyntheticRequest(request);
 // JSON string production from the pinned upstream grammars/json.gbnf; no trailing ws.
 const prefix=`{"schema":1,"baseSha":"${request.baseSha}","changes":[{"path":"fixture.py","content":`;
 const grammar=`root ::= ${JSON.stringify(prefix)} string "}]}"\n`+String.raw`string ::= "\"" ([^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F]{4}))* "\""`;
 const prompt=`<|im_start|>system\nYou repair a public synthetic Python arithmetic fixture. Return only the requested JSON object, no prose.\n<|im_end|>\n<|im_start|>user\nImplement add(a,b) returning their sum. Current code:\n${request.currentSource??SEEDED_SOURCE}\nActual assertion failure: ${request.failure}\n${request.currentSource?'This previous candidate failed the immutable tests. You must not repeat or merely reformat it; correct the demonstrated arithmetic behavior.\n':''}Return minified JSON with schema=1, baseSha=${request.baseSha}, and one changes entry path=fixture.py. Put the actual repaired Python source in its content string. Do not use a placeholder. Only one function, one return, parameters a,b, arithmetic + - * and integers.\n<|im_end|>\n<|im_start|>assistant\n`;
 const args=['--model',model,'--offline','--threads','2','--threads-batch','2','--ctx-size','1024','--n-predict','256','--gpu-layers','0','--batch-size','128','--no-conversation','--simple-io','--no-display-prompt','--color','off','--temp','0','--seed','42','--reverse-prompt','}]}','--grammar',grammar,'--prompt',prompt];
 return {prompt,args,grammar};
}
export async function runLocalBuilder({request,profile=manifest.id,artifacts}){
 validateSyntheticRequest(request);
 if(profile!==manifest.id||!artifacts||Object.keys(artifacts).sort().join(',')!=='modelFile,runtimeDir')throw Error('Unreviewed local profile');
 const runtime=await verifyBundle(artifacts.runtimeDir,manifest.runtime.files);
 const model=resolve(artifacts.modelFile),stat=await lstat(model);
 if(!stat.isFile()||stat.size!==491400064||sha256(await readFile(model))!==manifest.model.sha256)throw Error('Model hash mismatch');
 const cwd=await mkdtemp(join(tmpdir(),'hq-local-builder-'));
 const {prompt,args,grammar}=buildSyntheticInvocation(request,model);
 const startedAt=new Date().toISOString(),start=performance.now();
 let r;try{r=await runBoundedProcess(join(runtime,manifest.runtime.executable),args,{cwd,env:{PATH:'/usr/bin:/bin',HOME:cwd,LD_LIBRARY_PATH:runtime,OMP_NUM_THREADS:'2'},timeoutMs:180000,maxBytes:102400})}
 catch(e){e.receipt={...e.receipt,schema:1,status:'FAILED',failedStage:e.receipt?.failedStage??'process',profile,startedAt,baseSha:request.baseSha,modelSha256:manifest.model.sha256,runtimeManifestSha256:sha256(JSON.stringify(manifest.runtime)),requestSha256:sha256(JSON.stringify(request)),promptSha256:sha256(prompt),grammarSha256:sha256(grammar),adapterSha256:sha256(await readFile(new URL(import.meta.url)))};throw e}
 return acceptObservedResponse(r.stdout,request,{kind:'observed-local-model-process',launched:true,terminated:true,startedAt,wallMs:Math.round(performance.now()-start),exitCode:r.exitCode,profile,modelSha256:manifest.model.sha256,runtimeManifestSha256:sha256(JSON.stringify(manifest.runtime)),adapterSha256:sha256(await readFile(new URL(import.meta.url))),requestSha256:sha256(JSON.stringify(request)),promptSha256:sha256(prompt),grammarSha256:sha256(grammar),proposalPathSha256:sha256('fixture.py'),rawResponseSha256:sha256(r.stdout),stderrSha256:sha256(r.stderr),rawStderr:r.stderr,baseSha:request.baseSha,bounds:{threads:2,context:1024,maxTokens:256,timeoutMs:180000,maxOutputBytes:102400},rawResponse:r.stdout});
}
