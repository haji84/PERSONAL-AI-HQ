import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCommand,validatePrincipal} from '../workers/state-authority/contract.mjs';
import {createAuthorityWorker} from '../workers/state-authority/worker.mjs';
const scope={repository:'synthetic/hq',goal:'goal-1'};
const principal={...scope,subject:'actor',executionId:'run-1'};
const command={jobId:'job-1',idempotencyKey:'op-1',expectedRevision:0,expectedEpoch:0,ttlMs:1000};
test('authority validates exact operation keys and numeric bounds',()=>{
 assert.deepEqual(validateCommand('claim',command),{operation:'claim',...command});
 for(const patch of [{holder:'actor'},{now:1},{ttlMs:999},{ttlMs:300001},{ttlMs:1.5},{expectedRevision:NaN},{expectedEpoch:'0'},{jobId:'../x'},{idempotencyKey:''}]) assert.throws(()=>validateCommand('claim',{...command,...patch}));
 for(const value of [null,[],false,'x']) assert.throws(()=>validateCommand('claim',value));
 assert.throws(()=>validateCommand('sql',command));
 assert.throws(()=>validateCommand('commit',{jobId:'j',idempotencyKey:'k',expectedRevision:1,expectedEpoch:1,state:'DONE'}));
});
test('verified execution and configured scope are required',()=>{
 assert.deepEqual(validatePrincipal(principal,scope),principal);
 for(const p of [null,{...principal,executionId:''},{...principal,repository:'other/hq'},{...principal,goal:'other'},{...principal,subject:'x'.repeat(257)}]) assert.throws(()=>validatePrincipal(p,scope));
});
test('default missing auth denies without any database access',async()=>{
 const db={prepare(){throw Error('must not access DB')}};
 const response=await createAuthorityWorker(scope).fetch(new Request('https://synthetic.invalid/v1/claim',{method:'POST',body:JSON.stringify(command)}),{HQ_STATE:db});
 assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('malformed and oversized bodies are blocked before storage',async()=>{
 const worker=createAuthorityWorker({...scope,authorize:async()=>principal});
 for(const body of ['{',JSON.stringify({...command,holder:'forged'}),'x'.repeat(4097)]) {
  const response=await worker.fetch(new Request('https://synthetic.invalid/v1/claim',{method:'POST',body}),{});
  assert.ok([400,413].includes(response.status));
 }
 const chunks=new ReadableStream({start(c){c.enqueue(new Uint8Array(3000));c.enqueue(new Uint8Array(3000));c.close()}});
 const response=await worker.fetch(new Request('https://synthetic.invalid/v1/claim',{method:'POST',body:chunks,duplex:'half'}),{});assert.equal(response.status,413);
});
test('wrong route method and verifier failures are generic',async()=>{
 const worker=createAuthorityWorker({...scope,authorize:async()=>{throw Error('sensitive synthetic detail')}});
 const response=await worker.fetch(new Request('https://synthetic.invalid/v1/inspect',{method:'POST',body:'{}'}),{});
 assert.equal(response.status,401);assert.ok(!(await response.text()).includes('sensitive'));
 assert.equal((await worker.fetch(new Request('https://synthetic.invalid/v1/inspect'),{})).status,405);
});
