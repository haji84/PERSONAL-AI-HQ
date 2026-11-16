import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireLease,assertLease,renewLease} from '../scripts/state-lease.mjs';
test('active lease rejects second worker',()=>{const a=acquireLease(null,{holder:'worker-a',now:100,ttlMs:1000});assert.throws(()=>acquireLease(a,{holder:'worker-b',now:200,ttlMs:1000,expectedEpoch:1}));});
test('expired lease rotates epoch and rejects stale holder',()=>{const a=acquireLease(null,{holder:'a',now:100,ttlMs:100});const b=acquireLease(a,{holder:'b',now:201,ttlMs:100,expectedEpoch:1});assert.equal(b.epoch,2);assert.throws(()=>assertLease(b,{holder:'a',epoch:1,now:202}));});
test('renewal requires current holder and epoch',()=>{const a=acquireLease(null,{holder:'a',now:100,ttlMs:100});assert.equal(renewLease(a,{holder:'a',epoch:1,now:150,ttlMs:100}).expiresAt,250);assert.throws(()=>renewLease(a,{holder:'b',epoch:1,now:150,ttlMs:100}));});

const validLease=()=>({holder:'worker-a',epoch:1,expiresAt:200});
const validRequest=()=>({holder:'worker-a',epoch:1,now:150});
const invalidHolders=[undefined,null,'','   ',0,{},[]];
const invalidEpochs=[undefined,null,0,-1,1.5,'1',NaN,Infinity,Number.MAX_SAFE_INTEGER+1];
const invalidTimes=[undefined,null,-1,'150',NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1];
for(const holder of invalidHolders){
 test(`rejects invalid holder ${String(holder)}`,()=>{
  assert.throws(()=>acquireLease(null,{holder,now:100,ttlMs:100}));
  assert.throws(()=>assertLease({...validLease(),holder},{...validRequest(),holder}));
  assert.throws(()=>renewLease({...validLease(),holder},{...validRequest(),holder,ttlMs:100}));
 });
}
for(const epoch of invalidEpochs){
 test(`rejects invalid epoch ${String(epoch)}`,()=>{
  assert.throws(()=>assertLease({...validLease(),epoch},{...validRequest(),epoch}));
  assert.throws(()=>renewLease({...validLease(),epoch},{...validRequest(),epoch,ttlMs:100}));
  assert.throws(()=>acquireLease({...validLease(),epoch},{holder:'worker-b',now:201,ttlMs:100,expectedEpoch:epoch}));
 });
}
for(const now of invalidTimes){
 test(`rejects invalid time ${String(now)}`,()=>{
  assert.throws(()=>acquireLease(null,{holder:'worker-a',now,ttlMs:100}));
  assert.throws(()=>assertLease(validLease(),{...validRequest(),now}));
  assert.throws(()=>renewLease(validLease(),{...validRequest(),now,ttlMs:100}));
 });
}
for(const expiresAt of [undefined,null,0,-1,'200',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
 test(`rejects malformed stored expiry ${String(expiresAt)}`,()=>{
  const lease={...validLease(),expiresAt};
  assert.throws(()=>assertLease(lease,validRequest()));
  assert.throws(()=>renewLease(lease,{...validRequest(),ttlMs:100}));
  assert.throws(()=>acquireLease(lease,{holder:'worker-b',now:201,ttlMs:100,expectedEpoch:1}));
 });
}
for(const current of [false,0,'',[],{}]){
 test(`rejects malformed lease object ${JSON.stringify(current)}`,()=>{
  assert.throws(()=>acquireLease(current,{holder:'worker-a',now:100,ttlMs:100}));
  assert.throws(()=>assertLease(current,{}));
 });
}
test('missing holder and epoch cannot match each other',()=>assert.throws(()=>assertLease({expiresAt:200},{now:100})));
test('TTL boundaries and rounded arithmetic fail closed',()=>{
 for(const ttlMs of [undefined,null,0,-1,'100',NaN,Infinity,300001,Number.MIN_VALUE]){
  assert.throws(()=>acquireLease(null,{holder:'worker-a',now:100,ttlMs}));
  assert.throws(()=>renewLease(validLease(),{...validRequest(),ttlMs}));
 }
 assert.throws(()=>acquireLease(null,{holder:'worker-a',now:Number.MAX_SAFE_INTEGER,ttlMs:1}));
});
test('epoch exhaustion rejects acquisition but permits assertion and renewal',()=>{
 const lease={...validLease(),epoch:Number.MAX_SAFE_INTEGER};
 assert.equal(assertLease(lease,{...validRequest(),epoch:lease.epoch}),true);
 assert.equal(renewLease(lease,{...validRequest(),epoch:lease.epoch,ttlMs:100}).epoch,lease.epoch);
 assert.throws(()=>acquireLease(lease,{holder:'worker-b',expectedEpoch:lease.epoch,now:200,ttlMs:100}));
});
test('valid expiry boundary, maximum TTL and omitted current remain supported',()=>{
 assert.deepEqual(acquireLease(undefined,{holder:'worker-a',now:0,ttlMs:300000}),{holder:'worker-a',epoch:1,expiresAt:300000});
 const current=validLease();
 assert.throws(()=>assertLease(current,{...validRequest(),now:200}));
 assert.deepEqual(acquireLease(current,{holder:'worker-b',expectedEpoch:1,now:200,ttlMs:100}),{holder:'worker-b',epoch:2,expiresAt:300});
 assert.deepEqual(current,validLease());
 const renewed=renewLease(current,{...validRequest(),ttlMs:100});
 assert.equal(renewed.expiresAt,250);
 assert.deepEqual(current,validLease());
});

test('initial acquisition validates a supplied epoch without inventing a zero sentinel',()=>{
 for(const current of [null,undefined]){
  for(const expectedEpoch of invalidEpochs.filter(value=>value!==undefined)){
   assert.throws(()=>acquireLease(current,{holder:'worker-a',now:100,ttlMs:100,expectedEpoch}));
  }
  // Legacy initial creation has no epoch to compare: valid supplied epochs stay ignored.
  for(const expectedEpoch of [undefined,1,Number.MAX_SAFE_INTEGER]){
   assert.equal(acquireLease(current,{holder:'worker-a',now:100,ttlMs:100,expectedEpoch}).epoch,1);
  }
 }
});
test('stored lease requires matching expected epoch and valid renewal boundaries',()=>{
 for(const expectedEpoch of [undefined,2])assert.throws(()=>acquireLease(validLease(),{holder:'worker-b',now:200,ttlMs:100,expectedEpoch}));
 assert.throws(()=>renewLease(validLease(),{...validRequest(),now:200,ttlMs:100}));
 assert.equal(renewLease(validLease(),{...validRequest(),ttlMs:300000}).expiresAt,300150);
});
