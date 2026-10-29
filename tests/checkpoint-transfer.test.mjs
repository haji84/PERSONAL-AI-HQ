import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let api;try{api=await import('../scripts/checkpoint-transfer.mjs')}catch{}
const SHA='a'.repeat(40),JOB='synthetic-review-1',REV=3;
const payload=Buffer.from('SYNTHETIC_CHECKPOINT_ONLY:{"status":"BLOCKED","authority":"none"}');
const digest=createHash('sha256').update(payload).digest('hex');
function args(key){return {key,baseSha:SHA,jobId:JOB,revision:REV,checkpointBytes:payload};}
function expected(key){return {key,baseSha:SHA,jobId:JOB,revision:REV,expectedDigest:digest};}
test('authenticated transfer exports an encrypted fixed-scope checkpoint, never release authority',()=>{
 assert.equal(typeof api?.sealCheckpointTransfer,'function');
 assert.equal(typeof api?.openCheckpointTransfer,'function');
 const key=randomBytes(32),envelope=api.sealCheckpointTransfer(args(key));
 assert.equal(envelope.scope,'synthetic-review-checkpoint');
 assert.equal(envelope.authority,'none');
 assert.equal(envelope.releaseAuthorized,false);
 assert.equal(envelope.nextTaskDispatched,false);
 assert.equal(envelope.digest,digest);
 assert.doesNotMatch(JSON.stringify(envelope),/SYNTHETIC_CHECKPOINT_ONLY/);
 const restored=api.openCheckpointTransfer(envelope,expected(key));
 assert.deepEqual(restored,payload);
});
test('wrong key, identity mismatch, tampering and extra keys fail closed',()=>{
 const key=randomBytes(32),envelope=api.sealCheckpointTransfer(args(key));
 const mismatches=[
  {...expected(key),key:randomBytes(32)},
  {...expected(key),jobId:'other-job'},
  {...expected(key),baseSha:'b'.repeat(40)},
  {...expected(key),revision:REV+1},
  {...expected(key),expectedDigest:'f'.repeat(64)}
 ];
 for(const context of mismatches)assert.throws(()=>api.openCheckpointTransfer(envelope,context));
 for(const mutant of [
  {...envelope,tag:envelope.tag.replace(/^./,envelope.tag.startsWith('A')?'B':'A')},
  {...envelope,nonce:envelope.nonce.replace(/^./,envelope.nonce.startsWith('A')?'B':'A')},
  {...envelope,ciphertext:envelope.ciphertext.replace(/^./,envelope.ciphertext.startsWith('A')?'B':'A')},
  {...envelope,authority:'approved'},
  {...envelope,extra:true}
 ])assert.throws(()=>api.openCheckpointTransfer(mutant,expected(key)));
});
test('oversized checkpoint and invalid cryptographic key are rejected',()=>{
 const key=randomBytes(32);
 assert.throws(()=>api.sealCheckpointTransfer({...args(key),checkpointBytes:Buffer.alloc(65537)}));
 assert.throws(()=>api.sealCheckpointTransfer(args(Buffer.alloc(5))));
 assert.throws(()=>api.sealCheckpointTransfer({...args(key),revision:-1}));
 assert.throws(()=>api.sealCheckpointTransfer({...args(key),baseSha:'HEAD'}));
});
test('two independent OS processes can decrypt sealed synthetic checkpoint after producer exits',()=>{
 const moduleUrl=new URL('../scripts/checkpoint-transfer.mjs',import.meta.url).href;
 const key=randomBytes(32).toString('base64url');
 const producer=`import {sealCheckpointTransfer} from ${JSON.stringify(moduleUrl)};
let input='';for await (const chunk of process.stdin)input+=chunk;
const q=JSON.parse(input);
const out=sealCheckpointTransfer({key:Buffer.from(q.key,'base64url'),baseSha:q.baseSha,jobId:q.jobId,revision:q.revision,checkpointBytes:Buffer.from(q.payload,'base64url')});
process.stdout.write(JSON.stringify(out));`;
 const consumer=`import {openCheckpointTransfer} from ${JSON.stringify(moduleUrl)};
let input='';for await (const chunk of process.stdin)input+=chunk;
const q=JSON.parse(input);
const v=openCheckpointTransfer(q.envelope,{key:Buffer.from(q.key,'base64url'),baseSha:q.baseSha,jobId:q.jobId,revision:q.revision,expectedDigest:q.digest});
process.stdout.write(v.toString('base64url'));`;
 const common={key,baseSha:SHA,jobId:JOB,revision:REV,digest,payload:payload.toString('base64url')};
 const one=spawnSync(process.execPath,['--input-type=module','-e',producer],{input:JSON.stringify(common),encoding:'utf8',timeout:5000,maxBuffer:100000});
 assert.equal(one.status,0,one.stderr);
 const envelope=JSON.parse(one.stdout);
 const two=spawnSync(process.execPath,['--input-type=module','-e',consumer],{input:JSON.stringify({...common,envelope}),encoding:'utf8',timeout:5000,maxBuffer:100000});
 assert.equal(two.status,0,two.stderr);
 assert.equal(two.stdout,payload.toString('base64url'));
});
