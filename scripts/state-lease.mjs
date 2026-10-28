// Deterministic lease contract for a future transactional store.
// This module does not implement cross-run persistence by itself.
export function acquireLease(current,{holder,now,ttlMs,expectedEpoch}){
 if(!holder||!Number.isFinite(now)||!Number.isFinite(ttlMs)||ttlMs<=0||ttlMs>300000)throw Error('Invalid lease request');
 if(current&&current.epoch!==expectedEpoch)throw Error('Stale lease epoch');
 if(current&&current.expiresAt>now)throw Error('Lease already active');
 return {holder,epoch:(current?.epoch??0)+1,expiresAt:now+ttlMs};
}
export function assertLease(lease,{holder,epoch,now}){
 if(!lease||lease.holder!==holder||lease.epoch!==epoch||lease.expiresAt<=now)throw Error('Lease not valid');
 return true;
}
export function renewLease(lease,{holder,epoch,now,ttlMs}){
 assertLease(lease,{holder,epoch,now});
 if(!Number.isFinite(ttlMs)||ttlMs<=0||ttlMs>300000)throw Error('Invalid renewal');
 return {...lease,expiresAt:now+ttlMs};
}
