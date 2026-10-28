#!/usr/bin/env node
// Read-only autonomous planning prototype. Does not invoke Codex or write GitHub.
import {readFileSync} from 'node:fs';
export const APPROVAL_ACTIONS=new Set(['spend','publish','delete','permissions','security-policy','architecture','goal-change','merge-main']);
export function decide(task,context={}){
 if(!task||typeof task.id!=='string'||!task.goal||!Array.isArray(task.acceptance)) return {status:'BLOCKED',reason:'invalid-task'};
 if(task.actions?.some(a=>APPROVAL_ACTIONS.has(a))&&!context.explicitApproval) return {status:'AWAITING_APPROVAL',reason:'human-gate'};
 if(context.costYen>0) return {status:'AWAITING_APPROVAL',reason:'nonzero-cost'};
 if(task.retryCount>=3) return {status:'BLOCKED',reason:'retry-limit'};
 if(task.kind==='merge'&&(!context.ciPassed||!context.independentReviewVerified||context.reviewedSha!==context.headSha)) return {status:'BLOCKED',reason:'merge-gate'};
 return {status:'READY',reason:'authorized-scope'};
}
if(process.argv[1]?.endsWith('/autonomous-manager.mjs')){
 const task=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const decision=decide(task);
 process.stdout.write(JSON.stringify({taskId:task.id,...decision})+'\n');
 if(decision.status!=='READY') process.exitCode=2;
}
