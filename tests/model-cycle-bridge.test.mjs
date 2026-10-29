import test from 'node:test';
import assert from 'node:assert/strict';
let bridge;try{bridge=await import('../scripts/model-cycle-bridge.mjs')}catch{}
const base='a'.repeat(40);
const good='def add(a,b): return a + b';
const fakeBuilder=async({request})=>({
 proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:good}]},
 receipt:{kind:'unit-fake-not-inference',modelExecuted:false}
});
const fakeReviewer=async()=>({
 advisory:{verdict:'no_defect',reason:'Arithmetic agrees in the tested example.',example:{a:2,b:3,actual:5,required:5}},
 receipt:{kind:'unit-fake-not-inference',modelExecuted:false}
});
test('model bridge exposes explicit cached-model entry point',()=>{
 assert.equal(typeof bridge?.runVerifiedCachedCycle,'function');
 assert.equal(typeof bridge?.runSyntheticBridge,'function');
});
test('injected fake builder/reviewer never qualify as independent model execution or release',async()=>{
 const r=await bridge.runSyntheticBridge({baseSha:base,builder:fakeBuilder,reviewer:fakeReviewer});
 assert.equal(r.state,'BLOCKED');
 assert.equal(r.builder.status,'PASS');
 assert.equal(r.builder.modelExecuted,false);
 assert.equal(r.reviewer.status,'ADVISORY_AGREEMENT');
 assert.equal(r.reviewer.modelExecuted,false);
 assert.equal(r.releaseAuthorized,false);
 assert.equal(r.nextTaskDispatched,false);
 assert.match(r.reason,/unverified/);
});
test('model reviewer is not called when repaired source lacks pinned review coverage',async()=>{
 let count=0;
 const builder=async({request})=>({proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:'def add(a,b): return (a + b)'}]},receipt:{kind:'unit-fake-not-inference'}});
 const r=await bridge.runSyntheticBridge({baseSha:base,builder,reviewer:async()=>{count++;return fakeReviewer()}});
 assert.equal(count,0);
 assert.equal(r.state,'BLOCKED');
 assert.equal(r.reason,'review-source-unverified');
});
test('malformed fake builder response never starts reviewer',async()=>{
 let count=0;
 const r=await bridge.runSyntheticBridge({baseSha:base,builder:async()=>{throw Error('injected failure')},reviewer:async()=>{count++;return fakeReviewer()}});
 assert.equal(r.state,'BLOCKED');
 assert.equal(count,0);
 assert.equal(r.reason,'builder-not-verified');
});
test('cached-model mode fails on stale HEAD before model artifact access',async()=>{
 await assert.rejects(bridge.runVerifiedCachedCycle({baseSha:'0'.repeat(40),builderArtifacts:null,reviewerArtifacts:null}),/base does not match HEAD/);
});
