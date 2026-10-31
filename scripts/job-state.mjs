import {readFileSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync,mkdirSync,fsyncSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const STATES=new Set(['QUEUED','RUNNING','VERIFYING','BLOCKED','AWAITING_APPROVAL','DONE']);
const ALLOWED={QUEUED:['RUNNING','BLOCKED','AWAITING_APPROVAL'],RUNNING:['VERIFYING','BLOCKED'],VERIFYING:['DONE','BLOCKED','QUEUED'],BLOCKED:['QUEUED'],AWAITING_APPROVAL:['QUEUED'],DONE:[]};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function initialJob({id,goal,acceptance,baseSha}){
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(id||'')||!goal||!Array.isArray(acceptance)||!acceptance.length||!baseSha) throw Error('Invalid job contract');
 return {schema:1,id,goal,acceptance,baseSha,state:'QUEUED',revision:0,attempts:[],events:[{seq:0,from:null,to:'QUEUED',reason:'created'}]};
}
export function transition(job,to,{expectedRevision,reason,evidence=null,attemptId=null}={}){
 if(!STATES.has(to)||!ALLOWED[job.state]?.includes(to)) throw Error('Invalid state transition');
 if(job.revision!==expectedRevision) throw Error('Stale revision');
 if(typeof reason!=='string'||!reason.trim()) throw Error('Reason required');
 if(to==='DONE'&&(!evidence||evidence.kind!=='MACHINE_VERIFIED'||!evidence.sourceSha||evidence.sourceSha!==job.baseSha)) throw Error('Verified exact-SHA evidence required');
 const next=structuredClone(job);
 next.events.push({seq:next.events.length,from:job.state,to,reason,evidenceDigest:evidence?digest(evidence):null,attemptId});
 next.state=to;next.revision++;
 if(attemptId&&!next.attempts.includes(attemptId))next.attempts.push(attemptId);
 return next;
}
export function saveNew(file,job){
 const path=resolve(file);mkdirSync(dirname(path),{recursive:true});
 const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(job,null,2));fsyncSync(fd)}finally{closeSync(fd)}
}
export function loadJob(file){const job=JSON.parse(readFileSync(file,'utf8'));if(job.schema!==1||!STATES.has(job.state)||job.revision!==job.events.length-1)throw Error('Invalid stored job');return job}
export function saveRevision(file,previous,next){
 const path=resolve(file);const current=loadJob(path);
 if(current.revision!==previous.revision||digest(current)!==digest(previous)||next.revision!==current.revision+1)throw Error('Concurrent or invalid update');
 const tmp=path+'.'+randomUUID()+'.tmp';
 const fd=openSync(tmp,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(next,null,2));fsyncSync(fd)}finally{closeSync(fd)}
 try{renameSync(tmp,path)}catch(e){unlinkSync(tmp);throw e}
}
// Single-writer local prototype only. Do not use on concurrent hosted runners without a transactional lock/store.
