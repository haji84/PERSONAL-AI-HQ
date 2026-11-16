import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
let api;try{api=await import('../scripts/local-reviewer-adapter.mjs')}catch{}
const source='def add(a,b): return a + b',base='a'.repeat(40);
const valid=JSON.stringify({verdict:'no_defect',reason:'Arithmetic agrees.',example:{a:2,b:3,actual:5,required:5}});
test('reviewer adapter implementation exists',()=>assert.equal(typeof api?.runLocalReviewer,'function'));
test('review schema admits all advisory choices but rejects extra authority and unsafe numbers',()=>{
 for(const verdict of ['defect','no_defect','uncertain'])assert.equal(api.parseReviewResponse(valid.replace('no_defect',verdict)).verdict,verdict);
 for(const value of [{...JSON.parse(valid),approved:true},{...JSON.parse(valid),verdict:'PASS'},{...JSON.parse(valid),example:{a:10,b:0,actual:10,required:10}},{...JSON.parse(valid),example:{a:2,b:3,actual:19,required:5}},{...JSON.parse(valid),example:{a:1.5,b:0,actual:1,required:1}}])assert.throws(()=>api.parseReviewResponse(JSON.stringify(value)));
 for(const s of ['prefix'+valid,'',valid+' [end of text]'])assert.throws(()=>api.parseReviewResponse(s));
});
test('blind invocation contains no expected verdict, case label or repair solution',()=>{
 const r=api.buildReviewerInvocation({baseSha:base,source},'/synthetic/reviewer.gguf');
 assert.ok(r.prompt.includes(r.promptSource));assert.equal(r.sourceSha256,'25b512bc921c14cfd4b5ec288d55796fc77a8d11e28f2e5532eded10b9994974');assert.ok(!r.prompt.includes('buggy'));assert.ok(!r.prompt.includes('repaired'));assert.ok(!r.prompt.includes('expected verdict'));assert.ok(!r.prompt.includes('got -1'));
 for(const verdict of ['defect','no_defect','uncertain'])assert.ok(r.grammar.includes(verdict));
 assert.ok(r.args.includes('--offline'));assert.equal(r.args[r.args.indexOf('--threads')+1],'2');assert.equal(r.args[r.args.indexOf('--n-predict')+1],'256');
 assert.throws(()=>api.buildReviewerInvocation({baseSha:'bad',source},'/synthetic/reviewer.gguf'));assert.throws(()=>api.buildReviewerInvocation({baseSha:base,source:'private text'},'/synthetic/reviewer.gguf'));
});
test('same or missing model identity cannot qualify as independent artifacts',()=>{
 const builder={family:'qwen2',sha256:'a'.repeat(64)},reviewer={family:'smollm2',sha256:'b'.repeat(64)};
 assert.equal(api.assertDifferentModel(builder,reviewer),true);
 for(const r of [builder,{family:'smollm2',sha256:builder.sha256},{sha256:'b'.repeat(64)}])assert.throws(()=>api.assertDifferentModel(builder,r));
});
test('resource wrapper enforces4Gi address-space cap and exec replacement (not inference)',()=>{
 const r=spawnSync('/usr/bin/python3',['-I','-S',new URL('../scripts/local-model-limit.py',import.meta.url).pathname,'/usr/bin/python3','-I','-S','-c','import resource;print(resource.getrlimit(resource.RLIMIT_AS))'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'},timeout:5000});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'(4294967296, 4294967296)');
});
test('artifact verifier notices changed model or bundled runtime on recheck (no inference)',async()=>{
 const {mkdtemp,writeFile}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createHash}=await import('node:crypto');
 const hash=s=>createHash('sha256').update(s).digest('hex'),dir=await mkdtemp(join(tmpdir(),'hq-review-artifact-unit-'));await writeFile(join(dir,'runtime'),'runtime');const model=join(tmpdir(),`hq-review-model-unit-${Date.now()}`);await writeFile(model,'model');
 const opts={artifacts:{runtimeDir:dir,modelFile:model},modelProfile:{size:5,sha256:hash('model')},runtimeProfile:{files:{runtime:{sha256:hash('runtime')}}}};
 await api.verifyReviewerArtifacts(opts);await writeFile(model,'other');await assert.rejects(api.verifyReviewerArtifacts(opts));await writeFile(model,'model');await writeFile(join(dir,'runtime'),'changed');await assert.rejects(api.verifyReviewerArtifacts(opts));
});
test('recovery grammar requires nonempty reason without restricting verdict or supplying content',()=>{
 const r=api.buildReviewerInvocation({baseSha:base,source},'/synthetic/model.gguf');assert.match(r.grammar,/\)\+ "\\""/);
 for(const verdict of ['defect','no_defect','uncertain'])assert.ok(r.grammar.includes(verdict));
 for(const reason of ['', ' ', '\n\t'])assert.throws(()=>api.parseReviewResponse(JSON.stringify({...JSON.parse(valid),reason})));
});
