import test from 'node:test';
import assert from 'node:assert/strict';
import {createGitHubActionsOidcAuthorizer} from '../scripts/hq-oidc-auth.mjs';

// Synthetic in-memory keys only. Never print tokens, private keys, or claims.
const ISSUER='https://token.actions.githubusercontent.com';
const JWKS=ISSUER+'/.well-known/jwks';
const REPOSITORY='haji84/PERSONAL-AI-HQ';
const NOW=1800000000;
const encoder=new TextEncoder();
const b64=value=>Buffer.from(value).toString('base64url');
const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicKey={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'synthetic-key',alg:'RS256',use:'sig'};
function tuple(){return {sub:'synthetic-explicit-subject',workflow_ref:REPOSITORY+'/.github/workflows/controller.yml@refs/heads/main',workflow_sha:'a'.repeat(40),ref:'refs/heads/main',event_name:'workflow_dispatch',environment:null,job_workflow_ref:null,job_workflow_sha:null};}
function config(){return {audience:'urn:synthetic:hq',goal:'synthetic-goal',allowed:[tuple()]};}
function claims(){const {environment,job_workflow_ref,job_workflow_sha,...required}=tuple();return {...required,iss:ISSUER,aud:'urn:synthetic:hq',repository:REPOSITORY,repository_id:'1437383396',repository_owner_id:'173585154',run_id:'101',run_attempt:'1',check_run_id:'201',iat:NOW,nbf:NOW-5,exp:NOW+300};}
async function token(patch={},headerPatch={}){
 const body={...claims(),...patch};
 for(const key of Object.keys(body))if(body[key]===undefined)delete body[key];
 const header={alg:'RS256',typ:'JWT',kid:'synthetic-key',...headerPatch};
 const signing=b64(JSON.stringify(header))+'.'+b64(JSON.stringify(body));
 return signing+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,encoder.encode(signing)));
}
const request=(jwt,extra={})=>new Request('https://synthetic.invalid/v1/claim',{method:'POST',headers:{authorization:'Bearer '+jwt,...extra},body:'{"holder":"untrusted"}'});
function fixture({cfg=config(),fetcher,now=NOW*1000}={}){
 let current=now;const calls=[];
 const fetch=async(url,init)=>{calls.push({url,init});return fetcher?fetcher(url,init,calls.length):Response.json({keys:[publicKey]});};
 return {authorize:createGitHubActionsOidcAuthorizer(cfg,{fetch,now:()=>current}),calls,advance:ms=>{current+=ms;}};
}
const deny=async(authorize,jwt)=>assert.equal(await authorize(request(jwt)),null);

test('strict valid token accepts provider-shaped nbf before iat without reading body',async()=>{
 const f=fixture(),r=request(await token());const result=await f.authorize(r);
 assert.ok(result);assert.deepEqual(Object.keys(result).sort(),['executionId','goal','repository','subject']);
 assert.match(result.subject,/^[a-f0-9]{64}$/);assert.match(result.executionId,/^[a-f0-9]{64}$/);
 assert.equal(result.repository,REPOSITORY);assert.equal(result.goal,'synthetic-goal');assert.equal(r.bodyUsed,false);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,JWKS);assert.equal(f.calls[0].init.redirect,'error');
 assert.equal(f.calls[0].init.method,'GET');assert.equal(new Headers(f.calls[0].init.headers).has('authorization'),false);
});
test('identity is stable across token refresh and distinct for run attempt or check-run',async()=>{
 const f=fixture();const first=await f.authorize(request(await token({jti:'first'})));assert.ok(first);
 const refreshed=await f.authorize(request(await token({jti:'second',iat:NOW-1})));assert.deepEqual(refreshed,first);
 for(const change of [{run_id:'102'},{run_attempt:'2'},{check_run_id:'202'}]){const other=await f.authorize(request(await token(change)));assert.ok(other);assert.notEqual(other.executionId,first.executionId);}
});
test('missing malformed or mutated config never creates new scope',async()=>{
 for(const cfg of [undefined,null,{}, {...config(),audience:''},{...config(),goal:''},{...config(),allowed:[]},{...config(),allowed:[{...tuple(),environment:undefined}]},{...config(),allowed:[{...tuple(),job_workflow_sha:'b'.repeat(40)}]}]){
  const f=fixture({cfg:cfg===undefined?{}:cfg});await deny(f.authorize,await token());assert.equal(f.calls.length,0);
 }
 const cfg=config(),f=fixture({cfg});cfg.goal='changed';cfg.allowed[0].sub='changed';cfg.allowed.push({...tuple(),sub:'new'});
 assert.equal((await f.authorize(request(await token()))).goal,'synthetic-goal');await deny(f.authorize,await token({sub:'new'}));
 assert.equal(await createGitHubActionsOidcAuthorizer()(request(await token())),null);
});
for(const name of ['iss','aud','sub','repository','repository_id','repository_owner_id','workflow_ref','workflow_sha','ref','event_name','run_id','run_attempt','check_run_id']){
 test('rejects missing or mismatched required '+name,async()=>{
  const f=fixture();await deny(f.authorize,await token({[name]:undefined}));
  if(!['run_id','run_attempt','check_run_id'].includes(name))await deny(f.authorize,await token({[name]:'untrusted'}));
  for(const value of [[],{},null,1,''])await deny(f.authorize,await token({[name]:value}));
 });
}
test('exact audience and canonical numeric IDs only',async()=>{
 const f=fixture();for(const patch of [{aud:['urn:synthetic:hq']},{run_id:'01'},{run_attempt:'0'},{check_run_id:'-1'},{run_id:'1'.repeat(21)},{sub:'s'.repeat(1025)}])await deny(f.authorize,await token(patch));
});
test('trust tuples do not permit cross-product and explicitly constrain environment/reusable workflow',async()=>{
 const second={...tuple(),sub:'second',ref:'refs/heads/other'},f=fixture({cfg:{...config(),allowed:[tuple(),second]}});
 await deny(f.authorize,await token({sub:'second'}));await deny(f.authorize,await token({environment:'production'}));
 await deny(f.authorize,await token({job_workflow_ref:'anything'}));
 const reusable={...tuple(),environment:'approved',job_workflow_ref:REPOSITORY+'/.github/workflows/reusable.yml@'+('b'.repeat(40)),job_workflow_sha:'b'.repeat(40)};
 const g=fixture({cfg:{...config(),allowed:[reusable]}});assert.ok(await g.authorize(request(await token(reusable))));
 await deny(g.authorize,await token({...reusable,environment:undefined}));await deny(g.authorize,await token({...reusable,job_workflow_sha:undefined}));
});
test('strict time claims reject every invalid boundary and excessive age/lifetime',async()=>{
 const f=fixture();for(const patch of [{exp:NOW},{exp:NOW-1},{iat:NOW+1},{nbf:NOW+1},{nbf:NOW+300},{exp:NOW+601},{iat:NOW-601,nbf:NOW-601,exp:NOW+1}])await deny(f.authorize,await token(patch));
 for(const key of ['iat','nbf','exp'])for(const value of [undefined,null,'1',-1,0.5,Number.MAX_SAFE_INTEGER+1])await deny(f.authorize,await token({[key]:value}));
 assert.ok(await f.authorize(request(await token({iat:NOW-599,nbf:NOW-604,exp:NOW+1}))));
});
test('bad credentials encoding algorithms and JOSE extensions deny before fetching',async()=>{
 for(const raw of ['', 'Basic abc','Bearer a.b.c, Bearer a.b.c','Bearer a.b.c d','Bearer '+('x'.repeat(16385))]){const f=fixture();assert.equal(await f.authorize(new Request('https://synthetic.invalid',{headers:{authorization:raw}})),null);assert.equal(f.calls.length,0);}
 for(const jwt of ['abc','a.b.c.d','a=.b.c','a.b=.c','a.b.c=']){const f=fixture();await deny(f.authorize,jwt);assert.equal(f.calls.length,0);}
 for(const h of [{alg:'none'},{alg:'HS256'},{alg:'PS256'},{typ:'not-jwt'},{typ:undefined},{kid:''},{kid:'k'.repeat(129)},{crit:[]},{b64:true},{jku:'https://untrusted.invalid'},{jwk:publicKey},{x5u:'https://untrusted.invalid'},{x5c:[]}]){const f=fixture();await deny(f.authorize,await token({},h));assert.equal(f.calls.length,0);}
});
test('bad signature does not trigger refresh and fresh key is cached',async()=>{
 const f=fixture(),jwt=await token();assert.ok(await f.authorize(request(jwt)));const parts=jwt.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);await deny(f.authorize,parts.join('.'));assert.equal(f.calls.length,1);assert.ok(await f.authorize(request(jwt)));
});
test('unknown kid cooldown bounds fetches without blocking fresh known key',async()=>{
 const f=fixture(),valid=await token(),unknown=await token({},{kid:'unknown'});assert.ok(await f.authorize(request(valid)));
 await deny(f.authorize,unknown);assert.equal(f.calls.length,1);f.advance(30000);await deny(f.authorize,unknown);assert.equal(f.calls.length,2);
 for(let n=0;n<10;n++)await deny(f.authorize,await token({},{kid:'random-'+n}));assert.equal(f.calls.length,2);assert.ok(await f.authorize(request(valid)));
});
test('failed refresh never extends freshness or strands refresh guard',async()=>{
 const f=fixture({fetcher:(_url,_init,count)=>count===1?Response.json({keys:[publicKey]}):count===2?Response.json({keys:[]}):Response.json({keys:[publicKey]})});
 assert.ok(await f.authorize(request(await token())));f.advance(300000);await deny(f.authorize,await token({iat:NOW+300,nbf:NOW+295,exp:NOW+600}));assert.equal(f.calls.length,2);
 await deny(f.authorize,await token({iat:NOW+300,nbf:NOW+295,exp:NOW+600}));assert.equal(f.calls.length,2);
 f.advance(30000);assert.ok(await f.authorize(request(await token({iat:NOW+330,nbf:NOW+325,exp:NOW+630}))));assert.equal(f.calls.length,3);
});
test('JWKS and RSA constraints reject malformed ambiguous excessive or private keys',async()=>{
 const badKeys=[{...publicKey,kty:'oct'},{...publicKey,alg:'HS256'},{...publicKey,use:'enc'},{...publicKey,key_ops:['sign','verify']},{...publicKey,d:'private'},{...publicKey,p:'private'},{...publicKey,n:b64(new Uint8Array(255).fill(255))},{...publicKey,n:b64(new Uint8Array(1025).fill(255))},{...publicKey,e:'Ag'},{...publicKey,e:'AQAAAAE'},{...publicKey,e:'AAEAAQ'},{...publicKey,kid:''}];
 for(const body of [null,[],{}, {keys:[]},{keys:[publicKey,publicKey]}, {keys:Array.from({length:21},(_,i)=>({...publicKey,kid:String(i)}))},...badKeys.map(key=>({keys:[key]}))]){const f=fixture({fetcher:()=>Response.json(body)});await deny(f.authorize,await token());}
});
test('network redirects errors oversized and broken streams fail closed',async()=>{
 const fetchers=[()=>{throw Error('synthetic fetch failure')},()=>new Response('',{status:503}),()=>new Response('',{status:302,headers:{location:'https://untrusted.invalid'}}),()=>new Response('not json'),()=>new Response('x'.repeat(65537)),()=>new Response('{}',{headers:{'content-length':'65537'}}),()=>new Response(new ReadableStream({start(c){c.enqueue(encoder.encode('{'));c.error(Error('synthetic stream failure'));}}))];
 for(const fetcher of fetchers){const f=fixture({fetcher});await deny(f.authorize,await token());assert.equal(f.calls.length,1);}
});
test('concurrent refresh does not share request-scoped I/O',async()=>{
 let finish;const f=fixture({fetcher:()=>new Promise(resolve=>{finish=resolve;})}),jwt=await token();const pending=f.authorize(request(jwt));
 for(let i=0;!finish&&i<100;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finish,'function');await deny(f.authorize,jwt);assert.equal(f.calls.length,1);finish(Response.json({keys:[publicKey]}));assert.ok(await pending);
});
test('timeout includes stalled body consumption and releases refresh guard',async()=>{
 let aborted=false;const f=fixture({fetcher:(_url,init)=>{init.signal.addEventListener('abort',()=>{aborted=true});return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));}});
 await deny(f.authorize,await token());assert.equal(aborted,true);f.advance(30000);await deny(f.authorize,await token());assert.equal(f.calls.length,2);
});

test('explicit null optional claims cannot masquerade as absent',async()=>{
 const f=fixture();for(const key of ['environment','job_workflow_ref','job_workflow_sha'])await deny(f.authorize,await token({[key]:null}));
});
test('key cache must still be fresh when verification completes',async()=>{
 const times=[NOW*1000,NOW*1000,(NOW+300)*1000];
 const authorize=createGitHubActionsOidcAuthorizer(config(),{now:()=>times.shift(),fetch:async()=>Response.json({keys:[publicKey]})});
 await deny(authorize,await token({exp:NOW+600}));
});

test('goal configuration matches authority identifier contract before network access',async()=>{
 for(const goal of ['with space','slash/path','日本語','with.dot']){const f=fixture({cfg:{...config(),goal}});await deny(f.authorize,await token());assert.equal(f.calls.length,0);}
});
test('expiry during awaited identity hashing denies at authorization completion',async()=>{
 const jwt=await token({exp:NOW+1}),f=fixture(),original=crypto.subtle.digest;
 crypto.subtle.digest=async function(...args){f.advance(1000);return original.apply(this,args);};
 try{await deny(f.authorize,jwt);}finally{crypto.subtle.digest=original;}
});

test('reserved bootstrap audience can never authorize state even with matching configuration',async()=>{
 for(const audience of ['urn:personal-ai-hq:oidc-bootstrap:repo-1437383396:pr-11:v1','urn:personal-ai-hq:oidc-bootstrap:future']){
  const f=fixture({cfg:{...config(),audience}});await deny(f.authorize,await token({aud:audience}));assert.equal(f.calls.length,0);
 }
});
