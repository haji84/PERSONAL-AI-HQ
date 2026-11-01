const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value);
const counter=value=>Number.isSafeInteger(value)&&value>=0;
const states=new Set(['QUEUED','RUNNING','VERIFYING','BLOCKED','AWAITING_APPROVAL']);
export class AuthorityError extends Error { constructor(status,code){super(code);this.status=status;this.code=code} }
const invalid=()=>{throw new AuthorityError(400,'invalid-request')};
export function validatePrincipal(principal,scope){
 if(!principal||!opaque(principal.subject)||!opaque(principal.executionId)||!id(scope.goal)||typeof scope.repository!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(scope.repository)||principal.repository!==scope.repository||principal.goal!==scope.goal) throw new AuthorityError(401,'unauthorized');
 return {subject:principal.subject,executionId:principal.executionId,repository:scope.repository,goal:scope.goal};
}
export function validateCommand(operation,body){
 if(!['claim','renew','commit','release','inspect'].includes(operation)||!body||typeof body!=='object'||Array.isArray(body)) invalid();
 const fields=['jobId'];if(operation!=='inspect') fields.push('idempotencyKey','expectedRevision','expectedEpoch');
 if(['claim','renew'].includes(operation))fields.push('ttlMs');if(operation==='commit')fields.push('state','evidenceDigest');
 if(Object.keys(body).some(k=>!fields.includes(k))||!id(body.jobId)) invalid();
 const command={operation,jobId:body.jobId};
 if(operation==='inspect')return command;
 if(!id(body.idempotencyKey)||!counter(body.expectedRevision)||!counter(body.expectedEpoch))invalid();
 Object.assign(command,{idempotencyKey:body.idempotencyKey,expectedRevision:body.expectedRevision,expectedEpoch:body.expectedEpoch});
 if(['claim','renew'].includes(operation)){if(!Number.isInteger(body.ttlMs)||body.ttlMs<1000||body.ttlMs>300000)invalid();command.ttlMs=body.ttlMs}
 if(operation==='commit'){
  if(!states.has(body.state)||(body.evidenceDigest!==undefined&&(typeof body.evidenceDigest!=='string'||!(/^[a-f0-9]{64}$/).test(body.evidenceDigest))))invalid();
  command.state=body.state;command.evidenceDigest=body.evidenceDigest??null;
 }
 return command;
}
