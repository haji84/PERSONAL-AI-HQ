import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runBootstrapProof} from '../scripts/oidc-bootstrap-proof.mjs';
import {runBootstrapDiagnostic,classifyVerificationFailure} from '../scripts/oidc-bootstrap-diagnostic.mjs';
import {errors} from 'jose';

const REPO='haji84/PERSONAL-AI-HQ',RID='1437383396',OID='173585154',BRANCH='feature/autonomous-manager-bootstrap';
const PATH='.github/workflows/hq-oidc-bootstrap-pr11-v2.yml',REF='refs/pull/11/merge',WORKFLOW=REPO+'/'+PATH+'@'+REF;
const ISSUER='https://token.actions.githubusercontent.com',AUD='urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v2',NOW=1800000000;
const V1_WORKFLOW=WORKFLOW.replace('-v2.yml','-v1.yml'),V1_AUD=AUD.replace(':v2',':v1');
const SUBJECTS=['repo:'+REPO+':pull_request','repo:haji84@173585154/PERSONAL-AI-HQ@1437383396:pull_request'];
const PUBLIC=['sub','repository','repository_id','repository_owner_id','ref','workflow_ref','workflow_sha','run_id','run_number','run_attempt','check_run_id'];
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const key={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'synthetic-bootstrap',alg:'RS256',use:'sig'};
const b64=v=>Buffer.from(v).toString('base64url');
function context(){const repo={id:Number(RID),full_name:REPO,private:false,owner:{id:Number(OID)}};return {env:{GITHUB_ACTIONS:'true',GITHUB_SERVER_URL:'https://github.com',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:REPO,GITHUB_REPOSITORY_ID:RID,GITHUB_REPOSITORY_OWNER_ID:OID,GITHUB_REF:REF,GITHUB_HEAD_REF:BRANCH,GITHUB_BASE_REF:'main',GITHUB_RUN_ID:'101',GITHUB_RUN_NUMBER:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:WORKFLOW,GITHUB_WORKFLOW_SHA:'b'.repeat(40),GITHUB_SHA:'c'.repeat(40),RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',HQ_BOOTSTRAP_SOURCE_SHA:'a'.repeat(40),HQ_BOOTSTRAP_CHECKOUT_SHA:'a'.repeat(40),HQ_BOOTSTRAP_CHECK_RUN_ID:'201',ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.synthetic.actions.githubusercontent.com/token?api-version=2',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-credential'},event:{action:'synchronize',number:11,repository:repo,pull_request:{number:11,head:{ref:BRANCH,repo},base:{ref:'main',repo}}}};}
function claims(){return {iss:ISSUER,aud:AUD,sub:SUBJECTS[0],repository:REPO,repository_id:RID,repository_owner_id:OID,repository_visibility:'public',event_name:'pull_request',head_ref:BRANCH,base_ref:'main',ref:REF,workflow_ref:WORKFLOW,workflow_sha:'b'.repeat(40),run_id:'101',run_number:'1',run_attempt:'1',check_run_id:'201',iat:NOW,nbf:NOW-5,exp:NOW+300};}
async function token(patch={},header={},defaults=claims()){const c={...defaults,...patch};for(const k of Object.keys(c))if(c[k]===undefined)delete c[k];const input=b64(JSON.stringify({alg:'RS256',typ:'JWT',kid:key.kid,...header}))+'.'+b64(JSON.stringify(c));return input+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input)));}
async function fixture({ctx=context(),patch,header,fetcher,runner=runBootstrapDiagnostic,canonical=true}={}){const defaults=claims();if(runner===runBootstrapProof&&canonical){ctx=structuredClone(ctx);if(ctx.env.GITHUB_WORKFLOW_REF===WORKFLOW)ctx.env.GITHUB_WORKFLOW_REF=V1_WORKFLOW;defaults.workflow_ref=V1_WORKFLOW;defaults.aud=V1_AUD;patch={...patch};if(patch.workflow_ref===WORKFLOW)patch.workflow_ref=V1_WORKFLOW;if(patch.aud===AUD)patch.aud=V1_AUD;if(Array.isArray(patch.aud))patch.aud=patch.aud.map(v=>v===AUD?V1_AUD:v);}const jwt=await token(patch,header,defaults),calls=[];let now=NOW*1000;return {ctx,calls,jwt,advance:ms=>{now+=ms},run:()=>runner(ctx,{now:()=>now,fetch:async(url,init)=>{calls.push({url,init});return fetcher?fetcher(url,init,calls.length,jwt):calls.length===1?Response.json({value:jwt}):Response.json({keys:[key]});}})};}


const failure=(result,stage,field='NONE')=>{assert.deepEqual(result,{ok:false,stage,field});};
test('success differs only by exact v2 workflow identity, and v1 remains frozen',async()=>{
 const next=await(await fixture()).run(),prior=await(await fixture({runner:runBootstrapProof})).run();assert.deepEqual(next,{ok:true,proof:{...prior,workflow_ref:WORKFLOW}});assert.deepEqual(Object.keys(next.proof).sort(),[...PUBLIC].sort());
 assert.equal(createHash('sha256').update(readFileSync(new URL('../scripts/oidc-bootstrap-proof.mjs',import.meta.url))).digest('hex'),'d5b24bea4e5d175b268570032b9b906868bbbc840c2c73269404d582306b9a65');
});
test('invalid public context identifies only fixed field and never reads credential getters',async()=>{
 const fields=['GITHUB_ACTIONS','GITHUB_SERVER_URL','GITHUB_EVENT_NAME','GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','GITHUB_REPOSITORY_OWNER_ID','GITHUB_REF','GITHUB_HEAD_REF','GITHUB_BASE_REF','GITHUB_RUN_NUMBER','GITHUB_RUN_ATTEMPT','GITHUB_WORKFLOW_REF','RUNNER_ENVIRONMENT','RUNNER_OS','GITHUB_RUN_ID','HQ_BOOTSTRAP_CHECK_RUN_ID','GITHUB_WORKFLOW_SHA','GITHUB_SHA','HQ_BOOTSTRAP_SOURCE_SHA','HQ_BOOTSTRAP_CHECKOUT_SHA'];
 for(const field of fields){const ctx=context();ctx.env[field]='private-sentinel';let reads=0;for(const key of ['ACTIONS_ID_TOKEN_REQUEST_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN'])Object.defineProperty(ctx.env,key,{get(){reads++;throw Error('private-sentinel')}});const f=await fixture({ctx});failure(await f.run(),'CONTEXT',field);assert.equal(reads,0);assert.equal(f.calls.length,0);}
 const ctx=context();ctx.event.number=12;const f=await fixture({ctx});failure(await f.run(),'CONTEXT','EVENT_FIELDS');assert.equal(f.calls.length,0);
});
test('configuration, dependency and clock failures are fixed enums with zero requests',async()=>{
 for(const [field,value,expected]of [['ACTIONS_ID_TOKEN_REQUEST_URL','https://evil.invalid/secret','REQUEST_URL'],['ACTIONS_ID_TOKEN_REQUEST_TOKEN','secret with space','REQUEST_CREDENTIAL']]){const ctx=context();ctx.env[field]=value;const f=await fixture({ctx});failure(await f.run(),'MINT_CONFIGURATION',expected);assert.equal(f.calls.length,0);}
 failure(await runBootstrapDiagnostic(context(),{fetch:1}),'DEPENDENCY');failure(await runBootstrapDiagnostic(context(),{now:()=>NaN}),'CLOCK');
});
test('uncertain mint transport failure cannot become issuance claim or trigger retry',async()=>{
 for(const fetcher of [()=>{throw Error('secret-error')},()=>new Response('',{status:503}),()=>new Response('bad-json'),()=>new Response('x'.repeat(32769))]){const f=await fixture({fetcher});failure(await f.run(),'MINT_TRANSPORT');assert.equal(f.calls.length,1);}
 const f=await fixture({fetcher:()=>Response.json({value:'secret-not-jwt'})});failure(await f.run(),'TOKEN_FORMAT');assert.equal(f.calls.length,1);
});
test('JWKS transport, format, signature and registered claims remain distinguishable and denied',async()=>{
 let f=await fixture({fetcher:(_u,_i,n,jwt)=>n===1?Response.json({value:jwt}):new Response('',{status:503})});failure(await f.run(),'JWKS_TRANSPORT');assert.equal(f.calls.length,2);
 f=await fixture({fetcher:(_u,_i,n,jwt)=>n===1?Response.json({value:jwt}):Response.json({keys:[]})});failure(await f.run(),'JWKS_FORMAT');
 f=await fixture({fetcher:(_u,_i,n,jwt)=>{if(n!==1)return Response.json({keys:[key]});const parts=jwt.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);return Response.json({value:parts.join('.')});}});failure(await f.run(),'SIGNATURE');
 for(const [patch,field]of [[{aud:'private'},'aud'],[{iss:'private'},'iss'],[{exp:NOW},'exp'],[{nbf:NOW+1},'nbf'],[{iat:NOW+1},'iat']])failure(await(await fixture({patch})).run(),'REGISTERED_CLAIMS',field);
});
test('final policy emits only fixed field names and keeps archived-sample shapes rejected',async()=>{
 for(const [patch,stage,field]of [[{repository_id:'private'},'CLAIM_IDENTITY','repository_id'],[{sub:'private'},'CLAIM_SUBJECT','sub'],[{environment:null},'CLAIM_OPTIONAL','environment'],[{job_workflow_ref:WORKFLOW,job_workflow_sha:'b'.repeat(40)},'CLAIM_OPTIONAL','job_workflow_ref'],[{exp:NOW+21600},'CLAIM_TIME','LIFETIME'],[{nbf:0.5},'CLAIM_TIME','nbf']])failure(await(await fixture({patch})).run(),stage,field);
});
test('hostile error getters and unknown jose claim names never escape fixed categories',async()=>{
 const hostile={};for(const key of ['message','stack','payload','claim'])Object.defineProperty(hostile,key,{get(){throw Error('private-sentinel')}});failure({ok:false,...await classifyVerificationFailure(hostile)},'JWT_VERIFICATION');
 const signature=new errors.JWSSignatureVerificationFailed();for(const key of ['message','stack','payload','claim'])Object.defineProperty(signature,key,{get(){throw Error('private-sentinel')}});assert.deepEqual(await classifyVerificationFailure(signature),{stage:'SIGNATURE',field:'NONE'});
 for(const claim of ['iss','aud','iat','nbf','exp','private-sentinel']){const e=new errors.JWTClaimValidationFailed('private-message',{},claim);for(const key of ['message','stack','payload'])Object.defineProperty(e,key,{get(){throw Error('private-sentinel')}});const before=Object.getOwnPropertyDescriptors(e);assert.deepEqual(await classifyVerificationFailure(e),{stage:claim==='private-sentinel'?'JWT_VERIFICATION':'REGISTERED_CLAIMS',field:claim==='private-sentinel'?'NONE':claim});assert.deepEqual(Object.getOwnPropertyDescriptors(e),before);}
 const e=new errors.JWTExpired('private-message',{},'exp');Object.defineProperty(e,'claim',{get(){throw Error('private-sentinel')}});assert.deepEqual(await classifyVerificationFailure(e),{stage:'REGISTERED_CLAIMS',field:'NONE'});
 const f=await fixture({fetcher:()=>{throw hostile}});failure(await f.run(),'MINT_TRANSPORT');
});
test('v1 and successor acceptance/proof agree over valid and invalid fixture matrix',async()=>{
 const cases=[{}, {patch:{sub:SUBJECTS[1]}}, ...['iss','aud','repository','repository_id','repository_owner_id','repository_visibility','event_name','head_ref','base_ref','ref','workflow_ref','workflow_sha','run_id','run_number','run_attempt','check_run_id'].flatMap(field=>[undefined,'wrong',1,[]].map(value=>({patch:{[field]:value}}))), ...[{environment:null},{job_workflow_ref:WORKFLOW},{job_workflow_sha:'b'.repeat(40)},{exp:NOW+21600},{iat:NOW+1},{nbf:NOW+1},{exp:NOW},{iat:NOW-601},{nbf:0.5},{aud:[AUD]},{sub:'private'}].map(patch=>({patch})), ...[{alg:'none'},{alg:'HS256'},{kid:'unknown'},{jku:'https://private.invalid'},{crit:[]}].map(header=>({header}))];
 for(const options of cases){const before=await(await fixture({...options,runner:runBootstrapProof})).run(),after=await(await fixture(options)).run();assert.equal(after.ok,before!==null);if(after.ok)assert.deepEqual(after.proof,{...before,workflow_ref:WORKFLOW});else{assert.deepEqual(Object.keys(after).sort(),['field','ok','stage']);assert.equal(JSON.stringify(after).includes('private'),false);}}
});
test('stalled mint body is bounded and diagnosed without a second request',async()=>{
 const f=await fixture({fetcher:()=>new Response(new ReadableStream({pull(){return new Promise(()=>{})}}))});failure(await f.run(),'MINT_TRANSPORT');assert.equal(f.calls.length,1);
});
test('CLI without exact flag emits bounded fixed enums only',()=>{
 const r=spawnSync(process.execPath,['scripts/oidc-bootstrap-diagnostic.mjs'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,ACTIONS_ID_TOKEN_REQUEST_TOKEN:'private-sentinel'}});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'OIDC_BOOTSTRAP_FAILED stage=ENTRYPOINT field=ARGS\n');
});

test('proxy failures and private error-property getters are never observed or mutated',async()=>{
 const proxy=new Proxy({}, {getPrototypeOf(){throw Error('private-sentinel')}});assert.deepEqual(await classifyVerificationFailure(proxy),{stage:'JWT_VERIFICATION',field:'NONE'});
 let privateReads=0;const e=new errors.JWTClaimValidationFailed('unused',{},'aud');
 for(const field of ['message','stack','payload','cause','token'])Object.defineProperty(e,field,{get(){privateReads++;throw Error('private-sentinel')}});
 assert.deepEqual(await classifyVerificationFailure(e),{stage:'REGISTERED_CLAIMS',field:'aud'});assert.equal(privateReads,0);
 const f=await fixture({fetcher:()=>{throw proxy}});failure(await f.run(),'MINT_TRANSPORT');assert.equal(f.calls.length,1);
});
test('valid input is not mutated and endpoint rejection precedes credential getter access',async()=>{
 const ctx=context(),before=structuredClone(ctx);Object.freeze(ctx.env);Object.freeze(ctx.event);Object.freeze(ctx);const f=await fixture({ctx});assert.equal((await f.run()).ok,true);assert.deepEqual(ctx,before);
 const bad=context();bad.env.ACTIONS_ID_TOKEN_REQUEST_URL='https://pipelines.actions.githubusercontent.com:443/token';let reads=0;Object.defineProperty(bad.env,'ACTIONS_ID_TOKEN_REQUEST_TOKEN',{get(){reads++;throw Error('private')}});const invalid=await fixture({ctx:bad});failure(await invalid.run(),'MINT_CONFIGURATION','REQUEST_URL');assert.equal(reads,0);assert.equal(invalid.calls.length,0);
});
test('context endpoint and key-boundary differential fixtures preserve v1 rejection',async()=>{
 for(const mutate of [c=>c.env.GITHUB_WORKFLOW_REF='wrong',c=>c.env.GITHUB_RUN_NUMBER='2',c=>c.env.HQ_BOOTSTRAP_CHECKOUT_SHA='d'.repeat(40),c=>c.event.pull_request.head.repo=null,c=>c.env.ACTIONS_ID_TOKEN_REQUEST_URL='https://evil.invalid/',c=>c.env.ACTIONS_ID_TOKEN_REQUEST_URL+='&AuDiEnCe=private',c=>c.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN='contains space']){
  const a=context(),b=context();mutate(a);mutate(b);const prior=await fixture({ctx:a,runner:runBootstrapProof}),next=await fixture({ctx:b});assert.equal(await prior.run(),null);assert.equal((await next.run()).ok,false);assert.equal(prior.calls.length,next.calls.length);
 }
 for(const body of [{keys:[]},{keys:[key,key]},{keys:[{...key,d:'private'}]},{keys:[{...key,e:'Ag'}]},{keys:[{...key,n:b64(new Uint8Array(1025).fill(255))}]}]){
  const fetcher=(_u,_i,n,jwt)=>n===1?Response.json({value:jwt}):Response.json(body);const prior=await fixture({fetcher,runner:runBootstrapProof}),next=await fixture({fetcher});assert.equal(await prior.run(),null);assert.equal((await next.run()).ok,false);assert.equal(prior.calls.length,2);assert.equal(next.calls.length,2);
 }
});
test('completion-time expiry and clock regression still deny after successful verification path',async()=>{
 let f;f=await fixture({fetcher:(_u,_i,n,jwt)=>{if(n===2)f.advance(300000);return n===1?Response.json({value:jwt}):Response.json({keys:[key]});}});failure(await f.run(),'REGISTERED_CLAIMS','exp');
 const jwt=await token();let ticks=0,calls=0;const result=await runBootstrapDiagnostic(context(),{now:()=>++ticks===3?NOW*1000-1:NOW*1000,fetch:async()=>++calls===1?Response.json({value:jwt}):Response.json({keys:[key]})});failure(result,'CLOCK');assert.equal(calls,2);
});
test('CLI event-file failures reveal only fixed category',()=>{
 const r=spawnSync(process.execPath,['scripts/oidc-bootstrap-diagnostic.mjs','--github-oidc-bootstrap-once'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_ACTIONS:'true',GITHUB_EVENT_PATH:'/nonexistent/private-sentinel',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'private-sentinel'}});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'OIDC_BOOTSTRAP_FAILED stage=ENTRYPOINT field=EVENT_FILE\n');assert.equal(r.stderr.length<128,true);
});

test('missing required public claim gets its fixed field name, never its value',async()=>{
 const f=await fixture({patch:{check_run_id:undefined}});failure(await f.run(),'JWT_VERIFICATION','check_run_id');assert.equal(f.calls.length,2);
 const old=await fixture({patch:{check_run_id:undefined},runner:runBootstrapProof});assert.equal(await old.run(),null);
 const e=new errors.JWTClaimValidationFailed('private',{},'check_run_id');assert.deepEqual(await classifyVerificationFailure(e),{stage:'JWT_VERIFICATION',field:'check_run_id'});
});

test('v1 and v2 reject each other rather than accepting an identity wildcard',async()=>{
 const v1ctx=context();v1ctx.env.GITHUB_WORKFLOW_REF=V1_WORKFLOW;const next=await fixture({ctx:v1ctx});failure(await next.run(),'CONTEXT','GITHUB_WORKFLOW_REF');assert.equal(next.calls.length,0);
 const nextToken=await fixture({patch:{aud:V1_AUD,workflow_ref:V1_WORKFLOW}});failure(await nextToken.run(),'REGISTERED_CLAIMS','aud');
 const old=await fixture({runner:runBootstrapProof,canonical:false});assert.equal(await old.run(),null);assert.equal(old.calls.length,0);
 const oldToken=await fixture({ctx:v1ctx,runner:runBootstrapProof,canonical:false});assert.equal(await oldToken.run(),null);assert.equal(oldToken.calls.length,2);
});

test('v2 pinned template is inactive and still rejects placeholder before credential access',async()=>{
 const yaml=readFileSync(new URL('../templates/oidc-bootstrap-v2.yml.example',import.meta.url),'utf8');assert.equal(existsSync(new URL('../'+PATH,import.meta.url)),false);assert.equal(existsSync(new URL('../'+PATH.replace('-v2.yml','-v1.yml'),import.meta.url)),false);
 const source=yaml.match(/^          ref: (.+)$/m)?.[1];assert.equal(source,'d92d452f6a3beb0f9ae10c1ac7d1083720f86308');assert.equal(createHash('sha256').update(yaml).digest('hex'),'22d8d1a19f11714d3dc89295348b18ee41c299c658b22c945340b9a5bc95f490');assert.equal(yaml.match(/^          HQ_BOOTSTRAP_SOURCE_SHA: (.+)$/m)?.[1],source);
 for(const [path,expected]of [['scripts/oidc-bootstrap-diagnostic.mjs','b5ec2cae53940b151d82e0e273fc5a4f24d8f02445364427d18c241d1d8dff4c'],['package-lock.json','e916fdf8a7cb83062ec8a11b30cd6bc45ddde4df59c4fa79628894ec6be987eb'],['package.json','3a4614679461b159207434356aa5c71a9940186f6b2371b707eca83d6b48268e']])assert.equal(createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex'),expected);
 const pinned=context();pinned.env.HQ_BOOTSTRAP_SOURCE_SHA=source;pinned.env.HQ_BOOTSTRAP_CHECKOUT_SHA=source;const accepted=await fixture({ctx:pinned});assert.equal((await accepted.run()).ok,true);assert.equal(accepted.calls.length,2);
 const ctx=context();ctx.env.HQ_BOOTSTRAP_SOURCE_SHA='REQUIRES_REVIEWED_V2_SOURCE_COMMIT';ctx.env.HQ_BOOTSTRAP_CHECKOUT_SHA=ctx.env.HQ_BOOTSTRAP_SOURCE_SHA;let reads=0;for(const key of ['ACTIONS_ID_TOKEN_REQUEST_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN'])Object.defineProperty(ctx.env,key,{get(){reads++;throw Error('private')}});const f=await fixture({ctx});failure(await f.run(),'CONTEXT','HQ_BOOTSTRAP_SOURCE_SHA');assert.equal(reads,0);assert.equal(f.calls.length,0);
 assert.equal((yaml.match(/--github-oidc-bootstrap-once/g)||[]).length,1);assert.equal((yaml.match(/id-token: write/g)||[]).length,1);assert.equal((yaml.split('jobs:\n')[1].match(/^  [a-z]+:/gm)||[]).length,1);
 for(const value of ['types: [synchronize]','timeout-minutes: 5',"node-version: '22.23.4'","github.run_number == '1'","github.run_attempt == '1'",'persist-credentials: false','package-manager-cache: false','node scripts/oidc-bootstrap-diagnostic.mjs --github-oidc-bootstrap-once'])assert.equal(yaml.includes(value),true);
 assert.equal(/pull_request_target|workflow_dispatch|continue-on-error|upload-artifact|set-output|setSecret/.test(yaml),false);
 for(const m of yaml.matchAll(/uses: ([^\s]+)/g))assert.match(m[1],/^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
});
