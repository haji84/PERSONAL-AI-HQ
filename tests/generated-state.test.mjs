import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {continueModelCycle} from '../scripts/model-cycle-state.mjs';
import {runGeneratedSyntheticCycle} from '../scripts/model-cycle-bridge.mjs';
const head=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const runner=new URL('../scripts/synthetic-continuation.mjs',import.meta.url).pathname;
const stateModule=new URL('../scripts/model-cycle-state.mjs',import.meta.url).href;
const source='def add(a, b):\n    return (a + b)\n';
async function workspace(fn){
 const root=mkdtempSync(join(tmpdir(),'hq-generated-state-'));
 try{
  for(const operation of ['init','observe-failure']){
   const r=spawnSync(process.execPath,[runner,operation,root],{encoding:'utf8',timeout:15000});
   assert.equal(r.status,0,r.stderr);
  }
  return await fn(root);
 }finally{rmSync(root,{recursive:true,force:true})}
}
const fakeCycle=()=>runGeneratedSyntheticCycle({baseSha:head,
 builder:async({request})=>({proposal:{baseSha:request.baseSha,changes:[{path:'fixture.py',content:source}]},receipt:{kind:'unit-fake-not-inference'}}),
 reviewer:async()=>({advisory:{verdict:'no_defect',reason:'Arithmetic witness agrees.',example:{a:2,b:3,actual:5,required:5}},receipt:{kind:'unit-fake-not-inference'}})
});
test('new OS process verifies persisted exact-source review without rerunning a model',async()=>workspace(async root=>{
 const r=await continueModelCycle({root,baseSha:head,bridge:fakeCycle});
 assert.equal(r.checkpointVerified,true);
 const receipt=JSON.parse(readFileSync(join(root,'model-cycle-result.json'),'utf8'));
 assert.match(receipt.reviewCheckpointSha256,/^[a-f0-9]{64}$/);
 const program=`import {continueModelCycle} from ${JSON.stringify(stateModule)}; const r=await continueModelCycle({root:${JSON.stringify(root)},baseSha:${JSON.stringify(head)},bridge:async()=>{throw Error('MUST_NOT_RUN')}}); if(!r.checkpointVerified||r.state!=='BLOCKED')process.exit(3);`;
 const resumed=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:15000});
 assert.equal(resumed.status,0,resumed.stderr);
 assert.equal(JSON.parse(readFileSync(join(root,'review-checkpoint.json'),'utf8')).source,source);
}));
test('even a previously blocked job must reject a corrupted review checkpoint before resume',async()=>workspace(async root=>{
 await continueModelCycle({root,baseSha:head,bridge:fakeCycle});
 writeFileSync(join(root,'review-checkpoint.json'),'{}');
 let invoked=false;
 await assert.rejects(continueModelCycle({root,baseSha:head,bridge:async()=>{invoked=true;return fakeCycle()}}),/checkpoint|digest/i);
 assert.equal(invoked,false);
}));
test('two concurrent invocations never run the same model attempt twice',async()=>workspace(async root=>{
 let release,started;const gate=new Promise(resolve=>{release=resolve});
 const signal=new Promise(resolve=>{started=resolve});let calls=0;
 const first=continueModelCycle({root,baseSha:head,bridge:async()=>{calls++;started();await gate;return fakeCycle()}});
 await signal;
 let denied=false;
 try{await continueModelCycle({root,baseSha:head,bridge:async()=>{calls++;return fakeCycle()}})}catch{denied=true}
 finally{release()}
 await first.catch(()=>{});
 assert.equal(denied,true);
 assert.equal(calls,1);
}));
