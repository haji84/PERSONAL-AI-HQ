// Deterministic lease contract for a future transactional store.
// This module does not implement cross-run persistence by itself.
const validHolder=value=>typeof value==='string'&&value.trim().length>0;
const validEpoch=value=>Number.isSafeInteger(value)&&value>0;
const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
function validateLease(lease){
 if(!lease||typeof lease!=='object'||Array.isArray(lease)||!validHolder(lease.holder)||!validEpoch(lease.epoch)||!validTime(lease.expiresAt)||lease.expiresAt===0)throw Error('Invalid stored lease');
}
function expiry(now,ttlMs){
 if(!validTime(now)||!Number.isFinite(ttlMs)||ttlMs<=0||ttlMs>300000)throw Error('Invalid lease time');
 const expiresAt=now+ttlMs;
 if(!validTime(expiresAt)||expiresAt<=now)throw Error('Invalid lease expiry');
 return expiresAt;
}
export function acquireLease(current,{holder,now,ttlMs,expectedEpoch}){
 if(!validHolder(holder)||expectedEpoch!==undefined&&!validEpoch(expectedEpoch))throw Error('Invalid lease request');
 // No stored lease means no epoch comparison; preserve valid initial-call compatibility.
 const expiresAt=expiry(now,ttlMs);
 if(current!==null&&current!==undefined){
  validateLease(current);
  if(!validEpoch(expectedEpoch)||current.epoch!==expectedEpoch)throw Error('Stale lease epoch');
  if(current.expiresAt>now)throw Error('Lease already active');
  if(current.epoch===Number.MAX_SAFE_INTEGER)throw Error('Lease epoch exhausted');
 }
 return {holder,epoch:(current?.epoch??0)+1,expiresAt};
}
export function assertLease(lease,{holder,epoch,now}){
 validateLease(lease);
 if(!validHolder(holder)||!validEpoch(epoch)||!validTime(now)||lease.holder!==holder||lease.epoch!==epoch||lease.expiresAt<=now)throw Error('Lease not valid');
 return true;
}
export function renewLease(lease,{holder,epoch,now,ttlMs}){
 assertLease(lease,{holder,epoch,now});
 return {...lease,expiresAt:expiry(now,ttlMs)};
}
