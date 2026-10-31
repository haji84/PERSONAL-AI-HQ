// Synthetic LOCAL TEST ONLY. Never configure this fixture as a deployment entrypoint.
import {createAuthorityWorker} from '../../workers/state-authority/worker.mjs';
// Test-only barrier forces both preflight receipt reads to finish before either batch.
const barriers=new Map();
function rendezvous(key){
 let gate=barriers.get(key);
 if(!gate){let release,abort;const promise=new Promise((resolve,reject)=>{release=resolve;abort=reject});gate={promise,release,count:0,timer:setTimeout(()=>{barriers.delete(key);abort(Error('synthetic rendezvous timeout'))},2000)};barriers.set(key,gate)}
 if(++gate.count===2){clearTimeout(gate.timer);barriers.delete(key);gate.release()}
 return gate.promise;
}
export default {async fetch(request,env){
 if(new URL(request.url).pathname==='/__test/sql'){
  const {sql,params=[]}=await request.json();
  return Response.json(await env.HQ_STATE.prepare(sql).bind(...params).all());
 }
 if(new URL(request.url).pathname==='/__test/schema')return Response.json(await env.HQ_STATE.exec(await request.text()));
 const worker=createAuthorityWorker({repository:'synthetic/hq',goal:'goal-1',authorize:async()=>({repository:'synthetic/hq',goal:'goal-1',subject:request.headers.get('x-test-subject')??'actor',executionId:request.headers.get('x-test-execution')??'run-1'})});
 const fault=request.headers.get('x-test-fault');
 const barrier=request.headers.get('x-test-barrier');
 if(fault||barrier){const db=env.HQ_STATE;env={...env,HQ_STATE:{prepare:sql=>db.prepare(sql),batch:async statements=>{if(barrier)await rendezvous(barrier);if(fault==='before')throw Error('synthetic before');const result=await db.batch(statements);if(fault==='after')throw Error('synthetic lost response');return result}}}}
 return worker.fetch(request,env);
}};
