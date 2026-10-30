import test from 'node:test';
import assert from 'node:assert/strict';
let api;try{api=await import('../scripts/synthetic-builder-proof.mjs')}catch{}
test('synthetic checker implementation exists',()=>assert.equal(typeof api?.runArithmeticCheck,'function'));
test('real Python arithmetic checker distinguishes PASS from seeded assertion failure',async()=>{
 assert.equal((await api.runArithmeticCheck('def add(a, b):\n    return a + b\n')).status,'PASS');
 const r=await api.runArithmeticCheck('def add(a, b):\n    return a - b\n');assert.equal(r.status,'ASSERTION_FAILURE');assert.match(r.failure,/expected/);
});
test('generated AST rejects all dangerous syntax before execution',async()=>{
 for(const s of ['import os\ndef add(a,b): return a+b','def add(a,b): return __import__("os")','def add(a,b): return a.__class__','def add(a,b=1): return a+b','def add(a,b)->int: return a+b','def add(a,b): return True','def add(a,b): return a**b','def add(a,b):\n while True: pass','def add(a,b): return 1001','def add(a,b,/): return a+b','def add(a,b,*,c): return a+b','@evil\ndef add(a,b): return a+b','def add(a,b): return [a][0]'])assert.equal((await api.runArithmeticCheck(s)).status,'SAFETY_REJECTED',s);
});
test('synthetic proof validates stages; fake builder is unit-only and not inference evidence',async()=>{
 const builder=async({request})=>({proposal:{baseSha:request.baseSha,changeCount:1,digest:'unit-fake',changes:[{path:'fixture.py',content:'def add(a, b):\n    return a + b\n'}]},receipt:{kind:'unit-fake-not-inference'}});
 const r=await api.runSyntheticProof({baseSha:'a'.repeat(40),builder});assert.equal(r.status,'PASS');assert.equal(r.baseline.status,'ASSERTION_FAILURE');assert.equal(r.retest.status,'PASS');assert.equal(r.model.kind,'unit-fake-not-inference');assert.equal(r.inferenceVerified,false);assert.equal(typeof r.repository.dirty,'boolean');assert.match(r.contractSha256,/^[a-f0-9]{64}$/);assert.equal(r.appliedSourceSha256,r.sourceSha256);
 await assert.rejects(api.runSyntheticProof({baseSha:'a'.repeat(40),builder:async()=>{throw Error('model failed')}}),/model failed/);
 await assert.rejects(api.runSyntheticProof({baseSha:'a'.repeat(40),builder:async()=>({proposal:{changes:[{path:'other.py',content:'x'}]}})}));
});
test('proof guards reject unexpected baseline pass/infrastructure and mutated checker/tests',()=>{
 for(const r of [{status:'PASS'},{status:'SAFETY_REJECTED'},{status:'INFRASTRUCTURE_FAILURE'},{}])assert.throws(()=>api.assertBaselineFailure(r));
 api.assertBaselineFailure({status:'ASSERTION_FAILURE',failure:'add(2, 3): expected 5, got -1'});
 assert.throws(()=>api.assertTestIntegrity({checkerBefore:'a',checkerAfter:'b',testsBefore:'c',testsAfter:'c'}));
 assert.throws(()=>api.assertTestIntegrity({checkerBefore:'a',checkerAfter:'a',testsBefore:'c',testsAfter:'d'}));
});
test('checker missing/noisy/malformed output is infrastructure failure, never baseline failure',()=>{
 for(const raw of ['', 'noise{}','{}','{"status":"ASSERTION_FAILURE"}','{"status":"PASS"}'])assert.throws(()=>api.parseCheckerOutput(raw));
});
test('live cached proof rejects a stale base before inference or cache access',async()=>{
 await assert.rejects(api.runCachedSyntheticProof({baseSha:'0'.repeat(40),artifacts:null}),/base does not match HEAD/);
});
test('semantic failure retains measured baseline/model/candidate/retest evidence (unit fake model)',async()=>{
 let err;try{await api.runSyntheticProof({baseSha:'a'.repeat(40),builder:async({request})=>({proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:'def add(a,b): return 0'}]},receipt:{kind:'unit-fake-not-inference'}})})}catch(e){err=e}
 assert.equal(err?.receipt?.status,'FAILED');assert.equal(err?.receipt?.baseline?.status,'ASSERTION_FAILURE');assert.equal(err?.receipt?.retest?.status,'ASSERTION_FAILURE');assert.equal(err?.receipt?.model?.kind,'unit-fake-not-inference');assert.equal(err?.receipt?.generatedSource,'def add(a,b): return 0');
});
test('model/proposal/safety failures retain unified stage evidence and never success',async()=>{
 const bad=[async()=>{throw Error('mock model unavailable')},async({request})=>({proposal:{baseSha:request.baseSha,changes:[{path:'other.py',content:'x'}]},receipt:{kind:'unit-fake-not-inference'}}),async({request})=>({proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:'import os'}]},receipt:{kind:'unit-fake-not-inference'}})];
 for(const [i,builder] of bad.entries()){
  let e;try{await api.runSyntheticProof({baseSha:'a'.repeat(40),builder})}catch(err){e=err}
  assert.equal(e?.receipt?.status,'FAILED');assert.equal(e?.receipt?.failedStage,['model','proposal','retest'][i]);assert.equal(e?.receipt?.baseline?.status,'ASSERTION_FAILURE');assert.equal(typeof e?.receipt?.evidenceCompleteness?.modelReceipt,'boolean');
 }
});
test('checker canonical AST digest ignores formatting but not operation changes',async()=>{
 const a=await api.runArithmeticCheck('def add(a,b): return a-b'),b=await api.runArithmeticCheck('def add(a, b):\n    return a - b\n'),c=await api.runArithmeticCheck('def add(a,b): return a*b');
 assert.match(a.semanticSha256,/^[a-f0-9]{64}$/);assert.equal(a.semanticSha256,b.semanticSha256);assert.notEqual(a.semanticSha256,c.semanticSha256);assert.equal(a.canonicalSource,'def add(a, b):\n    return a - b');
});
test('bounded recovery uses previous new candidate/failure, retaining incomplete origin (fake model)',async()=>{
 const seen=[];const builder=async({request})=>{seen.push(request);return {proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:seen.length===1?'def add(a,b): return a*b':'def add(a,b): return a+b'}]},receipt:{kind:'unit-fake-not-inference'}}};
 const r=await api.runBoundedRecovery({baseSha:'a'.repeat(40),initialSource:'def add(a,b): return a-b',sourceOrigin:'recovered-incomplete',builder,maxCalls:2});
 assert.equal(r.status,'PASS');assert.equal(r.inferenceVerified,false);assert.equal(r.inputProvenance.complete,false);assert.equal(r.attempts.length,2);assert.match(seen[1].currentSource,/a \* b/);assert.match(seen[1].failure,/got 6/);assert.match(seen[1].currentSourceSha256,/^[a-f0-9]{64}$/);assert.equal(seen[1].testsSha256,seen[0].testsSha256);
});
test('reformatted repeated AST failure stops before second call; all failure attempts retained',async()=>{
 let calls=0;const builder=async({request})=>{calls++;return {proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:'def add(a,b): return a - b'}]},receipt:{kind:'unit-fake-not-inference'}}};
 const r=await api.runBoundedRecovery({baseSha:'a'.repeat(40),initialSource:'def add(a, b):\n return a-b',sourceOrigin:'recovered-incomplete',builder,maxCalls:2});
 assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'repeated-canonical-ast-failure');assert.equal(calls,1);assert.equal(r.attempts.length,1);
 await assert.rejects(api.runBoundedRecovery({baseSha:'a'.repeat(40),initialSource:'def add(a,b): return a-b',sourceOrigin:'recovered-incomplete',builder,maxCalls:3}));
});
test('recovery exhausts two distinct failed candidates, and stops safety failures immediately (fake models)',async()=>{
 let calls=0;const builder=async({request})=>({proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:++calls===1?'def add(a,b): return a*b':'def add(a,b): return 0'}]},receipt:{kind:'unit-fake-not-inference'}});
 const opts={baseSha:'a'.repeat(40),initialSource:'def add(a,b): return a-b',sourceOrigin:'recovered-incomplete',maxCalls:2};
 const r=await api.runBoundedRecovery({...opts,builder});assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'corrective-call-budget-exhausted');assert.equal(calls,2);assert.equal(r.attempts.length,2);
 const bad=await api.runBoundedRecovery({...opts,builder:async({request})=>({proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:'import os'}]},receipt:{kind:'unit-fake-not-inference'}})});assert.equal(bad.reason,'non-repairable-stage');assert.equal(bad.attempts.length,1);
});
test('recovery identity guard rejects changed tests/checker on success as well as failure',()=>{
 const initial={checkerSha256:'a',testsSha256:'b'};
 assert.throws(()=>api.assertRecoveryIdentity(initial,{checkerSha256:'x',testsSha256:'b'}));
 assert.throws(()=>api.assertRecoveryIdentity(initial,{checkerSha256:'a',testsSha256:'x'}));
 api.assertRecoveryIdentity(initial,{checkerSha256:'a',testsSha256:'b'});
});
test('process summary counts launched failures separately from completed model output',()=>{
 assert.deepEqual(api.summarizeModelProcesses([{model:{launched:true,status:'FAILED',failedStage:'process'}},{model:{kind:'observed-local-model-process',launched:true,rawResponse:'{}'}},{model:{launched:false,status:'FAILED'}}]),{launchedProcesses:2,completedOutputProcesses:1});
});
test('changed recovery identity blocks before model invocation',async()=>{
 let called=false;let err;
 try{await api.runSyntheticProof({baseSha:'a'.repeat(40),recovery:true,initialSource:'def add(a,b): return a-b',expectedIdentity:{checkerSha256:'wrong',testsSha256:'wrong'},builder:async()=>{called=true;throw Error('must not invoke')}})}catch(e){err=e}
 assert.equal(called,false);assert.equal(err?.receipt?.failedStage,'integrity');
});

test('bounded retest diagnostic distinguishes an observed arithmetic mismatch without leaking generated code',async()=>{
 let failure;try{
  await api.runSyntheticProof({baseSha:'a'.repeat(40),builder:async({request})=>({
   proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:'def add(a,b): return 0'}]},
   receipt:{kind:'unit-fake-not-inference'}
  })});
 }catch(error){failure=error.receipt}
 assert.equal(failure?.failedStage,'retest');
 assert.equal(failure?.retest?.status,'ASSERTION_FAILURE');
 assert.deepEqual(api.summarizeRetestDiagnostic(failure),{outcome:'ASSERTION_FAILURE',caseId:'case-1',observedCaseCount:null});
});

test('bounded retest diagnostic separates checker safety rejection from missing evidence',async()=>{
 let failure;try{
  await api.runSyntheticProof({baseSha:'a'.repeat(40),builder:async({request})=>({
   proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:'import os\\ndef add(a,b): return a+b'}]},
   receipt:{kind:'unit-fake-not-inference'}
  })});
 }catch(error){failure=error.receipt}
 assert.equal(failure?.failedStage,'retest');
 assert.equal(failure?.retest?.status,'SAFETY_REJECTED');
 assert.deepEqual(api.summarizeRetestDiagnostic(failure),{outcome:'SAFETY_REJECTED',caseId:null,observedCaseCount:null});
 assert.deepEqual(api.summarizeRetestDiagnostic({failedStage:'retest'}),{outcome:'UNVERIFIED',caseId:null,observedCaseCount:null});
 assert.deepEqual(api.summarizeRetestDiagnostic({failedStage:'model',retest:{status:'ASSERTION_FAILURE',failure:'PRIVATE_SENTINEL'}}),
  {outcome:'NOT_RETEST',caseId:null,observedCaseCount:null});
});

test('bounded retest diagnostic never copies hostile messages, code, or fake case counts',()=>{
 const payload={failedStage:'retest',error:'PRIVATE_EXCEPTION',generatedSource:'PRIVATE_GENERATED_CODE',retest:{
  status:'ASSERTION_FAILURE',failure:'PRIVATE_ASSERTION_TEXT',caseCount:0,pythonVersion:'PRIVATE_PYTHON'}
 };
 const summary=api.summarizeRetestDiagnostic(payload);
 assert.deepEqual(summary,{outcome:'ASSERTION_FAILURE',caseId:null,observedCaseCount:null});
 assert.doesNotMatch(JSON.stringify(summary),/PRIVATE|generatedSource|pythonVersion/);
 assert.deepEqual(api.summarizeRetestDiagnostic({failedStage:'retest',retest:{status:'PASS',caseCount:6}}),
  {outcome:'UNVERIFIED',caseId:null,observedCaseCount:null});
});

test('synthetic checker classifies rejection stage without copying unsafe source',async()=>{
 const cases=[
  ['def add(a,b): return (','SYNTAX_ERROR'],
  ['import os'+String.fromCharCode(10)+'def add(a,b): return a+b','FUNCTION_SHAPE'],
  ['def add(a,b=1): return a+b','ARGUMENT_SHAPE'],
  ['def add(a,b): return __import__("os")','EXPRESSION_NOT_ALLOWED'],
  ['def add(a,b): return a+b'+' '.repeat(20050),'SOURCE_BOUNDS']
 ];
 for(const [source,code] of cases){
  const checked=await api.runArithmeticCheck(source);
  assert.equal(checked.status,'SAFETY_REJECTED',code);
  assert.equal(checked.rejectCode,code);
  assert.ok(!JSON.stringify(checked).includes(source.slice(0,30)));
  assert.equal(Object.hasOwn(checked,'error'),false);
 }
});
