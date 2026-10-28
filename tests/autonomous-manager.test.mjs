import test from 'node:test';
import assert from 'node:assert/strict';
import {decide,APPROVAL_ACTIONS} from '../scripts/autonomous-manager.mjs';
const base={id:'synthetic-1',goal:'Validate tests',acceptance:['CI passes'],retryCount:0,actions:['test']};
test('safe read-only task can be planned',()=>assert.equal(decide(base).status,'READY'));
test('cost and publication require human gate',()=>{assert.equal(decide({...base,actions:['publish']}).status,'AWAITING_APPROVAL');assert.equal(decide(base,{costYen:1}).status,'AWAITING_APPROVAL');});
test('bounded retries',()=>assert.equal(decide({...base,retryCount:3}).reason,'retry-limit'));
test('merge requires independent exact SHA',()=>{const task={...base,kind:'merge'};assert.equal(decide(task,{ciPassed:true,independentReviewVerified:true,reviewedSha:'a',headSha:'b'}).status,'AWAITING_APPROVAL');assert.equal(decide(task,{ciPassed:true,independentReviewVerified:true,reviewedSha:'a',headSha:'a',explicitApproval:true}).status,'AWAITING_APPROVAL');});

test('untrusted caller cannot grant security permission',()=>assert.equal(decide({...base,actions:['permissions']},{explicitApproval:true}).status,'AWAITING_APPROVAL'));

test('unknown or malformed action arrays fail closed without throwing',()=>{
 const invalid=[undefined,null,[], 'test',{},1,[null],[1],[{}],[''],[' '],['TEST'],[' test'],['unknown-write'],['test','unknown-write'],['publish','unknown-write'],Array(1),['test',,]];
 for(const actions of invalid) assert.deepEqual(decide({...base,actions}),{status:'BLOCKED',reason:'invalid-task'});
});
test('only documented test actions are ready; all existing approval actions remain gated',()=>{
 assert.deepEqual([...APPROVAL_ACTIONS],['spend','publish','delete','permissions','security-policy','architecture','goal-change','merge-main']);
 assert.equal(decide({...base,actions:['test','test']}).status,'READY');
 for(const action of APPROVAL_ACTIONS) for(const actions of [[action],['test',action]])
  assert.equal(decide({...base,actions},{explicitApproval:true,independentReviewVerified:true,ciPassed:true}).status,'AWAITING_APPROVAL');
});
test('merge gate and base validation retain precedence over action validation',()=>{
 for(const actions of [undefined,null,{},['unknown'],Array(1)])
  assert.equal(decide({...base,kind:'merge',actions}).status,'AWAITING_APPROVAL');
 assert.equal(decide({...base,id:null,kind:'merge',actions:undefined}).status,'BLOCKED');
});
