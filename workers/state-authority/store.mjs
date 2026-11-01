import {AuthorityError} from './contract.mjs';
const NOW="CAST(unixepoch('subsec')*1000 AS INTEGER)";
const MAX=Number.MAX_SAFE_INTEGER;
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const scopeWhere='repository=? AND goal=? AND job_id=?';
const receiptSql=`SELECT principal,request_digest,result_json FROM hq_receipts WHERE ${scopeWhere} AND idempotency_key=?`;
// All paths, including a losing batch's final SELECT, resolve through this check.
function resolveReceipt(row,holder,digest){
 if(!row)return null;
 if(row.principal!==holder||row.request_digest!==digest)throw new AuthorityError(409,'conflict');
 return JSON.parse(row.result_json);
}
export async function executeCommand(db,principal,command){
 const scope=[principal.repository,principal.goal,command.jobId];
 if(command.operation==='inspect'){
  const results=await db.batch([
   db.prepare(`SELECT job_id AS jobId,state,revision,epoch,expires_ms AS expiresMs FROM hq_jobs WHERE ${scopeWhere}`).bind(...scope),
   db.prepare(`SELECT revision,operation,state,epoch,mutation_ms AS mutationMs,evidence_digest AS evidenceDigest FROM hq_events WHERE ${scopeWhere} ORDER BY revision DESC LIMIT 51`).bind(...scope)
  ]);
  if(!results[0].results[0])throw new AuthorityError(404,'not-found');
  return {job:results[0].results[0],events:results[1].results.slice(0,50),truncated:results[1].results.length>50};
 }
 const holder=await sha([principal.subject,principal.executionId]);
 const digest=await sha([principal.repository,principal.goal,command]);
 const lookup=()=>db.prepare(receiptSql).bind(...scope,command.idempotencyKey).first();
 const prior=resolveReceipt(await lookup(),holder,digest);if(prior)return prior;
 const nonce=crypto.randomUUID();let mutation;
 if(command.operation==='claim'){
  mutation=db.prepare(`INSERT INTO hq_jobs(repository,goal,job_id,state,revision,epoch,holder,expires_ms,mutation_ms,last_operation)
   SELECT ?,?,?,'QUEUED',1,1,?,${NOW}+?,${NOW},? WHERE ?=0 AND ?=0
   ON CONFLICT(repository,goal,job_id) DO UPDATE SET revision=revision+1,epoch=epoch+1,holder=excluded.holder,expires_ms=excluded.expires_ms,mutation_ms=excluded.mutation_ms,last_operation=excluded.last_operation
   WHERE revision=? AND epoch=? AND expires_ms<=${NOW} AND revision<${MAX} AND epoch<${MAX}`).bind(...scope,holder,command.ttlMs,nonce,command.expectedRevision,command.expectedEpoch,command.expectedRevision,command.expectedEpoch);
  // Existing jobs must also be claimable: INSERT's SELECT is zero for nonzero counters.
  // Use an UPDATE for that path rather than permitting creation with nonzero counters.
  if(command.expectedRevision!==0||command.expectedEpoch!==0)
   mutation=db.prepare(`UPDATE hq_jobs SET revision=revision+1,epoch=epoch+1,holder=?,expires_ms=${NOW}+?,mutation_ms=${NOW},last_operation=? WHERE ${scopeWhere} AND revision=? AND epoch=? AND expires_ms<=${NOW} AND revision<${MAX} AND epoch<${MAX}`).bind(holder,command.ttlMs,nonce,...scope,command.expectedRevision,command.expectedEpoch);
 }else{
  let assignment='';const values=[];let transition='';
  if(command.operation==='renew'){assignment=`expires_ms=MAX(expires_ms,${NOW}+?),`;values.push(command.ttlMs)}
  else if(command.operation==='release')assignment='holder=NULL,expires_ms=0,';
  else if(command.operation==='commit'){
   assignment='state=?,';values.push(command.state);
   transition=" AND ((state='QUEUED' AND ? IN ('RUNNING','BLOCKED','AWAITING_APPROVAL')) OR (state='RUNNING' AND ? IN ('VERIFYING','BLOCKED')) OR (state='VERIFYING' AND ? IN ('QUEUED','BLOCKED')) OR (state='BLOCKED' AND ?='QUEUED'))";
  }else throw new AuthorityError(400,'invalid-request');
  mutation=db.prepare(`UPDATE hq_jobs SET ${assignment}revision=revision+1,mutation_ms=${NOW},last_operation=? WHERE ${scopeWhere} AND revision=? AND epoch=? AND holder=? AND expires_ms>${NOW} AND revision<${MAX}${transition}`).bind(...values,nonce,...scope,command.expectedRevision,command.expectedEpoch,holder,...(transition?Array(4).fill(command.state):[]));
 }
 const guard=`${scopeWhere} AND last_operation=?`;
 const event=db.prepare(`INSERT INTO hq_events(repository,goal,job_id,revision,operation,state,epoch,mutation_ms,evidence_digest) SELECT repository,goal,job_id,revision,?,state,epoch,mutation_ms,? FROM hq_jobs WHERE ${guard}`).bind(command.operation,command.evidenceDigest??null,...scope,nonce);
 const receipt=db.prepare(`INSERT INTO hq_receipts(repository,goal,job_id,idempotency_key,principal,request_digest,result_json) SELECT repository,goal,job_id,?,?,?,json_object('jobId',job_id,'state',state,'revision',revision,'epoch',epoch,'expiresMs',expires_ms) FROM hq_jobs WHERE ${guard}`).bind(command.idempotencyKey,holder,digest,...scope,nonce);
 let row;
 try{
  const results=await db.batch([mutation,event,receipt,db.prepare(receiptSql).bind(...scope,command.idempotencyKey)]);
  row=results[3].results[0];
 }catch{
  // The response may have been lost after commit. Never invent a fresh key or assume rollback.
  try{row=await lookup()}catch{throw new AuthorityError(503,'retryable-unknown')}
  const recovered=resolveReceipt(row,holder,digest);if(recovered)return recovered;
  throw new AuthorityError(503,'retryable-unknown');
 }
 const result=resolveReceipt(row,holder,digest);if(result)return result;
 throw new AuthorityError(409,'conflict');
}
