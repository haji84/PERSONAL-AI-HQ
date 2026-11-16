import {AuthorityError,validateCommand,validatePrincipal} from './contract.mjs';
import {executeCommand} from './store.mjs';
const reply=(status,value)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
async function readBody(request){
 const reader=request.body?.getReader();if(!reader)throw new AuthorityError(400,'invalid-request');
 const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new AuthorityError(413,'body-too-large')}chunks.push(value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new AuthorityError(400,'invalid-request')}
}
export function createAuthorityWorker({authorize=async()=>null,repository,goal}={}){
 return {async fetch(request,env){
  if(request.method!=='POST')return reply(405,{error:'method-not-allowed'});
  const match=/^\/v1\/(claim|renew|commit|release|inspect)$/.exec(new URL(request.url).pathname);
  if(!match)return reply(404,{error:'not-found'});
  let principal;try{principal=validatePrincipal(await authorize(request),{repository,goal})}catch{return reply(401,{error:'unauthorized'})}
  try{
   const command=validateCommand(match[1],await readBody(request));
   if(!env?.HQ_STATE)throw new AuthorityError(503,'unavailable');
   return reply(200,await executeCommand(env.HQ_STATE,principal,command));
  }catch(error){return error instanceof AuthorityError?reply(error.status,{error:error.code}):reply(503,{error:'retryable-unknown'})}
 }};
}
// No live verifier is configured. Importing/deploying this module grants no authority.
export default createAuthorityWorker();
