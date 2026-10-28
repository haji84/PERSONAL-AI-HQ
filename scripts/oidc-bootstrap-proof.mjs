// Inactive one-shot candidate. No credential request occurs on import.
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPOSITORY='haji84/PERSONAL-AI-HQ',REPOSITORY_ID='1437383396',OWNER_ID='173585154';
const BRANCH='feature/autonomous-manager-bootstrap',REF='refs/pull/11/merge';
const WORKFLOW=REPOSITORY+'/.github/workflows/hq-oidc-bootstrap-pr11-v1.yml@'+REF;
const ISSUER='https://token.actions.githubusercontent.com',JWKS_URL=ISSUER+'/.well-known/jwks';
const AUDIENCE='urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v1';
const SUBJECTS=['repo:'+REPOSITORY+':pull_request','repo:haji84@173585154/PERSONAL-AI-HQ@1437383396:pull_request'];
const PUBLIC_KEYS=['sub','repository','repository_id','repository_owner_id','ref','workflow_ref','workflow_sha','run_id','run_number','run_attempt','check_run_id'];
const TIMEOUT_MS=3000;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v);
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const repo=v=>object(v)&&v.id===Number(REPOSITORY_ID)&&v.full_name===REPOSITORY&&v.private===false&&v.owner?.id===Number(OWNER_ID);
function publicContext(context){
 const e=context.env,event=context.event;
 const required={GITHUB_ACTIONS:'true',GITHUB_SERVER_URL:'https://github.com',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:REPOSITORY,GITHUB_REPOSITORY_ID:REPOSITORY_ID,GITHUB_REPOSITORY_OWNER_ID:OWNER_ID,GITHUB_REF:REF,GITHUB_HEAD_REF:BRANCH,GITHUB_BASE_REF:'main',GITHUB_RUN_NUMBER:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:WORKFLOW,RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux'};
 if(!object(e)||!Object.entries(required).every(([key,value])=>e[key]===value))throw Error();
 if(!id(e.GITHUB_RUN_ID)||!id(e.HQ_BOOTSTRAP_CHECK_RUN_ID)||!sha(e.GITHUB_WORKFLOW_SHA)||!sha(e.GITHUB_SHA)||!sha(e.HQ_BOOTSTRAP_SOURCE_SHA)||e.HQ_BOOTSTRAP_SOURCE_SHA!==e.HQ_BOOTSTRAP_CHECKOUT_SHA)throw Error();
 if(!object(event)||event.action!=='synchronize'||event.number!==11||!repo(event.repository)||event.pull_request?.number!==11||event.pull_request.head?.ref!==BRANCH||event.pull_request.base?.ref!=='main'||!repo(event.pull_request.head.repo)||!repo(event.pull_request.base.repo))throw Error();
 return {run_id:e.GITHUB_RUN_ID,run_number:'1',run_attempt:'1',check_run_id:e.HQ_BOOTSTRAP_CHECK_RUN_ID,workflow_sha:e.GITHUB_WORKFLOW_SHA};
}
function mintParameters(env){
 // Runtime request credential getters are deliberately read only after publicContext.
 const raw=env.ACTIONS_ID_TOKEN_REQUEST_URL;
 if(!text(raw,2048))throw Error();
 const authority=raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
 if(!authority||/[:@\\]/.test(authority))throw Error();
 const url=new URL(raw);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!url.hostname.endsWith('.actions.githubusercontent.com'))throw Error();
 if([...url.searchParams.keys()].some(key=>key.toLowerCase()==='audience'))throw Error();
 const credential=env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
 if(!text(credential,16384)||/\s/u.test(credential))throw Error();
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
function validClaims(payload,expected,now){
 const fixed={iss:ISSUER,aud:AUDIENCE,repository:REPOSITORY,repository_id:REPOSITORY_ID,repository_owner_id:OWNER_ID,repository_visibility:'public',event_name:'pull_request',head_ref:BRANCH,base_ref:'main',ref:REF,workflow_ref:WORKFLOW,...expected};
 if(!object(payload)||!Object.entries(fixed).every(([key,value])=>payload[key]===value)||!SUBJECTS.includes(payload.sub)||['environment','job_workflow_ref','job_workflow_sha'].some(key=>Object.hasOwn(payload,key)))return false;
 for(const key of ['iat','nbf','exp'])if(!Number.isSafeInteger(payload[key])||payload[key]<0)return false;
 return payload.nbf<=now&&payload.iat<=now&&now<payload.exp&&payload.nbf<payload.exp&&payload.exp-payload.iat<=600&&now-payload.iat<=600;
}
export async function runBootstrapProof(context,dependencies={}){
 let token,credential;
 try{
  const expected=publicContext(context);const {jwtVerify,createLocalJWKSet}=await import('jose');
  const fetcher=dependencies.fetch??globalThis.fetch,clock=dependencies.now??Date.now;if(typeof fetcher!=='function'||typeof clock!=='function')throw Error();
  const start=clock();if(!Number.isSafeInteger(start)||start<0)throw Error();
  const request=mintParameters(context.env);credential=request.credential;
  const envelope=await requestJson(fetcher,request.url,32768,credential);credential=undefined;
  if(!object(envelope))throw Error();token=envelope.value;const header=tokenHeader(token);
  const jwks=publicJwks(await requestJson(fetcher,JWKS_URL,65536),header.kid);
  const verifiedAt=clock();if(!Number.isSafeInteger(verifiedAt)||verifiedAt<start)throw Error();
  const {payload}=await jwtVerify(token,createLocalJWKSet(jwks),{algorithms:['RS256'],issuer:ISSUER,audience:AUDIENCE,typ:'JWT',clockTolerance:0,maxTokenAge:600,currentDate:new Date(verifiedAt),requiredClaims:[...PUBLIC_KEYS,'iat','nbf','exp','repository_visibility','event_name','head_ref','base_ref']});
  const finished=clock();if(!Number.isSafeInteger(finished)||finished<verifiedAt||!validClaims(payload,expected,Math.floor(finished/1000)))throw Error();
  const proof={};for(const name of PUBLIC_KEYS)proof[name]=payload[name];return proof;
 }catch{return null;}finally{token=undefined;credential=undefined;}
}
async function eventFile(path){
 if(!text(path,4096))throw Error();const file=await open(path,'r');
 try{if(!(await file.stat()).isFile())throw Error();const buffer=Buffer.alloc(1048577);let total=0;while(total<buffer.length){const {bytesRead}=await file.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead;}if(total>1048576)throw Error();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,total)));}finally{await file.close();}
}
async function main(){
 try{if(process.argv.length!==3||process.argv[2]!=='--github-oidc-bootstrap-once'||process.env.GITHUB_ACTIONS!=='true')throw Error();
  const proof=await runBootstrapProof({env:process.env,event:await eventFile(process.env.GITHUB_EVENT_PATH)});if(!proof)throw Error();process.stdout.write(JSON.stringify(proof)+'\n');
 }catch{process.stderr.write('OIDC_BOOTSTRAP_FAILED\n');process.exitCode=1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
