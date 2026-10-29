// Synthetic metadata only. These tests do not run or authenticate an AI model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveReviewCheckpoint,loadReviewCheckpoint} from '../scripts/review-checkpoint.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const baseSha='a'.repeat(40),source='def add(a, b):\n    return a + b\n';
function review(overrides={}){
 const body={status:'ADVISORY_AGREEMENT',authority:'none',advisoryOnly:true,modelExecuted:false,
  baseSha,sourceSha256:hash(source),promptSourceSha256:hash(source),canonicalSourceSha256:hash(source.trimEnd()),
  testsSha256:'b'.repeat(64),testCaseCount:6,witnessValid:true,advisoryAgrees:true,...overrides};
 return {...body,reviewReceiptSha256:hash(JSON.stringify(body))};
}
function fixture(fn){
 const root=mkdtempSync(join(tmpdir(),'hq-checkpoint-consistency-'));
 try{return fn(join(root,'review.json'))}finally{rmSync(root,{recursive:true,force:true})}
}
const contradictions=[
 ['agreement with false witness',{witnessValid:false}],
 ['agreement with false advisory',{advisoryAgrees:false}],
 ['inconclusive with positive advisory',{status:'INCONCLUSIVE'}],
 ['failed with positive advisory',{status:'FAILED',failedStage:'witness'}],
 ['agreement with failure stage',{failedStage:'format'}],
 ['failed without failure stage',{status:'FAILED',witnessValid:false,advisoryAgrees:false}],
];
for(const [label,changes] of contradictions){
 test('rejects '+label+' even with freshly recomputed hashes',()=>fixture(file=>{
  assert.throws(()=>saveReviewCheckpoint(file,{baseSha,source,review:review(changes)}),/review|status|stage/i);
  assert.equal(existsSync(file),false,'a rejected receipt must not be written');
 }));
}
test('rejects a request digest bound to a different source',()=>fixture(file=>{
 const requestSha256=hash(JSON.stringify({baseSha,source:'def add(a,b): return a-b'}));
 assert.throws(()=>saveReviewCheckpoint(file,{baseSha,source,review:review({requestSha256})}),/request|source/i);
}));
test('digest arrays cannot be accepted via implicit string conversion',()=>fixture(file=>{
 for(const name of ['canonicalSourceSha256','testsSha256','reviewerResponseSha256']){
  assert.throws(()=>saveReviewCheckpoint(file,{baseSha,source,review:review({[name]:['b'.repeat(64)]})}),/digest/i);
 }
}));
test('valid synthetic outcomes roundtrip and grant no authority',()=>{
 for(const changes of [{},{status:'INCONCLUSIVE',advisoryAgrees:false},{status:'FAILED',advisoryAgrees:false,witnessValid:false,failedStage:'review-process'},
  {status:'FAILED',advisoryAgrees:false,witnessValid:false,failedStage:'model-artifact'},
  {requestSha256:hash(JSON.stringify({baseSha,source}))}]) fixture(file=>{
   const saved=saveReviewCheckpoint(file,{baseSha,source,review:review(changes)});
   const loaded=loadReviewCheckpoint(file,{baseSha,expectedDigest:saved.sha256});
   assert.equal(loaded.authority,'none');assert.equal(loaded.review.modelExecuted,false);
   assert.equal(loaded.review.status,changes.status??'ADVISORY_AGREEMENT');
  });
});
test('restart rejects internally contradictory receipt even when file and review hashes match',()=>fixture(file=>{
 const payload={schema:1,baseSha,source,review:review({witnessValid:false}),authority:'none',scope:'local-synthetic-review-only'};
 const bytes=JSON.stringify(payload);writeFileSync(file,bytes);
 assert.throws(()=>loadReviewCheckpoint(file,{baseSha,expectedDigest:hash(bytes)}),/review|status/i);
}));
