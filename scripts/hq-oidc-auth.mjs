// Local-only candidate. Never enabled by the default authority Worker.
import {base64url,createLocalJWKSet,decodeProtectedHeader,jwtVerify} from 'jose';

const ISSUER='https://token.actions.githubusercontent.com';
const JWKS_URL=ISSUER+'/.well-known/jwks';
const REPOSITORY='haji84/PERSONAL-AI-HQ';
const REPOSITORY_ID='1437383396',OWNER_ID='173585154';
const MAX_TOKEN=16384,MAX_JWKS=65536,CACHE_MS=300000,REFRESH_MS=30000,TIMEOUT_MS=3000;
const TUPLE_KEYS=['sub','workflow_ref','workflow_sha','ref','event_name','environment','job_workflow_ref','job_workflow_sha'];
const OPTIONAL=['environment','job_workflow_ref','job_workflow_sha'];
const REQUIRED=['iss','aud','sub','iat','nbf','exp','repository','repository_id','repository_owner_id','workflow_ref','workflow_sha','ref','event_name','run_id','run_attempt','check_run_id'];
const BLOCKED_HEADER=['crit','b64','jku','jwk','x5u','x5c'];
const PRIVATE_JWK=['d','p','q','dp','dq','qi','oth','k'];
const encoder=new TextEncoder();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);
const id=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
function exactKeys(value,keys){return object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function tupleValid(value){
 return exactKeys(value,TUPLE_KEYS)&&text(value.sub,1024)&&text(value.workflow_ref,512)&&sha(value.workflow_sha)&&text(value.ref,255)&&text(value.event_name,80)&&
 (value.environment===null||text(value.environment,255))&&
 ((value.job_workflow_ref===null&&value.job_workflow_sha===null)||(text(value.job_workflow_ref,512)&&sha(value.job_workflow_sha)));
}
function policySnapshot(config){
 if(!exactKeys(config,['audience','goal','allowed'])||!text(config.audience,512)||config.audience.startsWith('urn:personal-ai-hq:oidc-bootstrap:')||!(typeof config.goal==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(config.goal))||!Array.isArray(config.allowed)||config.allowed.length===0||config.allowed.length>32)throw Error();
 if(!config.allowed.every(tupleValid))throw Error();
 return {audience:config.audience,goal:config.goal,allowed:config.allowed.map(tuple=>Object.fromEntries(TUPLE_KEYS.map(key=>[key,tuple[key]])))};
}
function decodeCanonical(value,max){
 if(typeof value!=='string'||!value.length||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
 const bytes=base64url.decode(value);
 if(base64url.encode(bytes)!==value)throw Error();
 return bytes;
}
function readToken(request){
 const value=request.headers.get('authorization');
 if(typeof value!=='string'||value.length>MAX_TOKEN+7||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(value))throw Error();
 const token=value.slice(7);if(token.length>MAX_TOKEN)throw Error();
 const parts=token.split('.');for(const part of parts)decodeCanonical(part,MAX_TOKEN);
 const header=decodeProtectedHeader(token);
 if(header.alg!=='RS256'||header.typ!=='JWT'||!text(header.kid,128)||BLOCKED_HEADER.some(key=>Object.hasOwn(header,key)))throw Error();
 return {token,header};
}
function validatedJwks(value){
 if(!object(value)||!Array.isArray(value.keys)||value.keys.length===0||value.keys.length>20)throw Error();
 const kids=new Set(),keys=[];
 for(const key of value.keys){
  if(!object(key)||key.kty!=='RSA'||key.alg!=='RS256'||!text(key.kid,128)||kids.has(key.kid)||PRIVATE_JWK.some(name=>Object.hasOwn(key,name)))throw Error();
  if(Object.hasOwn(key,'use')&&key.use!=='sig')throw Error();
  if(Object.hasOwn(key,'key_ops')&&(!Array.isArray(key.key_ops)||key.key_ops.length!==1||key.key_ops[0]!=='verify'))throw Error();
  const n=decodeCanonical(key.n,1366),e=decodeCanonical(key.e,6);
  if(!n[0]||!e[0]||e.length>4)throw Error();
  const bits=(n.length-1)*8+32-Math.clz32(n[0]);
  const exponent=e.reduce((total,byte)=>total*256+byte,0);
  if(bits<2048||bits>8192||exponent<3||exponent%2!==1)throw Error();
  kids.add(key.kid);keys.push({kty:'RSA',kid:key.kid,alg:'RS256',use:'sig',key_ops:['verify'],n:key.n,e:key.e});
 }
 return {kids,resolve:createLocalJWKSet({keys})};
}
async function boundedBody(response,signal){
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^[0-9]+$/.test(declared)||Number(declared)>MAX_JWKS))throw Error();
 if(!response.body)throw Error();
 const reader=response.body.getReader();const chunks=[];let total=0,complete=false;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{
  while(true){
   if(signal.aborted)throw Error();
   const {done,value}=await reader.read();if(done){complete=true;break;}
   total+=value.byteLength;if(total>MAX_JWKS)throw Error();chunks.push(value);
  }
  if(signal.aborted)throw Error();
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{
  signal.removeEventListener('abort',abort);if(!complete)void reader.cancel().catch(()=>{});
  reader.releaseLock();
 }
}
function validClaims(claims,policy,nowSeconds){
 if(!object(claims)||claims.iss!==ISSUER||claims.aud!==policy.audience||claims.repository!==REPOSITORY||claims.repository_id!==REPOSITORY_ID||claims.repository_owner_id!==OWNER_ID)return false;
 if(!['run_id','run_attempt','check_run_id'].every(key=>id(claims[key])))return false;
 if(OPTIONAL.some(key=>Object.hasOwn(claims,key)&&claims[key]===null))return false;
 const tuple=Object.fromEntries(TUPLE_KEYS.map(key=>[key,OPTIONAL.includes(key)&&!Object.hasOwn(claims,key)?null:claims[key]]));
 if(!tupleValid(tuple)||!policy.allowed.some(allowed=>TUPLE_KEYS.every(key=>tuple[key]===allowed[key])))return false;
 for(const key of ['iat','nbf','exp'])if(!Number.isSafeInteger(claims[key])||claims[key]<0)return false;
 return claims.nbf<=nowSeconds&&claims.iat<=nowSeconds&&nowSeconds<claims.exp&&claims.nbf<claims.exp&&claims.exp-claims.iat<=600&&nowSeconds-claims.iat<=600;
}
async function hash(values){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(values)))),byte=>byte.toString(16).padStart(2,'0')).join('');}

export function createGitHubActionsOidcAuthorizer(config,dependencies={}){
 let policy,fetcher,clock;
 try{policy=policySnapshot(config);fetcher=dependencies.fetch??globalThis.fetch;clock=dependencies.now??Date.now;if(typeof fetcher!=='function'||typeof clock!=='function')throw Error();}
 catch{return async()=>null;}
 // Public key metadata only; never retain request I/O, credentials, or claims here.
 let cache=null,expires=0,lastRefresh=-Infinity,refreshing=false;
 async function resolveKeys(kid,time){
  if(cache&&time<expires&&cache.kids.has(kid))return {resolve:cache.resolve,expiresAt:expires};
  if(refreshing||time-lastRefresh<REFRESH_MS)return null;
  refreshing=true;lastRefresh=time;
  const controller=new AbortController();let timer;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},TIMEOUT_MS);});
   const operation=(async()=>{
    const response=await fetcher(JWKS_URL,{method:'GET',redirect:'error',credentials:'omit',headers:{accept:'application/json'},signal:controller.signal});
    if(response.status!==200||response.redirected)throw Error();
    return validatedJwks(await boundedBody(response,controller.signal));
   })();
   const next=await Promise.race([operation,timeout]);
   if(controller.signal.aborted)throw Error();
   cache=next;expires=time+CACHE_MS;
   return cache.kids.has(kid)?{resolve:cache.resolve,expiresAt:expires}:null;
  }finally{clearTimeout(timer);controller.abort();refreshing=false;}
 }
 return async function authorize(request){
  try{
   const {token,header}=readToken(request);const time=clock();
   if(!Number.isSafeInteger(time)||time<0)return null;
   const keys=await resolveKeys(header.kid,time);if(!keys)return null;
   // Re-read after network/crypto work so a token cannot expire while waiting.
   const verifiedAt=clock();if(!Number.isSafeInteger(verifiedAt)||verifiedAt<time)return null;
   const {payload}=await jwtVerify(token,keys.resolve,{algorithms:['RS256'],issuer:ISSUER,audience:policy.audience,typ:'JWT',clockTolerance:0,maxTokenAge:600,currentDate:new Date(verifiedAt),requiredClaims:REQUIRED});
   const subject=await hash([ISSUER,REPOSITORY_ID,OWNER_ID,payload.sub]);
   const executionId=await hash([REPOSITORY_ID,payload.run_id,payload.run_attempt,payload.check_run_id]);
   const finishedAt=clock();if(!Number.isSafeInteger(finishedAt)||finishedAt<verifiedAt||finishedAt>=keys.expiresAt||!validClaims(payload,policy,Math.floor(finishedAt/1000)))return null;
   return {subject,executionId,repository:REPOSITORY,goal:policy.goal};
  }catch{return null;}
 };
}
