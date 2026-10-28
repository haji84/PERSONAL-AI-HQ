import test from 'node:test';
import assert from 'node:assert/strict';
import {decide} from '../scripts/autonomous-manager.mjs';
const base={id:'synthetic-1',goal:'Validate tests',acceptance:['CI passes'],retryCount:0,actions:['test']};
test('safe read-only task can be planned',()=>assert.equal(decide(base).status,'READY'));
test('cost and publication require human gate',()=>{assert.equal(decide({...base,actions:['publish']}).status,'AWAITING_APPROVAL');assert.equal(decide(base,{costYen:1}).status,'AWAITING_APPROVAL');});
test('bounded retries',()=>assert.equal(decide({...base,retryCount:3}).reason,'retry-limit'));
test('merge requires independent exact SHA',()=>{const task={...base,kind:'merge'};assert.equal(decide(task,{ciPassed:true,independentReviewVerified:true,reviewedSha:'a',headSha:'b'}).status,'BLOCKED');assert.equal(decide(task,{ciPassed:true,independentReviewVerified:true,reviewedSha:'a',headSha:'a'}).status,'READY');});
