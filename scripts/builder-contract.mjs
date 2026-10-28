// Model-neutral coding proposal contract. No network or repository write authority.
import {createHash} from 'node:crypto';
export function validateProposal(p,{expectedBaseSha,allowedPaths=[]}={}){
 if(!p||p.schema!==1||p.baseSha!==expectedBaseSha||!Array.isArray(p.changes)||p.changes.length<1||p.changes.length>10)throw Error('Invalid builder proposal');
 const seen=new Set();
 for(const c of p.changes){
  if(typeof c.path!=='string'||!allowedPaths.includes(c.path)||seen.has(c.path))throw Error('Disallowed or duplicate path');
  if(typeof c.content!=='string'||c.content.length>20000)throw Error('Invalid change content');
  seen.add(c.path);
 }
 return {baseSha:p.baseSha,changeCount:p.changes.length,digest:createHash('sha256').update(JSON.stringify(p.changes)).digest('hex'),changes:p.changes};
}
export function parseBuilderResponse(raw,options){
 if(typeof raw!=='string'||raw.length>100000)throw Error('Invalid model response');
 let proposal;try{proposal=JSON.parse(raw)}catch{throw Error('Builder must return JSON only')}
 return validateProposal(proposal,options);
}
export function chooseProvider(candidates,{budgetYen=0,privacy='public'}={}){
 const eligible=candidates.filter(c=>c.available===true&&c.verifiedZeroCharge===true&&c.privacyAllowed?.includes(privacy)&&c.capabilities?.includes('code-edit')&&c.estimatedCostYen===0);
 if(budgetYen!==0||eligible.length===0)return {status:'BLOCKED',reason:'no-verified-zero-cost-builder'};
 return {status:'READY',provider:eligible[0].id};
}
