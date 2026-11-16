// Optional encrypted transport for a synthetic review checkpoint.
// Possession of the key verifies confidentiality/integrity, NOT identity, cloud storage or release approval.
// No network, persistence, workflow activation, main merge, or external credential access.
import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
const SHA40=/^[a-f0-9]{40}$/,SHA64=/^[a-f0-9]{64}$/;
const JOB=/^[A-Za-z0-9_-]{1,80}$/;
const SCOPE='synthetic-review-checkpoint';
const MAX_BYTES=65536;
const required=['authority','baseSha','ciphertext','digest','jobId','nextTaskDispatched','nonce',
 'releaseAuthorized','revision','schema','scope','tag'].sort().join(',');
function keyBytes(key){
 if(!(key instanceof Uint8Array)||key.byteLength!==32)throw Error('Invalid transfer key');
 return Buffer.from(key);
}
function validateContext(baseSha,jobId,revision){
 if(!SHA40.test(baseSha??'')||!JOB.test(jobId??'')||!Number.isSafeInteger(revision)||revision<0)
  throw Error('Invalid checkpoint context');
}
function digestOf(bytes){return createHash('sha256').update(bytes).digest('hex')}
function associatedData({baseSha,jobId,revision,digest}){
 return Buffer.from(JSON.stringify([1,SCOPE,baseSha,jobId,revision,digest]),'utf8');
}
function read64(value,maxChars){
 if(typeof value!=='string'||value.length===0||value.length>maxChars||!/^[A-Za-z0-9_-]+$/.test(value))
  throw Error('Invalid checkpoint encoding');
 const bytes=Buffer.from(value,'base64url');
 if(bytes.toString('base64url')!==value)throw Error('Noncanonical checkpoint encoding');
 return bytes;
}
export function sealCheckpointTransfer({key,baseSha,jobId,revision,checkpointBytes}={}){
 const secret=keyBytes(key);validateContext(baseSha,jobId,revision);
 if(!(checkpointBytes instanceof Uint8Array)||checkpointBytes.byteLength===0||checkpointBytes.byteLength>MAX_BYTES)
  throw Error('Checkpoint size not allowed');
 const bytes=Buffer.from(checkpointBytes),digest=digestOf(bytes),nonce=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',secret,nonce,{authTagLength:16});
 cipher.setAAD(associatedData({baseSha,jobId,revision,digest}));
 const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
 return {schema:1,scope:SCOPE,authority:'none',releaseAuthorized:false,nextTaskDispatched:false,
  baseSha,jobId,revision,digest,
  nonce:nonce.toString('base64url'),ciphertext:encrypted.toString('base64url'),
  tag:cipher.getAuthTag().toString('base64url')};
}
export function openCheckpointTransfer(envelope,{key,baseSha,jobId,revision,expectedDigest}={}){
 const secret=keyBytes(key);validateContext(baseSha,jobId,revision);
 if(!SHA64.test(expectedDigest??'')||!envelope||typeof envelope!=='object'||Array.isArray(envelope)||
   Object.keys(envelope).sort().join(',')!==required||envelope.schema!==1||envelope.scope!==SCOPE||
   envelope.authority!=='none'||envelope.releaseAuthorized!==false||envelope.nextTaskDispatched!==false||
   envelope.baseSha!==baseSha||envelope.jobId!==jobId||envelope.revision!==revision||
   envelope.digest!==expectedDigest)throw Error('Checkpoint context mismatch');
 const nonce=read64(envelope.nonce,32),tag=read64(envelope.tag,32);
 const encrypted=read64(envelope.ciphertext,90000);
 if(nonce.length!==12||tag.length!==16||encrypted.length===0||encrypted.length>MAX_BYTES)
  throw Error('Invalid checkpoint ciphertext');
 let bytes;
 try{
  const decipher=createDecipheriv('aes-256-gcm',secret,nonce,{authTagLength:16});
  decipher.setAAD(associatedData({baseSha,jobId,revision,digest:expectedDigest}));
  decipher.setAuthTag(tag);
  bytes=Buffer.concat([decipher.update(encrypted),decipher.final()]);
 }catch{throw Error('Checkpoint authentication failed')}
 const calculated=Buffer.from(digestOf(bytes),'hex'),expected=Buffer.from(expectedDigest,'hex');
 if(bytes.length===0||bytes.length>MAX_BYTES||!timingSafeEqual(calculated,expected))
  throw Error('Checkpoint digest mismatch');
 return bytes;
}
