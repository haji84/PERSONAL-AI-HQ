import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBuilderResponse,chooseProvider} from '../scripts/builder-contract.mjs';
const base='abc123',allowedPaths=['src/synthetic.mjs'];
const valid=JSON.stringify({schema:1,baseSha:base,changes:[{path:allowedPaths[0],content:'export const ok = true;'}]});
test('accepts scoped synthetic proposal',()=>assert.equal(parseBuilderResponse(valid,{expectedBaseSha:base,allowedPaths}).changeCount,1));
test('rejects unapproved path, duplicate, wrong base',()=>{for(const p of [{schema:1,baseSha:base,changes:[{path:'../secret',content:'x'}]},{schema:1,baseSha:'wrong',changes:[{path:allowedPaths[0],content:'x'}]},{schema:1,baseSha:base,changes:[{path:allowedPaths[0],content:'x'},{path:allowedPaths[0],content:'y'}]}])assert.throws(()=>parseBuilderResponse(JSON.stringify(p),{expectedBaseSha:base,allowedPaths}));});
test('no model selected without verified zero-charge eligibility',()=>{assert.equal(chooseProvider([{id:'gemini',available:true,verifiedZeroCharge:false,privacyAllowed:['public'],capabilities:['code-edit'],estimatedCostYen:0}]).status,'BLOCKED');assert.equal(chooseProvider([{id:'local',available:true,verifiedZeroCharge:true,privacyAllowed:['public'],capabilities:['code-edit'],estimatedCostYen:0}]).provider,'local');});
