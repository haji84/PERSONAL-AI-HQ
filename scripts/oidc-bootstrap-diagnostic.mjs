// Inactive diagnostic successor. Fixed v2 identity is preparation only; no new live run is authorized.
// Diagnostic enums are informational only and never relax validation or prove token issuance.
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPOSITORY='haji84/PERSONAL-AI-HQ',REPOSITORY_ID='1437383396',OWNER_ID='173585154';
const BRANCH='feature/autonomous-manager-bootstrap',REF='refs/pull/11/merge';
const WORKFLOW=REPOSITORY+'/.github/workflows/hq-oidc-bootstrap-pr11-v2.yml@'+REF;
const ISSUER='https://token.actions.githubusercontent.com',JWKS_URL=ISSUER+'/.well-known/jwks';
const AUDIENCE='urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v2';
const SUBJECTS=['repo:'+REPOSITORY+':pull_request','repo:haji84@173585154/PERSONAL-AI-HQ@1437383396:pull_request'];
const PUBLIC_KEYS=['sub','repository','repository_id','repository_owner_id','ref','workflow_ref','workflow_sha','run_id','run_number','run_attempt','check_run_id'];
const STAGES=new Set(['ENTRYPOINT','CONTEXT','DEPENDENCY','CLOCK','MINT_CONFIGURATION','MINT_TRANSPORT','TOKEN_FORMAT','JWKS_TRANSPORT','JWKS_FORMAT','JWT_VERIFICATION','SIGNATURE','REGISTERED_CLAIMS','CLAIM_IDENTITY','CLAIM_SUBJECT','CLAIM_OPTIONAL','CLAIM_TIME']);
const FIELDS=new Set(['NONE','ARGS','EVENT_FILE','GITHUB_ACTIONS','GITHUB_SERVER_URL','GITHUB_EVENT_NAME','GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','GITHUB_REPOSITORY_OWNER_ID','GITHUB_REF','GITHUB_HEAD_REF','GITHUB_BASE_REF','GITHUB_RUN_NUMBER','GITHUB_RUN_ATTEMPT','GITHUB_RUN_ID','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','GITHUB_SHA','RUNNER_ENVIRONMENT','RUNNER_OS','HQ_BOOTSTRAP_SOURCE_SHA','HQ_BOOTSTRAP_CHECKOUT_SHA','HQ_BOOTSTRAP_CHECK_RUN_ID','EVENT_FIELDS','REQUEST_URL','REQUEST_CREDENTIAL','iss','aud','repository','repository_id','repository_owner_id','repository_visibility','event_name','head_ref','base_ref','ref','workflow_ref','workflow_sha','run_id','run_number','run_attempt','check_run_id','sub','environment','job_workflow_ref','job_workflow_sha','iat','nbf','exp','LIFETIME','TOKEN_AGE']);
const REGISTERED_FIELDS=new Set(['iss','aud','iat','nbf','exp']);
const VERIFICATION_FIELDS=new Set([...PUBLIC_KEYS,'iss','aud','iat','nbf','exp','repository_visibility','event_name','head_ref','base_ref']);
function failure(stage,field='NONE'){
 return {ok:false,stage:STAGES.has(stage)?stage:'ENTRYPOINT',field:FIELDS.has(field)?field:'NONE'};
}
class DiagnosticFailure extends Error{
 constructor(stage,field){super();const result=failure(stage,field);this.stage=result.stage;this.field=result.field;}
}
const deny=(stage,field='NONE')=>{throw new DiagnosticFailure(stage,field);};
function unexpected(error,stage,field='NONE'){
 try{if(error instanceof DiagnosticFailure)return failure(error.stage,error.field);}catch{}
 return failure(stage,field);
}
// Pure informational seam. Never reads message, stack, payload, cause, or token properties.
export async function classifyVerificationFailure(error){
 let stage='JWT_VERIFICATION';
 try{
  const {errors}=await import('jose');
  if(error instanceof errors.JWSSignatureVerificationFailed)return {stage:'SIGNATURE',field:'NONE'};
  const expired=error instanceof errors.JWTExpired;
  if(expired||error instanceof errors.JWTClaimValidationFailed){
   stage=expired?'REGISTERED_CLAIMS':'JWT_VERIFICATION';let field='NONE';
   try{const claim=error.claim;if(VERIFICATION_FIELDS.has(claim)){field=claim;stage=REGISTERED_FIELDS.has(claim)?'REGISTERED_CLAIMS':'JWT_VERIFICATION';}}catch{}
   return {stage,field};
  }
 }catch{}
 return {stage,field:'NONE'};
}
const TIMEOUT_MS=3000;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v);
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const repo=v=>object(v)&&v.id===Number(REPOSITORY_ID)&&v.full_name===REPOSITORY&&v.private===false&&v.owner?.id===Number(OWNER_ID);
function publicContext(context){
 const e=context.env,event=context.event;
 const required={GITHUB_ACTIONS:'true',GITHUB_SERVER_URL:'https://github.com',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:REPOSITORY,GITHUB_REPOSITORY_ID:REPOSITORY_ID,GITHUB_REPOSITORY_OWNER_ID:OWNER_ID,GITHUB_REF:REF,GITHUB_HEAD_REF:BRANCH,GITHUB_BASE_REF:'main',GITHUB_RUN_NUMBER:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:WORKFLOW,RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux'};
 if(!object(e))deny('CONTEXT');
 for(const [key,value]of Object.entries(required))if(e[key]!==value)deny('CONTEXT',key);
 for(const key of ['GITHUB_RUN_ID','HQ_BOOTSTRAP_CHECK_RUN_ID'])if(!id(e[key]))deny('CONTEXT',key);
 for(const key of ['GITHUB_WORKFLOW_SHA','GITHUB_SHA','HQ_BOOTSTRAP_SOURCE_SHA'])if(!sha(e[key]))deny('CONTEXT',key);
 if(e.HQ_BOOTSTRAP_SOURCE_SHA!==e.HQ_BOOTSTRAP_CHECKOUT_SHA)deny('CONTEXT','HQ_BOOTSTRAP_CHECKOUT_SHA');
 if(!object(event)||event.action!=='synchronize'||event.number!==11||!repo(event.repository)||event.pull_request?.number!==11||event.pull_request.head?.ref!==BRANCH||event.pull_request.base?.ref!=='main'||!repo(event.pull_request.head.repo)||!repo(event.pull_request.base.repo))deny('CONTEXT','EVENT_FIELDS');
 return {run_id:e.GITHUB_RUN_ID,run_number:'1',run_attempt:'1',check_run_id:e.HQ_BOOTSTRAP_CHECK_RUN_ID,workflow_sha:e.GITHUB_WORKFLOW_SHA};
}
function mintParameters(env){
 // Runtime credential getters remain inaccessible until publicContext succeeds.
 const raw=env.ACTIONS_ID_TOKEN_REQUEST_URL;
 if(!text(raw,2048))deny('MINT_CONFIGURATION','REQUEST_URL');
 const authority=raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
 if(!authority||/[:@\\]/.test(authority))deny('MINT_CONFIGURATION','REQUEST_URL');
 let url;try{url=new URL(raw);}catch{deny('MINT_CONFIGURATION','REQUEST_URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!url.hostname.endsWith('.actions.githubusercontent.com'))deny('MINT_CONFIGURATION','REQUEST_URL');
 if([...url.searchParams.keys()].some(key=>key.toLowerCase()==='audience'))deny('MINT_CONFIGURATION','REQUEST_URL');
 const credential=env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
 if(!text(credential,16384)||/\s/u.test(credential))deny('MINT_CONFIGURATION','REQUEST_CREDENTIAL');
 url.searchParams.set('audience',AUDIENCE);
 return {url:url.href,credential};
}
function canonical(value,max){
 if(typeof value!=='string'||value.length===0||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
 const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw Error();return bytes;
}
function tokenHeader(token){
 if(typeof token!=='string'||token.length>16384)throw Error();const parts=token.split('.');if(parts.length!==3)throw Error();
 for(const part of parts)canonical(part,16384);
 const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(canonical(parts[0],16384)));
 if(!object(header)||header.alg!=='RS256'||header.typ!=='JWT'||!text(header.kid,128)||['crit','b64','jku','jwk','x5u','x5c'].some(key=>Object.hasOwn(header,key)))throw Error();
 return header;
}
function publicJwks(value,kid){
 if(!object(value)||!Array.isArray(value.keys)||value.keys.length===0||value.keys.length>20)throw Error();const seen=new Set(),keys=[];
 for(const key of value.keys){
  if(!object(key)||key.kty!=='RSA'||key.alg!=='RS256'||!text(key.kid,128)||seen.has(key.kid)||['d','p','q','dp','dq','qi','oth','k'].some(name=>Object.hasOwn(key,name)))throw Error();
  if(Object.hasOwn(key,'use')&&key.use!=='sig')throw Error();if(Object.hasOwn(key,'key_ops')&&(!Array.isArray(key.key_ops)||key.key_ops.length!==1||key.key_ops[0]!=='verify'))throw Error();
  const n=canonical(key.n,1366),e=canonical(key.e,6);if(!n[0]||!e[0]||e.length>4)throw Error();
  const bits=(n.length-1)*8+32-Math.clz32(n[0]),exponent=e.reduce((a,b)=>a*256+b,0);if(bits<2048||bits>8192||exponent<3||exponent%2!==1)throw Error();
  seen.add(key.kid);keys.push({kty:'RSA',kid:key.kid,alg:'RS256',use:'sig',key_ops:['verify'],n:key.n,e:key.e});
 }
 if(!seen.has(kid))throw Error();return {keys};
}
async function boundedJson(response,limit,signal){
 const length=response.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>limit))throw Error();
 if(response.status!==200||response.redirected||!response.body)throw Error();const reader=response.body.getReader(),chunks=[];let total=0,complete=false;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{
  while(true){if(signal.aborted)throw Error();const {done,value}=await reader.read();if(done){complete=true;break;}total+=value.byteLength;if(total>limit)throw Error();chunks.push(value);}
  if(signal.aborted)throw Error();const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{signal.removeEventListener('abort',abort);if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function requestJson(fetch,url,limit,credential){
 const controller=new AbortController();let timer;
 try{
  const headers={accept:'application/json'};if(credential!==undefined)headers.authorization='Bearer '+credential;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},TIMEOUT_MS);});
  return await Promise.race([(async()=>boundedJson(await fetch(url,{method:'GET',redirect:'error',credentials:'omit',headers,signal:controller.signal}),limit,controller.signal))(),timeout]);
 }finally{clearTimeout(timer);controller.abort();}
}
function validateClaims(payload,expected,now){
 const fixed={iss:ISSUER,aud:AUDIENCE,repository:REPOSITORY,repository_id:REPOSITORY_ID,repository_owner_id:OWNER_ID,repository_visibility:'public',event_name:'pull_request',head_ref:BRANCH,base_ref:'main',ref:REF,workflow_ref:WORKFLOW,...expected};
 if(!object(payload))deny('CLAIM_IDENTITY');
 for(const [key,value]of Object.entries(fixed))if(payload[key]!==value)deny('CLAIM_IDENTITY',key);
 if(!SUBJECTS.includes(payload.sub))deny('CLAIM_SUBJECT','sub');
 for(const key of ['environment','job_workflow_ref','job_workflow_sha'])if(Object.hasOwn(payload,key))deny('CLAIM_OPTIONAL',key);
 for(const key of ['iat','nbf','exp'])if(!Number.isSafeInteger(payload[key])||payload[key]<0)deny('CLAIM_TIME',key);
 if(payload.nbf>now)deny('CLAIM_TIME','nbf');
 if(payload.iat>now)deny('CLAIM_TIME','iat');
 if(now>=payload.exp||payload.nbf>=payload.exp)deny('CLAIM_TIME','exp');
 if(payload.exp-payload.iat>600)deny('CLAIM_TIME','LIFETIME');
 if(now-payload.iat>600)deny('CLAIM_TIME','TOKEN_AGE');
}
export async function runBootstrapDiagnostic(context,dependencies={}){
 let token,credential,stage='CONTEXT';
 try{
  const expected=publicContext(context);stage='DEPENDENCY';const {jwtVerify,createLocalJWKSet}=await import('jose');
  const fetcher=dependencies.fetch??globalThis.fetch,clock=dependencies.now??Date.now;if(typeof fetcher!=='function'||typeof clock!=='function')throw Error();
  stage='CLOCK';const start=clock();if(!Number.isSafeInteger(start)||start<0)throw Error();
  stage='MINT_CONFIGURATION';const request=mintParameters(context.env);credential=request.credential;
  // Entering this stage means request execution was attempted, not that a token was issued.
  stage='MINT_TRANSPORT';const envelope=await requestJson(fetcher,request.url,32768,credential);credential=undefined;
  stage='TOKEN_FORMAT';if(!object(envelope))throw Error();token=envelope.value;const header=tokenHeader(token);
  stage='JWKS_TRANSPORT';const keySet=await requestJson(fetcher,JWKS_URL,65536);
  stage='JWKS_FORMAT';const jwks=publicJwks(keySet,header.kid);
  stage='CLOCK';const verifiedAt=clock();if(!Number.isSafeInteger(verifiedAt)||verifiedAt<start)throw Error();
  stage='JWT_VERIFICATION';let payload;
  try{({payload}=await jwtVerify(token,createLocalJWKSet(jwks),{algorithms:['RS256'],issuer:ISSUER,audience:AUDIENCE,typ:'JWT',clockTolerance:0,maxTokenAge:600,currentDate:new Date(verifiedAt),requiredClaims:[...PUBLIC_KEYS,'iat','nbf','exp','repository_visibility','event_name','head_ref','base_ref']}));}
  catch(error){const result=await classifyVerificationFailure(error);return failure(result.stage,result.field);}
  stage='CLOCK';const finished=clock();if(!Number.isSafeInteger(finished)||finished<verifiedAt)throw Error();
  stage='CLAIM_IDENTITY';validateClaims(payload,expected,Math.floor(finished/1000));
  const proof={};for(const name of PUBLIC_KEYS)proof[name]=payload[name];return {ok:true,proof};
 }catch(error){return unexpected(error,stage);}finally{token=undefined;credential=undefined;}
}
async function eventFile(path){
 if(!text(path,4096))throw Error();const file=await open(path,'r');
 try{if(!(await file.stat()).isFile())throw Error();const buffer=Buffer.alloc(1048577);let total=0;while(total<buffer.length){const {bytesRead}=await file.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead;}if(total>1048576)throw Error();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,total)));}finally{await file.close();}
}
function emitFailure(result){
 const bounded=failure(result.stage,result.field);
 process.stderr.write('OIDC_BOOTSTRAP_FAILED stage='+bounded.stage+' field='+bounded.field+'\n');process.exitCode=1;
}
async function main(){
 let field='ARGS';
 try{
  if(process.argv.length!==3||process.argv[2]!=='--github-oidc-bootstrap-once'||process.env.GITHUB_ACTIONS!=='true')deny('ENTRYPOINT','ARGS');
  field='EVENT_FILE';const event=await eventFile(process.env.GITHUB_EVENT_PATH);
  const result=await runBootstrapDiagnostic({env:process.env,event});
  if(!result.ok){emitFailure(result);return;}process.stdout.write(JSON.stringify(result.proof)+'\n');
 }catch(error){emitFailure(unexpected(error,'ENTRYPOINT',field));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
