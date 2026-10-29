#!/usr/bin/env node
// Explicit one-shot public synthetic local-model measurement, no repository writes.
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {continueVerifiedCachedModels} from './model-cycle-state.mjs';
const root=mkdtempSync(join(tmpdir(),'hq-verified-model-cycle-'));
function step(name){
 const r=spawnSync(process.execPath,[new URL('./synthetic-continuation.mjs',import.meta.url).pathname,name,root],
  {stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:15000});
 if(r.status!==0)throw Error('synthetic preparation failed');
}
try{
 const runtimeDir=process.env.HQ_PROBE_RUNTIME_DIR,
       builderModel=process.env.HQ_PROBE_BUILDER_FILE,
       reviewerModel=process.env.HQ_PROBE_REVIEWER_FILE;
 if(!runtimeDir||!builderModel||!reviewerModel)throw Error('pinned artifacts unavailable');
 const baseSha=execFileSync('/usr/bin/git',['--no-replace-objects','rev-parse','HEAD'],
  {encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}}).trim();
 step('init');step('observe-failure');
 const state=await continueVerifiedCachedModels({root,baseSha,
  builderArtifacts:{runtimeDir,modelFile:builderModel},
  reviewerArtifacts:{runtimeDir,modelFile:reviewerModel}});
 const evidence=JSON.parse(readFileSync(join(root,'model-cycle-result.json'),'utf8'));
 const measured={kind:'public-synthetic-local-model-probe',gitHead:baseSha,
  builderObserved:evidence.builderClaimedObserved===true,
  reviewerObserved:evidence.reviewerClaimedObserved===true,
  state:state.state,releaseGate:evidence.reviewGate,
  nextTaskDispatched:false,remoteCheckpointVerified:false};
 console.log(JSON.stringify(measured));
 if(!measured.builderObserved||!measured.reviewerObserved||
   measured.state!=='BLOCKED'||measured.releaseGate!=='NOT_AUTHORIZED')
  process.exitCode=2;
}catch{
 console.error('MODEL_CYCLE_SAFE_STOP: no complete two-model execution proof');
 process.exitCode=2;
}finally{
 rmSync(root,{recursive:true,force:true});
}
