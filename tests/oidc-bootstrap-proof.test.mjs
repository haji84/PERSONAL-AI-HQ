import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runBootstrapProof} from '../scripts/oidc-bootstrap-proof.mjs';

const REPO='haji84/PERSONAL-AI-HQ',RID='1437383396',OID='173585154',BRANCH='feature/autonomous-manager-bootstrap';
const PATH='.github/workflows/hq-oidc-bootstrap-pr11-v1.yml',REF='refs/pull/11/merge',WORKFLOW=REPO+'/'+PATH+'@'+REF;
const ISSUER='https://token.actions.githubusercontent.com',AUD='urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v1',NOW=1800000000;
const SUBJECTS=['repo:'+REPO+':pull_request','repo:haji84@173585154/PERSONAL-AI-HQ@1437383396:pull_request'];
const PUBLIC=['sub','repository','repository_id','repository_owner_id','ref','workflow_ref','workflow_sha','run_id','run_number','run_attempt','check_run_id'];
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const key={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'synthetic-bootstrap',alg:'RS256',use:'sig'};
const b64=v=>Buffer.from(v).toString('base64url');
function context(){const repo={id:Number(RID),full_name:REPO,private:false,owner:{id:Number(OID)}};return {env:{GITHUB_ACTIONS:'true',GITHUB_SERVER_URL:'https://github.com',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:REPO,GITHUB_REPOSITORY_ID:RID,GITHUB_REPOSITORY_OWNER_ID:OID,GITHUB_REF:REF,GITHUB_HEAD_REF:BRANCH,GITHUB_BASE_REF:'main',GITHUB_RUN_ID:'101',GITHUB_RUN_NUMBER:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:WORKFLOW,GITHUB_WORKFLOW_SHA:'b'.repeat(40),GITHUB_SHA:'c'.repeat(40),RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',HQ_BOOTSTRAP_SOURCE_SHA:'a'.repeat(40),HQ_BOOTSTRAP_CHECKOUT_SHA:'a'.repeat(40),HQ_BOOTSTRAP_CHECK_RUN_ID:'201',ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.synthetic.actions.githubusercontent.com/token?api-version=2',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-credential'},event:{action:'synchronize',number:11,repository:repo,pull_request:{number:11,head:{ref:BRANCH,repo},base:{ref:'main',repo}}}};}
function claims(){return {iss:ISSUER,aud:AUD,sub:SUBJECTS[0],repository:REPO,repository_id:RID,repository_owner_id:OID,repository_visibility:'public',event_name:'pull_request',head_ref:BRANCH,base_ref:'main',ref:REF,workflow_ref:WORKFLOW,workflow_sha:'b'.repeat(40),run_id:'101',run_number:'1',run_attempt:'1',check_run_id:'201',iat:NOW,nbf:NOW-5,exp:NOW+300};}
async function token(patch={},header={}){const c={...claims(),...patch};for(const k of Object.keys(c))if(c[k]===undefined)delete c[k];const input=b64(JSON.stringify({alg:'RS256',typ:'JWT',kid:key.kid,...header}))+'.'+b64(JSON.stringify(c));return input+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input)));}
async function fixture({ctx=context(),patch,header,fetcher}={}){const jwt=await token(patch,header),calls=[];let now=NOW*1000;return {ctx,calls,jwt,advance:ms=>{now+=ms},run:()=>runBootstrapProof(ctx,{now:()=>now,fetch:async(url,init)=>{calls.push({url,init});return fetcher?fetcher(url,init,calls.length,jwt):calls.length===1?Response.json({value:jwt}):Response.json({keys:[key]});}})};}

test('one mint and one fixed JWKS fetch produce only verified public fields',async()=>{
 const f=await fixture({patch:{private_metadata:'never-output',actor:'never-output'}}),proof=await f.run();assert.ok(proof);assert.deepEqual(Object.keys(proof).sort(),[...PUBLIC].sort());assert.equal(JSON.stringify(proof).includes('never-output'),false);
 assert.equal(proof.sub,SUBJECTS[0]);assert.equal(f.calls.length,2);assert.equal(new URL(f.calls[0].url).searchParams.get('audience'),AUD);assert.equal(f.calls[1].url,ISSUER+'/.well-known/jwks');
 assert.equal(new Headers(f.calls[0].init.headers).get('authorization')==='Bearer '+f.ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,true);
 assert.equal(new Headers(f.calls[1].init.headers).has('authorization'),false);for(const {init}of f.calls){assert.equal(init.redirect,'error');assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');}
});
test('immutable public subject is accepted but unknown/custom subject is never disclosed',async()=>{
 assert.ok(await(await fixture({patch:{sub:SUBJECTS[1]}})).run());assert.equal(await(await fixture({patch:{sub:'private:custom:never-output'}})).run(),null);
});
test('invalid context never reads credential getters or fetches',async()=>{
 for(const patch of [{GITHUB_RUN_NUMBER:'2'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_REPOSITORY_ID:'999'},{GITHUB_HEAD_REF:'other'},{GITHUB_BASE_REF:'other'},{GITHUB_REF:'refs/pull/12/merge'},{GITHUB_WORKFLOW_REF:'other'},{RUNNER_ENVIRONMENT:'self-hosted'},{RUNNER_OS:'Windows'},{HQ_BOOTSTRAP_SOURCE_SHA:'REQUIRES_REVIEWED_SOURCE_COMMIT'},{HQ_BOOTSTRAP_CHECKOUT_SHA:'d'.repeat(40)},{HQ_BOOTSTRAP_CHECK_RUN_ID:''}]){
  const ctx=context();Object.assign(ctx.env,patch);let reads=0;for(const name of ['ACTIONS_ID_TOKEN_REQUEST_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN'])Object.defineProperty(ctx.env,name,{get(){reads++;throw Error('private');}});
  const f=await fixture({ctx});assert.equal(await f.run(),null);assert.equal(reads,0);assert.equal(f.calls.length,0);
 }
 for(const mutate of [c=>c.event.number=12,c=>c.event.action='opened',c=>c.event.pull_request.head.repo=null,c=>c.event.pull_request.head.ref='other',c=>c.event.repository.private=true]){const ctx=context();mutate(ctx);const f=await fixture({ctx});assert.equal(await f.run(),null);assert.equal(f.calls.length,0);}
});
test('runtime endpoint and credential bounds reject before transmission',async()=>{
 for(const url of ['http://pipelines.actions.githubusercontent.com/token','https://actions.githubusercontent.com.evil.invalid/token','https://evilactions.githubusercontent.com/token','https://user@pipelines.actions.githubusercontent.com/token','https://pipelines.actions.githubusercontent.com:444/token','https://pipelines.actions.githubusercontent.com/token#x','https://pipelines.actions.githubusercontent.com/token?audience=other','https://pipelines.actions.githubusercontent.com/token?AuDiEnCe=other','https://pipelines.actions.githubusercontent.com/'+('a'.repeat(2100))]){const ctx=context();ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL=url;const f=await fixture({ctx});assert.equal(await f.run(),null);assert.equal(f.calls.length,0);}
 for(const value of ['', 'x'.repeat(16385),'contains\nnewline']){const ctx=context();ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN=value;const f=await fixture({ctx});assert.equal(await f.run(),null);assert.equal(f.calls.length,0);}
});
for(const name of ['iss','aud','repository','repository_id','repository_owner_id','repository_visibility','event_name','head_ref','base_ref','ref','workflow_ref','workflow_sha','run_id','run_number','run_attempt','check_run_id'])test('signed '+name+' must match strict public context',async()=>{
 for(const value of [undefined,'wrong',1,[]]){const f=await fixture({patch:{[name]:value}});assert.equal(await f.run(),null);assert.equal(f.calls.length,2);}
});
test('environment reusable claims dates and audience arrays fail closed',async()=>{
 for(const patch of [{environment:null},{environment:'secret'},{job_workflow_ref:null},{job_workflow_sha:'a'.repeat(40)},{aud:[AUD]},{exp:NOW},{iat:NOW+1},{nbf:NOW+1},{exp:NOW+601},{iat:NOW-601},{iat:0.5}])assert.equal(await(await fixture({patch})).run(),null);
});
test('unsupported JOSE headers deny without JWKS fetch',async()=>{
 for(const header of [{alg:'none'},{alg:'HS256'},{typ:'other'},{kid:''},{jku:'https://never.invalid'},{jwk:key},{crit:[]},{b64:true},{x5u:'https://never.invalid'},{x5c:[]}]){const f=await fixture({header});assert.equal(await f.run(),null);assert.equal(f.calls.length,1);}
});
test('mint failure or uncertain malformed response never remints or leaks errors',async()=>{
 for(const fetcher of [()=>{throw Error('private failure detail')},()=>new Response('',{status:503}),()=>new Response('',{status:302,headers:{location:'https://never.invalid'}}),()=>new Response('private not-json'),()=>Response.json({value:'bad'}),()=>new Response('x'.repeat(32769))]){const f=await fixture({fetcher});assert.equal(await f.run(),null);assert.equal(f.calls.length,1);}
});
test('JWKS failure ambiguity private keys and size limits never trigger a second request',async()=>{
 const bodies=[{}, {keys:[]},{keys:[key,key]},{keys:[{...key,d:'never-output'}]},{keys:[{...key,e:'Ag'}]},{keys:[{...key,n:b64(new Uint8Array(1025).fill(255))}]}];
 for(const body of bodies){const f=await fixture({fetcher:(_u,_i,n,jwt)=>n===1?Response.json({value:jwt}):Response.json(body)});assert.equal(await f.run(),null);assert.equal(f.calls.length,2);}
 const f=await fixture({fetcher:(_u,_i,n,jwt)=>n===1?Response.json({value:jwt}):new Response('x'.repeat(65537))});assert.equal(await f.run(),null);assert.equal(f.calls.length,2);
});
test('token expiry during transport denies at completion',async()=>{
 let f;f=await fixture({fetcher:(_u,_i,n,jwt)=>{if(n===2)f.advance(300000);return n===1?Response.json({value:jwt}):Response.json({keys:[key]});}});assert.equal(await f.run(),null);assert.equal(f.calls.length,2);
});
test('timeout covers stalled mint body with no retry',async()=>{
 let aborted=false;const f=await fixture({fetcher:(_u,init)=>{init.signal.addEventListener('abort',()=>{aborted=true});return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));}});assert.equal(await f.run(),null);assert.equal(aborted,true);assert.equal(f.calls.length,1);
});
test('CLI without explicit flag fails generically and never prints environment',()=>{
 const result=spawnSync(process.execPath,['scripts/oidc-bootstrap-proof.mjs'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,ACTIONS_ID_TOKEN_REQUEST_TOKEN:'private-sentinel'}});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'OIDC_BOOTSTRAP_FAILED\n');
});
test('bootstrap cleanup restores absence and the exact read-only workflow inventory',async()=>{
 const file=new URL('../templates/oidc-bootstrap.yml.example',import.meta.url);assert.equal(existsSync(file),true);const yaml=readFileSync(file,'utf8');
 // Exact reviewed lifecycle contract; changing these bytes requires fresh review.
 const workflowDir=new URL('../.github/workflows/',import.meta.url);
 const activePath=new URL('../'+PATH,import.meta.url);
 const digest=value=>createHash('sha256').update(value).digest('hex');
 assert.equal(digest(yaml),'8d9f705e240e05b7bc13beb4a9a022d0fdd13c33b35d4fbcfa3ac3bd1778b4e4');
 const readOnlyPath=new URL('../.github/workflows/autonomous-manager-plan.yml',import.meta.url);
 assert.equal(lstatSync(readOnlyPath).isFile(),true);
 assert.equal(digest(readFileSync(readOnlyPath)),'5dab11b6e988c9d3313c4725588263c6e31ca074c94fe3143fa529d135c7f974');
 assert.deepEqual(readdirSync(workflowDir).sort(),['autonomous-manager-plan.yml']);
 assert.equal(existsSync(activePath),false);
 assert.equal(yaml.includes('REQUIRES_REVIEWED_SOURCE_COMMIT'),false);
 const source=yaml.match(/^          ref: (.+)$/m)?.[1];assert.equal(source,'8342cbc80f72d2240aaa4bdc6058e78733027f20');
 assert.equal(yaml.match(/^          HQ_BOOTSTRAP_SOURCE_SHA: (.+)$/m)?.[1],source);
 for(const [path,expected]of [['scripts/oidc-bootstrap-proof.mjs','d5b24bea4e5d175b268570032b9b906868bbbc840c2c73269404d582306b9a65'],['package-lock.json','e916fdf8a7cb83062ec8a11b30cd6bc45ddde4df59c4fa79628894ec6be987eb'],['package.json','3a4614679461b159207434356aa5c71a9940186f6b2371b707eca83d6b48268e']])assert.equal(createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex'),expected);
 const ctx=context();ctx.env.HQ_BOOTSTRAP_SOURCE_SHA=source;ctx.env.HQ_BOOTSTRAP_CHECKOUT_SHA=source;const pinned=await fixture({ctx});assert.ok(await pinned.run());assert.equal(pinned.calls.length,2);
 const draftContext=context();draftContext.env.HQ_BOOTSTRAP_SOURCE_SHA='REQUIRES_REVIEWED_SOURCE_COMMIT';draftContext.env.HQ_BOOTSTRAP_CHECKOUT_SHA='REQUIRES_REVIEWED_SOURCE_COMMIT';const draft=await fixture({ctx:draftContext});assert.equal(await draft.run(),null);assert.equal(draft.calls.length,0);
 assert.equal((yaml.split('jobs:\n')[1].match(/^  [a-z]+:/gm)||[]).length,1);assert.equal((yaml.match(/id-token: write/g)||[]).length,1);
 assert.equal((yaml.match(/--github-oidc-bootstrap-once/g)||[]).length,1);assert.match(yaml,/timeout-minutes: 5/);assert.match(yaml,/node-version: '22\.23\.4'/);assert.match(yaml,/run_number == '1'/);assert.match(yaml,/run_attempt == '1'/);
 assert.match(yaml,/types: \[synchronize\]/);assert.match(yaml,/package-manager-cache: false/);assert.match(yaml,/persist-credentials: false/);
 assert.equal(/pull_request_target|workflow_dispatch|continue-on-error|upload-artifact|set-output|setSecret/.test(yaml),false);
 for(const match of yaml.matchAll(/uses: ([^\s]+)/g))assert.match(match[1],/^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
 const active=readFileSync(new URL('../.github/workflows/autonomous-manager-plan.yml',import.meta.url),'utf8');assert.equal(active.includes('id-token:'),false);
});

test('explicit default port is rejected before reading request credential',async()=>{
 const ctx=context();ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL='https://pipelines.actions.githubusercontent.com:443/token';let reads=0;Object.defineProperty(ctx.env,'ACTIONS_ID_TOKEN_REQUEST_TOKEN',{get(){reads++;return 'synthetic';}});const f=await fixture({ctx});assert.equal(await f.run(),null);assert.equal(reads,0);assert.equal(f.calls.length,0);
});
test('bad signature and unknown signing kid cannot become public proof',async()=>{
 for(const change of [jwt=>{const parts=jwt.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);return parts.join('.');}]){const f=await fixture({fetcher:(_u,_i,n,jwt)=>n===1?Response.json({value:change(jwt)}):Response.json({keys:[key]})});assert.equal(await f.run(),null);assert.equal(f.calls.length,2);}
 const f=await fixture({header:{kid:'unknown'}});assert.equal(await f.run(),null);assert.equal(f.calls.length,2);
});
