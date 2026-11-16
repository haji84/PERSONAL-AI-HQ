// Local-only cryptographic transfer of an integrity-validated synthetic review checkpoint.
// This provides NO remote authentication, storage authorization, workflow dispatch or merge right.
import {openSync,closeSync,readFileSync,writeFileSync,fsyncSync,fstatSync,unlinkSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadReviewCheckpoint} from './review-checkpoint.mjs';
import {sealCheckpointTransfer,openCheckpointTransfer} from './checkpoint-transfer.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function verifiedSourceBytes(file,{baseSha,expectedDigest}){
 const value=loadReviewCheckpoint(file,{baseSha,expectedDigest});
 if(value.authority!=='none'||value.scope!=='local-synthetic-review-only')
  throw Error('Review source lacks synthetic-only scope');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=fstatSync(fd);
  if(!info.isFile()||info.size<=0||info.size>65536)throw Error('Unsafe review checkpoint size');
  const bytes=readFileSync(fd);
  if(hash(bytes)!==expectedDigest)throw Error('Review checkpoint changed');
  return bytes;
 }finally{closeSync(fd)}
}
export function sealVerifiedReview({file,key,baseSha,jobId,revision,expectedDigest}={}){
 const checkpointBytes=verifiedSourceBytes(file,{baseSha,expectedDigest});
 return sealCheckpointTransfer({key,baseSha,jobId,revision,checkpointBytes});
}
export function restoreVerifiedReview({envelope,destination,key,baseSha,jobId,revision,expectedDigest}={}){
 const checkpointBytes=openCheckpointTransfer(envelope,{key,baseSha,jobId,revision,expectedDigest});
 // Exclusive destination prevents rollback or overwriting existing checkpoints.
 const fd=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,checkpointBytes);fsyncSync(fd)}finally{closeSync(fd)}
 try{
  const data=loadReviewCheckpoint(destination,{baseSha,expectedDigest});
  return {checkpointVerified:true,sourceSha256:data.review.sourceSha256,
   status:data.review.status,modelExecuted:data.review.modelExecuted,authority:'none'};
 }catch(e){
  unlinkSync(destination);
  throw e;
 }
}
