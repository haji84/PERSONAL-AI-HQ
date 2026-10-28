import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireLease,assertLease,renewLease} from '../scripts/state-lease.mjs';
test('active lease rejects second worker',()=>{const a=acquireLease(null,{holder:'worker-a',now:100,ttlMs:1000});assert.throws(()=>acquireLease(a,{holder:'worker-b',now:200,ttlMs:1000,expectedEpoch:1}));});
test('expired lease rotates epoch and rejects stale holder',()=>{const a=acquireLease(null,{holder:'a',now:100,ttlMs:100});const b=acquireLease(a,{holder:'b',now:201,ttlMs:100,expectedEpoch:1});assert.equal(b.epoch,2);assert.throws(()=>assertLease(b,{holder:'a',epoch:1,now:202}));});
test('renewal requires current holder and epoch',()=>{const a=acquireLease(null,{holder:'a',now:100,ttlMs:100});assert.equal(renewLease(a,{holder:'a',epoch:1,now:150,ttlMs:100}).expiresAt,250);assert.throws(()=>renewLease(a,{holder:'b',epoch:1,now:150,ttlMs:100}));});
