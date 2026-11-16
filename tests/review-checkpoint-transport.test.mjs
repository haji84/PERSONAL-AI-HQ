import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewGeneratedSource} from '../scripts/generated-review.mjs';
import {saveReviewCheckpoint} from '../scripts/review-checkpoint.mjs';
let transfer;try{transfer=await import('../scripts/review-checkpoint-transport.mjs')}catch{}
const base='a'.repeat(40),jobId='synthetic-review-v1',revision=2;
const source='def add(a,b): return a + b';
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'hq-review-transfer-'));
 const review=await reviewGeneratedSource({request:{baseSha:base,source},reviewer:async()=>({
  advisory:{verdict:'no_defect',reason:'Six synthetic tests passed.',example:{a:2,b:3,actual:5,required:5}},
  receipt:{kind:'unit-fake-not-inference'}
 })});
 const filename=join(root,'review-original.json'),saved=saveReviewCheckpoint(filename,{baseSha:base,source,review});
 return {root,filename,saved,review,key:randomBytes(32)};
}
test('verified review checkpoint can be encrypted, restored and reverified at a different path',async()=>{
 const f=await fixture();
 try{
  assert.equal(typeof transfer?.sealVerifiedReview,'function');
  assert.equal(typeof transfer?.restoreVerifiedReview,'function');
  const original=readFileSync(f.filename);
  const envelope=transfer.sealVerifiedReview({file:f.filename,key:f.key,baseSha:base,jobId,revision,expectedDigest:f.saved.sha256});
  assert.doesNotMatch(JSON.stringify(envelope),/def add/);
  assert.equal(envelope.authority,'none');
  const destination=join(f.root,'review-restored.json');
  const restored=transfer.restoreVerifiedReview({envelope,destination,key:f.key,baseSha:base,jobId,revision,expectedDigest:f.saved.sha256});
  assert.equal(restored.checkpointVerified,true);
  assert.equal(restored.status,'ADVISORY_AGREEMENT');
  assert.equal(restored.modelExecuted,false);
  assert.equal(restored.authority,'none');
  assert.deepEqual(readFileSync(destination),original);
  assert.equal(statSync(destination).mode & 0o777,0o600);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});
test('wrong identity, key or digest must not create a restored file',async()=>{
 const f=await fixture();
 try{
  const envelope=transfer.sealVerifiedReview({file:f.filename,key:f.key,baseSha:base,jobId,revision,expectedDigest:f.saved.sha256});
  const variants=[
   {key:randomBytes(32)},
   {baseSha:'b'.repeat(40)},
   {jobId:'other'},
   {revision:revision+1},
   {expectedDigest:'f'.repeat(64)}
  ];
  for(const [i,patch] of variants.entries()){
   const destination=join(f.root,'denied-'+i+'.json');
   assert.throws(()=>transfer.restoreVerifiedReview({envelope,destination,key:f.key,baseSha:base,jobId,revision,expectedDigest:f.saved.sha256,...patch}));
   assert.equal(existsSync(destination),false);
  }
 }finally{rmSync(f.root,{recursive:true,force:true})}
});
test('already-created destination is never replaced by an incoming checkpoint',async()=>{
 const f=await fixture();
 try{
  const envelope=transfer.sealVerifiedReview({file:f.filename,key:f.key,baseSha:base,jobId,revision,expectedDigest:f.saved.sha256});
  const destination=join(f.root,'existing.json');writeFileSync(destination,'ORIGINAL');
  assert.throws(()=>transfer.restoreVerifiedReview({envelope,destination,key:f.key,baseSha:base,jobId,revision,expectedDigest:f.saved.sha256}));
  assert.equal(readFileSync(destination,'utf8'),'ORIGINAL');
 }finally{rmSync(f.root,{recursive:true,force:true})}
});
