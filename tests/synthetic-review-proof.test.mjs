import test from 'node:test';
import assert from 'node:assert/strict';
let api;try{api=await import('../scripts/synthetic-review-proof.mjs')}catch{}
const bad='def add(a, b):\n    return a - b\n',good='def add(a,b): return a + b',base='a'.repeat(40);
const advisory=(verdict,actual,required=5)=>({verdict,reason:'A numeric example.',example:{a:2,b:3,actual,required}});
test('review proof implementation exists',()=>assert.equal(typeof api?.runReviewProof,'function'));
test('trusted AST-only witness check rejects lies and never executes arbitrary source',async()=>{
 assert.equal((await api.checkWitness(bad,advisory('defect',-1).example)).witnessValid,true);
 assert.equal((await api.checkWitness(bad,advisory('defect',5).example)).witnessValid,false);
 assert.equal((await api.checkWitness(good,advisory('no_defect',5).example)).testStatus,'PASS');
 await assert.rejects(api.checkWitness('import os\ndef add(a,b): return a+b',advisory('no_defect',5).example));
 await assert.rejects(api.checkWitness(good,{a:NaN,b:2,actual:2,required:2}));
});
test('two blinded fixture critiques remain unverified with injected reviewer (not inference)',async()=>{
 const requests=[];const r=await api.runReviewProof({baseSha:base,reviewer:async({request})=>{requests.push(request);return {advisory:request.source===bad?advisory('defect',-1):advisory('no_defect',5),receipt:{kind:'unit-fake-not-inference',modelExecuted:true}}}});
 assert.equal(requests.length,2);assert.ok(requests.every(r=>Object.keys(r).sort().join(',')==='baseSha,source'));assert.equal(r.actualModelProof,false);assert.ok(r.cases.every(c=>c.modelExecuted===false));assert.equal(r.advisoryOnly,true);assert.equal(r.authority,'none');assert.ok(r.cases.every(c=>c.caseAgreement===true&&c.witnessValid===true));
});
test('uncertain and false verdicts are retained as negative, never accepted',async()=>{
 const r=await api.runReviewProof({baseSha:base,reviewer:async()=>({advisory:advisory('uncertain',5),receipt:{kind:'unit-fake-not-inference'}})});
 assert.equal(r.cases.length,2);assert.ok(r.cases.every(c=>c.caseAgreement===false));
 const wrong=await api.runReviewProof({baseSha:base,reviewer:async()=>({advisory:advisory('no_defect',5),receipt:{kind:'unit-fake-not-inference'}})});assert.equal(wrong.cases.find(c=>c.sourceSha256.startsWith('e1a894')).caseAgreement,false);
});
test('format negative may evaluate second case but infrastructure failure skips it without retry',async()=>{
 let calls=0;const format=await api.runReviewProof({baseSha:base,reviewer:async()=>{calls++;const e=Error('invalid format');e.receipt={failedStage:'format',modelExecuted:true};throw e}});assert.equal(calls,2);assert.ok(format.cases.every(c=>c.formatValid===false));
 calls=0;const infra=await api.runReviewProof({baseSha:base,reviewer:async()=>{calls++;const e=Error('timeout');e.receipt={failedStage:'process',modelExecuted:false};throw e}});assert.equal(calls,1);assert.equal(infra.cases[1].status,'SKIPPED');assert.match(infra.cases[1].reason,/process/);
});
test('identity changes invalidate both results',()=>{
 assert.throws(()=>api.assertFrozenIdentity({a:'one'},{a:'two'}));assert.throws(()=>api.assertFrozenIdentity({a:'one'},{a:'one',b:'new'}));api.assertFrozenIdentity({a:'one'},{a:'one'});
});
test('prompt normalization must match both independent canonical computations before review',()=>{
 assert.equal(typeof api.assertPromptNormalization,'function');
 const v={promptSource:'def add(a, b):\n    return a - b',promptSourceSha256:'bad'};
 assert.throws(()=>api.assertPromptNormalization(v,{canonicalSource:'other'},{canonicalSource:'other'}));
 assert.throws(()=>api.assertPromptNormalization(v,{canonicalSource:v.promptSource},{canonicalSource:v.promptSource}));
});
test('outer verification failure terminalizes current case and explicitly skips unstarted fixture',()=>{
 const result={cases:[{sourceSha256:'25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974',status:'PENDING',caseAgreement:false}]};
 const r=api.terminalizeProofFailure(result,Error('oracle failed'),'oracle');assert.equal(r.status,'INVALIDATED');assert.equal(r.cases.length,2);assert.equal(r.cases[0].status,'FAILED');assert.equal(r.cases[0].failedStage,'oracle');assert.equal(r.cases[1].status,'SKIPPED');assert.match(r.cases[1].reason,/oracle/);
});
test('host selector rejects invalid cases and selected proof runs exactly one injected review',async()=>{
 assert.equal(typeof api.selectReviewFixtures,'function');
 for(const selectors of [[],['unknown'],['25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974','25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974']])assert.throws(()=>api.selectReviewFixtures(selectors));
 let calls=0;const r=await api.runReviewProof({baseSha:base,selectedSourceHashes:['25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974'],reviewer:async()=>{calls++;return {advisory:advisory('no_defect',5),receipt:{kind:'unit-fake-not-inference'}}}});assert.equal(calls,1);assert.equal(r.cases.length,1);assert.equal(r.actualModelProof,false);assert.equal(r.selectedCaseCount,1);assert.match(r.reviewCompetenceClaim,/selected synthetic fixtures/);assert.doesNotMatch(r.reviewCompetenceClaim,/two synthetic/);
});
test('actual recovery rejects unpinned predecessor before any model/artifact access',async()=>{
 assert.equal(typeof api.runActualReviewRecovery,'function');await assert.rejects(api.runActualReviewRecovery({baseSha:base,predecessorBytes:Buffer.from('{}'),artifacts:null}),/predecessor/i);
});
test('predecessor validator binds exact receipt and rejected response bytes (synthetic unit contract)',async()=>{
 const {createHash}=await import('node:crypto'),hash=s=>createHash('sha256').update(s).digest('hex');
 const raw=JSON.stringify({verdict:'no_defect',reason:'',example:{a:1,b:2,actual:3,required:3}}),sourceSha256='25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974';
 const obj={actualModelProof:true,modelInvocationsAttempted:2,cases:[{sourceSha256,status:'FAILED',failedStage:'format',formatValid:false,witnessValid:false,caseAgreement:false,processReceipt:{rawResponse:raw,rawResponseSha256:hash(raw),modelSha256:'b'.repeat(64)}}]};
 const bytes=Buffer.from(JSON.stringify(obj)),contract={receiptSize:bytes.length,receiptSha256:hash(bytes),sourceSha256,rawResponseSha256:hash(raw),modelSha256:'b'.repeat(64)};
 assert.equal(typeof api.validateReviewPredecessor,'function');assert.equal(api.validateReviewPredecessor(bytes,contract).receiptSha256,hash(bytes));
 assert.throws(()=>api.validateReviewPredecessor(Buffer.from(JSON.stringify({...obj,actualModelProof:false})),contract));
 assert.throws(()=>api.validateReviewPredecessor(bytes,{...contract,rawResponseSha256:'0'.repeat(64)}));
});
test('single selected infrastructure failure cannot fabricate a second copied result',async()=>{
 let calls=0;const r=await api.runReviewProof({baseSha:base,selectedSourceHashes:['25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974'],reviewer:async()=>{calls++;const e=Error('unit timeout');e.receipt={failedStage:'process',modelExecuted:false};throw e}});assert.equal(calls,1);assert.equal(r.cases.length,1);assert.equal(r.cases[0].status,'FAILED');
});
