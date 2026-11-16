import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {generateKeyPairSync, createHash, sign as rsaSign} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openSqliteTestAuthority} from '../scripts/hq-sqlite-test-adapter.mjs';

// A/B authorization uses the actual JS verifier (jose), authority Worker and store SQL.
// Private keys and JWTs exist only in test memory/piped subprocess stdin.
// This is NOT real GitHub OIDC or GitHub Actions cross-run persistence.
const REPOSITORY = 'haji84/PERSONAL-AI-HQ';
const tuple = {
  sub: 'synthetic-approved-subject',
  workflow_ref: REPOSITORY + '/.github/workflows/autonomous-manager-plan.yml@refs/heads/feature/autonomous-manager-bootstrap',
  workflow_sha: 'a'.repeat(40), ref: 'refs/heads/feature/autonomous-manager-bootstrap',
  event_name: 'workflow_dispatch', environment: null,
  job_workflow_ref: null, job_workflow_sha: null
};
const policy = {audience: 'urn:synthetic:hq-state-integration', goal: 'synthetic-goal', allowed: [tuple]};
const keyPair = generateKeyPairSync('rsa', {modulusLength: 2048, publicExponent: 0x10001});
const publicJwk = {...keyPair.publicKey.export({format: 'jwk'}), kid: 'synthetic-rsa', alg: 'RS256', use: 'sig'};
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const claims = (patch = {}) => {
  const time = Math.floor(Date.now()/1000);
  return {...Object.fromEntries(Object.entries(tuple).filter(([k, v])=>v!==null)),
    iss: 'https://token.actions.githubusercontent.com', aud: policy.audience,
    repository: REPOSITORY, repository_id: '1437383396', repository_owner_id: '173585154',
    run_id: '101', run_attempt: '1', check_run_id: '201',
    iat: time, nbf: time-3, exp: time+120, ...patch};
};
const sign = (patch = {}) => {
  const message = encode({alg: 'RS256', typ: 'JWT', kid: 'synthetic-rsa'})+'.'+encode(claims(patch));
  return message+'.'+rsaSign('RSA-SHA256', Buffer.from(message), keyPair.privateKey).toString('base64url');
};
const processScript = new URL('./fixtures/hq-oidc-sqlite-process.mjs', import.meta.url);
const command = (jobId, idempotencyKey, expectedRevision, expectedEpoch, extra={}) =>
  ({jobId, idempotencyKey, expectedRevision, expectedEpoch, ...extra});
function run(databasePath, operation, body, token=sign(), headers={}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processScript.pathname], {stdio: ['pipe', 'pipe', 'pipe']});
    let output='';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk=>output+=chunk);
    // Do not expose a subprocess failure's potential sensitive stderr.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => {
      if(code!==0) return reject(new Error('synthetic fixture exited ' + code));
      try {resolve(JSON.parse(output))} catch {reject(new Error('synthetic fixture returned malformed status'))}
    });
    child.stdin.end(JSON.stringify({databasePath, operation, body, token, publicJwk, policy, headers}));
  });
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(), 'hq-oidc-sqlite-'));
  t.after(()=>rmSync(dir, {recursive:true, force:true}));
  const file=join(dir, 'authority.sqlite');
  const store=openSqliteTestAuthority(file, {initialize:true});store.close();
  const inspect = sql => {
    const db=new DatabaseSync(file);
    try {return db.prepare(sql).all()} finally {db.close()}
  };
  return {file, inspect};
}

test('actual JS OIDC verifier gates local SQLite mutations, including forged flags', async t => {
  const {file, inspect}=fixture(t);
  const valid=sign();
  const validClaim=command('job-auth','a-claim',0,0,{ttlMs:10000});
  const parts=valid.split('.');
  parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  const denied=[
    sign({repository_id:'wrong'}),sign({aud:'wrong'}),sign({sub:'wrong'}),
    sign({workflow_ref:'unapproved/ref'}),sign({exp:Math.floor(Date.now()/1000)-1}),
    sign({run_id:'01'}),parts.join('.')
  ];
  for(const token of denied) {
    const result=await run(file, 'claim', validClaim, token, {'x-verified': 'true'});
    assert.equal(result.status,401);
  }
  assert.equal(inspect('SELECT COUNT(*) AS n FROM hq_jobs')[0].n,0);
  assert.equal(inspect('SELECT COUNT(*) AS n FROM hq_receipts')[0].n,0);
  const accepted=await run(file,'claim',validClaim,valid);
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.revision,1);
  assert.equal(accepted.body.epoch,1);
  const wrongRunner=await run(file,'commit',command('job-auth','forged-commit',1,1,{state:'RUNNING'}),sign({run_id:'102'}));
  assert.equal(wrongRunner.status,409);
  const wrongBody=await run(file,'claim',{...validClaim, holder:'forged'}, valid);
  assert.equal(wrongBody.status,400);
  assert.equal(inspect('SELECT COUNT(*) AS n FROM hq_events')[0].n,1);
});

test('separate OS processes A/B resume; B/C race atomically, stale leases and replay denied', async t => {
  const {file, inspect}=fixture(t);
  const tokenA=sign(), tokenB=sign({run_id:'102',check_run_id:'202'}), tokenC=sign({run_id:'103',check_run_id:'203'});
  const a=await run(file,'claim',command('job-transfer','a-claim',0,0,{ttlMs:10000}),tokenA);
  assert.equal(a.status,200);
  const started=await run(file,'commit',command('job-transfer','a-start',1,1,{state:'RUNNING',evidenceDigest:digest('synthetic-checkpoint-a')}),tokenA);
  assert.equal(started.status,200);
  const released=await run(file,'release',command('job-transfer','a-release',2,1),tokenA);
  assert.equal(released.status,200);
  const bClaim=command('job-transfer','b-claim',3,1,{ttlMs:20000});
  const cClaim=command('job-transfer','c-claim',3,1,{ttlMs:20000});
  const [b,c]=await Promise.all([run(file,'claim',bClaim,tokenB),run(file,'claim',cClaim,tokenC)]);
  assert.deepEqual([b.status,c.status].sort(),[200,409]);
  const winner=b.status===200 ? {token:tokenB,claim:bClaim} : {token:tokenC,claim:cClaim};
  const loser=b.status===200 ? tokenC : tokenB;
  assert.equal((await run(file,'claim',winner.claim,winner.token)).status,200);
  assert.equal((await run(file,'claim',{...winner.claim,ttlMs:21000},winner.token)).status,409);
  assert.equal((await run(file,'commit',command('job-transfer','stale-a',4,1,{state:'VERIFYING'}),tokenA)).status,409);
  assert.equal((await run(file,'commit',command('job-transfer','wrong-holder',4,2,{state:'VERIFYING'}),loser)).status,409);
  const finished=await run(file,'commit',command('job-transfer','next',4,2,{state:'VERIFYING',evidenceDigest:digest('synthetic-checkpoint-b')}),winner.token);
  assert.equal(finished.status,200);
  assert.equal(finished.body.revision,5);
  assert.equal(finished.body.epoch,2);
  const records=inspect('SELECT revision,epoch,operation FROM hq_events ORDER BY revision');
  assert.deepEqual(records.map(row=>[row.revision,row.epoch,row.operation]),
    [[1,1,'claim'],[2,1,'commit'],[3,1,'release'],[4,2,'claim'],[5,2,'commit']]);
  assert.equal(inspect('SELECT COUNT(*) AS n FROM hq_receipts')[0].n,5);
});

test('expired lease and transactional rollback do not leave orphan events/receipts', async t => {
  const {file, inspect}=fixture(t);
  const tokenA=sign(), claim=command('job-expired','claim',0,0,{ttlMs:1000});
  assert.equal((await run(file,'claim',claim,tokenA)).status,200);
  const db=new DatabaseSync(file);
  try {db.exec("UPDATE hq_jobs SET expires_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)-1 WHERE job_id='job-expired'")} finally {db.close()}
  assert.equal((await run(file,'renew',command('job-expired','expired-renew',1,1,{ttlMs:1000}),tokenA)).status,409);
  assert.equal((await run(file,'commit',command('job-expired','expired-commit',1,1,{state:'RUNNING'}),tokenA)).status,409);
  const dbWithTrigger=new DatabaseSync(file);
  try {dbWithTrigger.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON hq_receipts BEGIN SELECT RAISE(ABORT,'synthetic test failure'); END")} finally {dbWithTrigger.close()}
  assert.equal((await run(file,'claim',command('job-rollback','trigger',0,0,{ttlMs:1000}),tokenA)).status,503);
  assert.equal(inspect('SELECT COUNT(*) AS n FROM hq_jobs')[0].n,1);
  assert.equal(inspect('SELECT COUNT(*) AS n FROM hq_events')[0].n,1);
  assert.equal(inspect('SELECT COUNT(*) AS n FROM hq_receipts')[0].n,1);
});
