import assert from 'node:assert/strict';
import test from 'node:test';
import {criticalPath, deliveryProgress, observedTime, requirementProgress, remainingEstimate} from '../app/progress.mjs';

const duration = (id, minutes, dependencies = []) => ({id, dependencies,
  remainingMinutes: {optimistic: minutes, standard: minutes + 2, cautious: minutes + 4}});

test('critical path counts independent work once and preserves unknown external waiting', () => {
  const tasks = [duration('survey', 5), duration('build', 20), duration('verify', 6, ['survey', 'build'])];
  assert.deepEqual(criticalPath(tasks), {optimistic: 26, standard: 30, cautious: 34});
  assert.equal(criticalPath([...tasks, {...duration('human', 0, ['verify']), externalWait: 'unknown'}]), null);
  assert.equal(criticalPath([duration('cycle', 0, ['cycle'])]), null);
});

test('remaining estimates preserve zero and reject inverted, string or incomplete durations', () => {
  const zero = {optimistic: 0, standard: 0, cautious: 0};
  assert.deepEqual(remainingEstimate(zero), zero);
  assert.equal(remainingEstimate({optimistic: 10, standard: 5, cautious: 20}), null);
  assert.equal(remainingEstimate({optimistic: '5', standard: 10, cautious: 20}), null);
  assert.equal(remainingEstimate({standard: 10, cautious: 20}), null);
});

test('a completion label cannot zero the schedule unless the scoped requirements were accepted', () => {
  const task = {...duration('work', 10), status: 'verified'};
  assert.deepEqual(criticalPath([task]), task.remainingMinutes);
  assert.equal(criticalPath([{id: 'unproven', status: 'verified'}]), null);
  assert.equal(criticalPath([{id: 'unproven', status: 'verified',
    remainingMinutes: {optimistic: 0, standard: 0, cautious: 0}}]), null);
  assert.deepEqual(criticalPath([{...task, requirements: [{id: 'unmet'}]}]), task.remainingMinutes);
  const accepted = {id:'reviewed',implemented:true,review:{independent:true,status:'accepted'},
    validation:{status:'passed',source:'independent record'}};
  const zero = {optimistic:0,standard:0,cautious:0};
  assert.equal(criticalPath([{...task, requirements:[accepted], blocker:'Awaiting approval', remainingMinutes:zero}]),null);
  assert.equal(criticalPath([{id:'pending',status:'pending',remaining:['Production check'],remainingMinutes:zero}]),null);
  assert.equal(criticalPath([{id:'blocked',status:'blocked',remainingMinutes:zero}]),null);
});

test('a fixture run or an unimplemented requirement cannot shrink the formal denominator', () => {
  const accepted = {id: 'working', implemented: true, targetRuntimeRequired: true,
    review: {independent: true, status: 'accepted'}, validation: {status: 'passed', source: 'native run', runtime: 'target'},
    artifact: {usable: true}};
  const loose = {...accepted, id: 'mocked', validation: {...accepted.validation, runtime: 'fixture'}};
  assert.deepEqual(requirementProgress([accepted, loose, {id: 'missing'}]), {
    total: 3, accepted: 1, implementationCompletion: 66.7, formalCompletion: 33.3, verifiedCompletion: 33.3, usableCompletion: 33.3});
  assert.equal(requirementProgress([]), null);
  const almost = Array.from({length:1999},(_,index)=>({...accepted,id:'accepted-'+index}));
  almost.push({id:'outstanding'});
  assert.equal(requirementProgress(almost).formalCompletion,99.9);
  assert.equal(requirementProgress(almost).implementationCompletion,99.9);
  assert.equal(requirementProgress(almost).verifiedCompletion,99.9);
});

test('activity and wait times handle overlapping host and agent intervals separately', () => {
  const at = minute => new Date(Date.UTC(2026, 10, 27, 6, minute)).toISOString();
  assert.deepEqual(observedTime([
    {kind: 'active', agent: 'lead', start: at(0), end: at(15)},
    {kind: 'active', agent: 'worker', start: at(5), end: at(10)},
    {kind: 'waiting', start: at(10), end: at(20)},
  ]), {activeMinutes: 15, waitingMinutes: 5, agentMinutes: 20});
  const result = deliveryProgress({observationAt: at(5), estimates: [{dueAt: at(10)}, {dueAt: at(23)}],
    requirements: [{id: 'pending'}], tasks: [duration('build', 15)]}, new Date(at(6)));
  assert.equal(result.originalDueAt, at(10));
  assert.equal(result.estimateFinish, at(22));
  assert.equal(result.forecastDeltaMinutes, 12);
  assert.equal(result.delayed, true);
});
