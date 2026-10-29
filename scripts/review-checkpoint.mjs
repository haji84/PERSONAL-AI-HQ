// Integrity-bound local checkpoint, NOT an authentication or approval authority.
// Caller chooses the local path. No network, model invocation, execution or remote writes.
import {openSync,closeSync,readFileSync,writeFileSync,fstatSync,fsyncSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const SHA=/^[a-f0-9]{64}$/,HEAD=/^[a-f0-9]{40}$/;
const digest=value=>typeof value==='string'&&SHA.test(value);
const fields=new Set(['status','authority','advisoryOnly','modelExecuted','baseSha','sourceSha256',
 'promptSourceSha256','canonicalSourceSha256','testsSha256','testCaseCount','witnessValid','advisoryAgrees',
 'reviewerModelSha256','reviewerResponseSha256','requestSha256','promptSha256','failedStage','reviewReceiptSha256']);
const stages=new Set(['review-process','format','witness','preflight','model-artifact','source-check','process','integrity']);
function validate({baseSha,source,review}){
 if(typeof baseSha!=='string'||!HEAD.test(baseSha)||typeof source!=='string'||Buffer.byteLength(source)>2048||
    !/^[a-zA-Z0-9_(),:+*\- \t\r\n]+$/.test(source)||!review||Array.isArray(review)||
    Object.keys(review).some(k=>!fields.has(k)))throw Error('Invalid checkpoint payload');
 if(review.baseSha!==baseSha||review.sourceSha256!==hash(source)||review.promptSourceSha256!==hash(source)||
    review.authority!=='none'||review.advisoryOnly!==true||review.testCaseCount!==6||
    !['ADVISORY_AGREEMENT','INCONCLUSIVE','FAILED'].includes(review.status)||
    !['modelExecuted','witnessValid','advisoryAgrees'].every(k=>typeof review[k]==='boolean'))
  throw Error('Checkpoint source or review mismatch');
 // Hashes bind bytes, not the logical consistency or origin of a review.
 if(review.status==='ADVISORY_AGREEMENT'&&(!review.witnessValid||!review.advisoryAgrees)||
    review.status!=='ADVISORY_AGREEMENT'&&review.advisoryAgrees)
  throw Error('Inconsistent checkpoint review status');
 if((review.status==='FAILED')!==Object.hasOwn(review,'failedStage'))
  throw Error('Inconsistent checkpoint failure stage');
 if('requestSha256' in review&&review.requestSha256!==hash(JSON.stringify({baseSha,source})))
  throw Error('Checkpoint request source mismatch');
 for(const k of ['canonicalSourceSha256','testsSha256','reviewReceiptSha256'])
  if(!digest(review[k]))throw Error('Missing checkpoint digest');
 for(const k of ['reviewerModelSha256','reviewerResponseSha256','requestSha256','promptSha256'])
  if(k in review&&!digest(review[k]))throw Error('Invalid checkpoint digest');
 if(review.modelExecuted&&(!digest(review.reviewerModelSha256)||!digest(review.reviewerResponseSha256)))
  throw Error('Observed model identity missing');
 if('failedStage' in review&&!stages.has(review.failedStage))throw Error('Invalid failure stage');
 const {reviewReceiptSha256,...body}=review;
 if(hash(JSON.stringify(body))!==reviewReceiptSha256)throw Error('Review receipt digest mismatch');
 return {schema:1,baseSha,source,review,authority:'none',scope:'local-synthetic-review-only'};
}
export function saveReviewCheckpoint(file,input){
 const value=validate(input),text=JSON.stringify(value);
 const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,text);fsyncSync(fd)}finally{closeSync(fd)}
 return {sha256:hash(text),authority:'none'};
}
export function loadReviewCheckpoint(file,{baseSha,expectedDigest}={}){
 if(typeof baseSha!=='string'||!HEAD.test(baseSha)||!digest(expectedDigest))throw Error('Expected checkpoint identity required');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bytes;
 try{const st=fstatSync(fd);if(!st.isFile()||st.size>65536)throw Error('Unsafe checkpoint file');bytes=readFileSync(fd)}
 finally{closeSync(fd)}
 if(hash(bytes)!==expectedDigest)throw Error('Checkpoint content digest mismatch');
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(!value||Object.keys(value).sort().join(',')!=='authority,baseSha,review,schema,scope,source'||
    value.schema!==1||value.baseSha!==baseSha||value.authority!=='none'||value.scope!=='local-synthetic-review-only')
  throw Error('Checkpoint context mismatch');
 return validate(value);
}
