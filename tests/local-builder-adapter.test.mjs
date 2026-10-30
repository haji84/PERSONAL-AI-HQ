import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
let api;try{api=await import('../scripts/local-builder-adapter.mjs')}catch{}
const hash=s=>createHash('sha256').update(s).digest('hex');
test('adapter implementation exists',()=>assert.equal(typeof api?.runLocalBuilder,'function'));
test('host synthetic request rejects freeform tasks and malformed scope',()=>{
 assert.equal(api.validateSyntheticRequest({taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1'}).taskId,'synthetic-add-v1');
 for(const r of [{taskId:'other',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1'},{taskId:'synthetic-add-v1',baseSha:'bad',failure:'add(2, 3): expected 5, got -1'},{taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1',prompt:'private'}])assert.throws(()=>api.validateSyntheticRequest(r));
});
test('bundle verifier detects altered libraries, extras, escapes and links',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hq-bundle-unit-'));await writeFile(join(dir,'binary'),'synthetic-not-executable');
 const manifest={binary:{sha256:hash('synthetic-not-executable')}};
 await api.verifyBundle(dir,manifest);
 await writeFile(join(dir,'extra.so'),'x');await assert.rejects(api.verifyBundle(dir,manifest));
 const dir2=await mkdtemp(join(tmpdir(),'hq-bundle-unit-'));await symlink('/etc/passwd',join(dir2,'binary'));
 await assert.rejects(api.verifyBundle(dir2,manifest));
 await assert.rejects(api.verifyBundle(dir,{'../binary':manifest.binary}));
});
test('bounded process real OS checks: clean env, timeout, bytes overflow, nonzero (not inference)',async()=>{
 const r=await api.runBoundedProcess(process.execPath,['-e','process.stdout.write(String(process.env.HF_TOKEN))'],{cwd:tmpdir(),env:{PATH:'/usr/bin:/bin'},timeoutMs:1000,maxBytes:100});
 assert.equal(r.stdout,'undefined');
 await assert.rejects(api.runBoundedProcess(process.execPath,['-e','setInterval(()=>{},100)'],{cwd:tmpdir(),env:{},timeoutMs:30,maxBytes:100}),/timeout/);
 await assert.rejects(api.runBoundedProcess(process.execPath,['-e',"process.stdout.write('é'.repeat(80))"],{cwd:tmpdir(),env:{},timeoutMs:1000,maxBytes:100}),/output/);
 await assert.rejects(api.runBoundedProcess(process.execPath,['-e','process.exit(2)'],{cwd:tmpdir(),env:{},timeoutMs:1000,maxBytes:100}),/exit/);
});
test('strict proposal parsing rejects prose, changed scope, empty or unchanged patch',()=>{
 const req={taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1'};
 const proposal=content=>JSON.stringify({schema:1,baseSha:req.baseSha,changes:[{path:'fixture.py',content}]});
 assert.equal(api.parseSyntheticProposal(proposal('def add(a, b):\n    return a + b\n'),req).changeCount,1);
 for(const s of ['prefix'+proposal('x'),proposal(''),proposal(api.SEEDED_SOURCE),proposal('x').replace('fixture.py','test.py')])assert.throws(()=>api.parseSyntheticProposal(s,req));
});
test('bundle permits pinned internal symlink chains and rejects cycles/target changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hq-chain-unit-'));await writeFile(join(dir,'lib.so.1.0'),'public synthetic');await symlink('lib.so.1.0',join(dir,'lib.so.1'));await symlink('lib.so.1',join(dir,'lib.so'));
 const m={'lib.so':{link:'lib.so.1'},'lib.so.1':{link:'lib.so.1.0'},'lib.so.1.0':{sha256:hash('public synthetic')}};
 await api.verifyBundle(dir,m);
 await assert.rejects(api.verifyBundle(dir,{...m,'lib.so.1':{link:'lib.so'}}));
 await assert.rejects(api.verifyBundle(dir,{...m,'lib.so':{link:'lib.so.1.0'}}));
});

test('synthetic failure input cannot become arbitrary private prompt text',()=>assert.throws(()=>api.validateSyntheticRequest({taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'private freeform text'})));
test('process output invalid UTF-8 is rejected instead of hashing replacement characters',async()=>{
 await assert.rejects(api.runBoundedProcess(process.execPath,['-e','process.stdout.write(Buffer.from([255]))'],{cwd:tmpdir(),env:{},timeoutMs:1000,maxBytes:100}),/UTF-8/);
});
test('rejected synthetic response retains exact diagnostic evidence without repairing it (not inference)',()=>{
 const request={taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1'};
 let err;try{api.acceptObservedResponse('not JSON',request,{kind:'unit-fake-not-inference'})}catch(e){err=e}
 assert.equal(err?.receipt?.rawResponse,'not JSON');assert.equal(err?.receipt?.rawResponseSha256,hash('not JSON'));assert.equal(err?.receipt?.status,'FAILED');
});
test('completion invocation configures stop and removes example placeholder without inserting repair',()=>{
 assert.equal(typeof api.buildSyntheticInvocation,'function');
 const r=api.buildSyntheticInvocation({taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1'},'/synthetic/model.gguf');
 assert.equal(r.args[r.args.indexOf('--reverse-prompt')+1],'}]}');assert.ok(!r.args.includes('--log-disable'));assert.ok(r.args.includes('--grammar'));assert.ok(!r.args.includes('--json-schema'));
 const grammar=r.args[r.args.indexOf('--grammar')+1];assert.ok(grammar.includes('string'));assert.ok(!grammar.includes('return'));assert.ok(!grammar.includes(' ws'));
 assert.ok(!r.prompt.includes('Python source here'));assert.ok(!r.prompt.includes('return a + b'));assert.match(r.prompt,/actual repaired Python source/);
});
test('fixed envelope leaves model content unconstrained and preserves JSON escapes (not inference)',()=>{
 const request={taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1'};
 const {grammar}=api.buildSyntheticInvocation(request,'/synthetic/model.gguf');
 const prefix=JSON.stringify(`{"schema":1,"baseSha":"${request.baseSha}","changes":[{"path":"fixture.py","content":`);
 assert.equal(grammar.split('\n')[0],`root ::= ${prefix} string "}]}"`);
 assert.equal(grammar.split('\n')[1],String.raw`string ::= "\"" ([^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F]{4}))* "\""`);
 for(const content of ['wrong answer','def add(a,b): return a*b','def add(a,b):\n return 0','quotes " slash \\ unicode あ']){
  const raw=JSON.stringify({schema:1,baseSha:request.baseSha,changes:[{path:'fixture.py',content}]});assert.equal(api.parseSyntheticProposal(raw,request).changes[0].content,content);
 }
 assert.throws(()=>api.buildSyntheticInvocation({...request,baseSha:'" grammar injection'},'/synthetic/model.gguf'));
});
test('all process failures carry bounded measured output evidence and completeness flags',async()=>{
 for(const [args,timeoutMs,maxBytes,stage] of [[['-e','process.stdout.write("partial");process.exit(3)'],1000,100,'process'],[['-e','setInterval(()=>{},10)'],30,100,'process'],[['-e','process.stdout.write("x".repeat(300))'],1000,100,'process'],[['-e','process.stdout.write(Buffer.from([255]))'],1000,100,'decode']]){
  let e;try{await api.runBoundedProcess(process.execPath,args,{cwd:tmpdir(),env:{},timeoutMs,maxBytes})}catch(err){e=err}
  assert.equal(e?.receipt?.status,'FAILED');assert.equal(e?.receipt?.failedStage,stage);assert.equal(typeof e?.receipt?.captureTruncated,'boolean');assert.equal(typeof e?.receipt?.launched,'boolean');assert.ok(e?.receipt?.capturedBytes<=maxBytes);assert.equal(typeof e?.receipt?.evidenceCompleteness?.outputComplete,'boolean');assert.match(e?.receipt?.capturedStdoutSha256,/^[a-f0-9]{64}$/);
 }
});
test('recovery request binds canonical arithmetic source and immutable tests, never freeform prompt',()=>{
 const currentSource='def add(a, b):\n    return a - b',r={taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),failure:'add(2, 3): expected 5, got -1',currentSource,currentSourceSha256:hash(currentSource),testsSha256:'f0088dc4e91c70eb811ecc44725e2366ea0f65fd616db9aae3e2bfb72b51d536'};
 assert.equal(api.validateSyntheticRequest(r).currentSource,currentSource);
 const invocation=api.buildSyntheticInvocation(r,'/synthetic/model.gguf');assert.match(invocation.prompt,/must not repeat or merely reformat/);assert.ok(!invocation.prompt.includes('return a + b'));
 for(const bad of [{...r,currentSourceSha256:'0'.repeat(64)},{...r,currentSource:'private text'},{...r,testsSha256:'bad'},{...r,currentSource:currentSource+' # private comment'}])assert.throws(()=>api.validateSyntheticRequest(bad));
});

test('bounded recovery prompt diagnoses subtraction as the actual defect without supplying repaired code',()=>{
 const source='def add(a, b):\n    return a - b';
 const request={taskId:'synthetic-add-v1',baseSha:'a'.repeat(40),
  failure:'add(2, 3): expected 5, got -1',
  currentSource:source,currentSourceSha256:hash(source),
  testsSha256:'f0088dc4e91c70eb811ecc44725e2366ea0f65fd616db9aae3e2bfb72b51d536'};
 const result=api.buildSyntheticInvocation(request,'/synthetic/model.gguf');
 assert.match(result.prompt,/subtraction.*wrong|wrong.*subtraction/i);
 assert.match(result.prompt,/change the arithmetic operation/i);
 assert.match(result.prompt,/not a formatting/i);
 assert.match(result.prompt,/add\(-4, 3\).*=-1/);
 assert.doesNotMatch(result.prompt,/return a\s*\+\s*b/);
 assert.ok(result.args.includes('--grammar'));
 assert.equal(result.args[result.args.indexOf('--temp')+1],'0');
});
