import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRetestDiagnostic} from '../scripts/retest-diagnostic.mjs';
const unknown=present=>({retestPresent:present,retestStatus:'UNKNOWN',caseCount:null});
test('absence is not converted to an observed zero',()=>{
 for(const input of [undefined,null,0,'x',[],{},Object.create({retest:{status:'PASS',caseCount:6}})])assert.deepEqual(projectRetestDiagnostic(input),unknown(false));
});
test('reported statuses stay distinct without fabricating executed case counts',()=>{
 for(const status of ['ASSERTION_FAILURE','SAFETY_REJECTED'])assert.deepEqual(projectRetestDiagnostic({retest:{status}}),{retestPresent:true,retestStatus:status,caseCount:null});
 assert.deepEqual(projectRetestDiagnostic({retest:{status:'PASS',caseCount:6}}),{retestPresent:true,retestStatus:'PASS',caseCount:6});
});
test('count and status are independent reports, not an acceptance decision',()=>{
 for(const caseCount of [0,1,6])assert.deepEqual(projectRetestDiagnostic({retest:{status:'UNKNOWN_INPUT',caseCount}}),{retestPresent:true,retestStatus:'UNKNOWN',caseCount});
 assert.deepEqual(projectRetestDiagnostic({retest:{status:'PASS'}}),{retestPresent:true,retestStatus:'PASS',caseCount:null});
 for(const caseCount of [undefined,null,-1,7,1.5,NaN,Infinity,'6',true,[],{},Number.MAX_SAFE_INTEGER])assert.equal(projectRetestDiagnostic({retest:{caseCount}}).caseCount,null);
});
test('presence survives malformed and accessor retest values without invoking getters',()=>{
 for(const retest of [undefined,null,false,3,'private-sentinel',[],()=>{}])assert.deepEqual(projectRetestDiagnostic({retest}),unknown(true));
 let calls=0;const input=Object.defineProperty({},'retest',{get(){calls++;throw Error('private-sentinel')}});
 assert.deepEqual(projectRetestDiagnostic(input),unknown(true));assert.equal(calls,0);
});
test('only own data status and count are considered',()=>{
 let calls=0;const inherited=Object.create({status:'PASS',caseCount:6});assert.deepEqual(projectRetestDiagnostic({retest:inherited}),unknown(true));
 const retest={};for(const key of ['status','caseCount','failure','error','source','secret'])Object.defineProperty(retest,key,{get(){calls++;throw Error('private-sentinel')}});
 assert.deepEqual(projectRetestDiagnostic({retest}),unknown(true));assert.equal(calls,0);
});
test('reflection exceptions do not erase already observed presence',()=>{
 const throws=new Proxy({},{getOwnPropertyDescriptor(){throw Error('private-sentinel')}});
 assert.deepEqual(projectRetestDiagnostic(throws),unknown(false));assert.deepEqual(projectRetestDiagnostic({retest:throws}),unknown(true));
 const {proxy,revoke}=Proxy.revocable({},{});revoke();assert.deepEqual(projectRetestDiagnostic(proxy),unknown(false));assert.deepEqual(projectRetestDiagnostic({retest:proxy}),unknown(true));
 const partial=new Proxy({status:'PASS'},{getOwnPropertyDescriptor(target,key){if(key==='caseCount')throw Error('private-sentinel');return Reflect.getOwnPropertyDescriptor(target,key)}});
 assert.deepEqual(projectRetestDiagnostic({retest:partial}),{retestPresent:true,retestStatus:'PASS',caseCount:null});
});
test('fixed frozen output contains no private values and inputs remain unchanged',()=>{
 const retest=Object.freeze({status:'private-sentinel',caseCount:'private-sentinel',failure:'private-sentinel',source:'private-sentinel'}),input=Object.freeze({retest});
 const result=projectRetestDiagnostic(input);assert.deepEqual(result,unknown(true));assert.equal(Object.isFrozen(result),true);assert.deepEqual(Object.keys(result),['retestPresent','retestStatus','caseCount']);assert.equal(JSON.stringify(result).includes('private-sentinel'),false);assert.equal(input.retest,retest);
});

test('status accepts only exact enums without coercion',()=>{
 let calls=0;const coercible={toString(){calls++;return 'PASS'}};
 for(const status of ['pass',' PASS','PASS ',['PASS'],coercible,1,null])assert.deepEqual(projectRetestDiagnostic({retest:{status,caseCount:6}}),{retestPresent:true,retestStatus:'UNKNOWN',caseCount:6});
 assert.equal(calls,0);
 const retest=Object.defineProperty({caseCount:6},'status',{get(){calls++;throw Error('private-sentinel')}});
 assert.deepEqual(projectRetestDiagnostic({retest}),{retestPresent:true,retestStatus:'UNKNOWN',caseCount:6});assert.equal(calls,0);
});
