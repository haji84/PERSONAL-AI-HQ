import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireLease,assertLease,renewLease} from '../scripts/state-lease.mjs';

const base=()=>acquireLease(null,{holder:'run-A/attempt-1',now:1000,ttlMs:1000});
test('a different run cannot commit using the first run lease',()=>{
 const lease=base();
 assert.throws(()=>assertLease(lease,{holder:'run-B/attempt-1',epoch:1,now:1500}),/Lease not valid/);
 assert.equal(assertLease(lease,{holder:'run-A/attempt-1',epoch:1,now:1500}),true);
});
test('lease expires at the exact expiry boundary and cannot be renewed',()=>{
 const lease=base();
 assert.throws(()=>assertLease(lease,{holder:lease.holder,epoch:1,now:2000}),/Lease not valid/);
 assert.throws(()=>renewLease(lease,{holder:lease.holder,epoch:1,now:2000,ttlMs:1000}),/Lease not valid/);
});
test('fencing: reclaimed epoch rejects stale A even if A retains old lease',()=>{
 const old=base();
 const fresh=acquireLease(old,{holder:'run-B/attempt-1',expectedEpoch:1,now:2000,ttlMs:1000});
 assert.equal(fresh.epoch,2);
 assert.throws(()=>assertLease(fresh,{holder:old.holder,epoch:old.epoch,now:2001}),/Lease not valid/);
 assert.throws(()=>acquireLease(fresh,{holder:'run-C',expectedEpoch:1,now:3000,ttlMs:1000}),/Stale lease epoch/);
});
test('active lease prevents a competing claim',()=>{
 const lease=base();
 assert.throws(()=>acquireLease(lease,{holder:'run-B',expectedEpoch:1,now:1999,ttlMs:1000}),/Lease already active/);
});
test('invalid clock, TTL, epoch and corrupted stored lease fail closed',()=>{
 for(const now of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER])
  assert.throws(()=>acquireLease(null,{holder:'A',now,ttlMs:300000}));
 for(const ttlMs of [0,-1,300001,NaN,Infinity])
  assert.throws(()=>acquireLease(null,{holder:'A',now:1000,ttlMs}));
 assert.throws(()=>acquireLease({...base(),epoch:0},{holder:'B',expectedEpoch:1,now:2000,ttlMs:1000}));
 assert.throws(()=>acquireLease({...base(),epoch:Number.MAX_SAFE_INTEGER},{holder:'B',expectedEpoch:Number.MAX_SAFE_INTEGER,now:2000,ttlMs:1000}),/exhausted/);
});
test('lease identity must be supplied by trusted verifier: caller input alone is not authentication',()=>{
 const lease=base();
 assert.equal(lease.holder,'run-A/attempt-1');
 // This module intentionally has no JWT verification. A caller can assert the same holder.
 assert.equal(assertLease(lease,{holder:'run-A/attempt-1',epoch:1,now:1500}),true);
});
