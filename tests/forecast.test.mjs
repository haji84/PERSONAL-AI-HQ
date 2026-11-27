import assert from 'node:assert/strict';
import test from 'node:test';
import * as progress from '../app/progress.mjs';

const forecast = (delivery, options) => progress.developmentForecast(delivery, options);
const now = Date.parse('2026-11-28T02:45:00+09:00');
const asOf = new Date(now).toISOString();
const range = minutes => ({optimistic:minutes, standard:minutes, cautious:minutes});
const task = (id, minutes, inputs = {}) => ({id, title:id, status:'pending',
  remainingMinutes:range(minutes), estimate:{basis:'同じ対象の実績',confidence:'medium',assumptions:['同じ環境']}, ...inputs});

test('bounded concurrency separates total work, dependency critical path and elapsed time', () => {
  const source = {observationAt:asOf, scopeComplete:true, capacity:{parallelism:2, calendar:'continuous'},
    tasks:[task('read',10),task('build',20),task('verify',5,{dependencies:['read','build']})],
    firstUsableTaskIds:['build']};
  const view=forecast(source, {now});
  assert.deepEqual(view.schedule.workMinutes,range(35));
  assert.deepEqual(view.schedule.criticalPathMinutes,range(25));
  assert.deepEqual(view.schedule.elapsedMinutes,range(25));
  assert.equal(view.schedule.completionDates.standard,'2026-11-28T03:10:00.000+09:00');
  assert.equal(view.schedule.firstUsableDates.standard,'2026-11-28T03:05:00.000+09:00');
  assert.deepEqual(view.schedule.readyTaskIds,['read','build']);
  const serial=forecast({...source,capacity:{parallelism:1,calendar:'continuous'}},{now});
  assert.deepEqual(serial.schedule.elapsedMinutes,range(35));
});

test('unknown waits and pauses preserve conditional effort and prevent a false date', () => {
  const source={observationAt:asOf,scopeComplete:true,capacity:{parallelism:2,calendar:'continuous'},
    tasks:[task('code',15),task('accept',5,{status:'waiting',externalWait:'unknown',dependencies:['code'],
      blocker:'本人のサインイン待ち',resolution:'サインイン後に画面を照合'}),task('next',10,{dependencies:['accept']})],
    firstUsableTaskIds:['code']};
  const active=forecast(source,{now});
  assert.deepEqual(active.schedule.workMinutes,range(30));
  assert.equal(active.schedule.completionDates,null);
  assert.equal(active.schedule.firstUsableDates.standard,'2026-11-28T03:00:00.000+09:00');
  assert.ok(active.gaps.some(x=>x.code==='external-wait'&&x.taskIds.includes('accept')&&x.action.includes('サインイン')));
  assert.equal(active.nextUpdate.trigger,'work-or-observation-change');
  const stopped=forecast(source,{now,status:'paused'});
  assert.deepEqual(stopped.schedule.readyTaskIds,[]);
  assert.equal(stopped.schedule.firstUsableDates,null);
  assert.equal(stopped.nextUpdate.at,null);
});

test('verified lifecycle evidence closes only its scoped task and leaves requirement rates intact', () => {
  const source={observationAt:asOf,scopeComplete:true,capacity:{parallelism:1,calendar:'continuous'},
    requirements:[{id:'whole-feature'}],
    tasks:[{id:'tool-check',status:'verified'},task('accept',8,{dependencies:['tool-check']})]};
  const report=forecast(source,{now,verifiedTaskIds:new Set(['tool-check'])});
  assert.equal(report.progress.formalCompletion,0);
  assert.deepEqual(report.schedule.workMinutes,range(8));
  assert.deepEqual(report.schedule.readyTaskIds,['accept']);
  assert.equal(forecast(source,{now}).schedule.workMinutes,null);
});

test('scales evidence of comparable work and keeps an unknown original estimate explicit', () => {
  const delivery={observationAt:asOf,scopeComplete:true,capacity:{parallelism:1,calendar:'continuous'},startedAt:'2026-11-28T02:00:00+09:00',
    comparableRuns:[{kind:'readback',minutes:5,units:1,source:'audited readback'},{kind:'unrelated',minutes:50,units:1,source:'other'}],
    estimates:[{recordedAt:asOf,kind:'retrospective',minutes:range(15),reason:'見積もりを復元'}],
    tasks:[{id:'survey',status:'pending',kind:'readback',units:2}]};
  const report=forecast(delivery,{now});
  assert.equal(report.tasks[0].remainingMinutes.standard,10);
  assert.equal(report.tasks[0].estimate.confidence,'low');
  assert.equal(report.baseline.kind,'retrospective');
  assert.equal(report.baseline.original,null);
  assert.equal(report.schedule.completionDates.standard,'2026-11-28T02:55:00.000+09:00');
});

test('stale assumptions and absent scope return recovery instructions without rolling a due date', () => {
  const source={observationAt:asOf,capacity:{calendar:'continuous'},
    tasks:[task('old',5,{status:'active',observedAt:'2026-11-28T02:00:00+09:00'}),{id:'unplanned',status:'pending'}],
    investigationMinutes:range(4)};
  const view=forecast(source,{now});
  assert.equal(view.schedule.completionDates,null);
  assert.equal(view.schedule.workMinutes,null);
  assert.deepEqual(view.schedule.recordedWorkMinutes,null);
  for (const code of ['scope','estimate-expired','task-estimate']) {
    assert.ok(view.gaps.some(gap=>gap.code===code&&gap.reason&&gap.action));
  }
  assert.deepEqual(view.gaps.find(gap=>gap.code==='task-estimate').investigationMinutes,range(4));
  assert.ok(view.nextUpdate.at);
});

test('uses JST working days and attributes delay to observed scope changes and repeated obstacles', () => {
  const source={observationAt:asOf,scopeComplete:true,capacity:{parallelism:1,
    calendar:{weekdays:[1,2,3,4,5],startHourJst:9,minutesPerDay:480}},
    estimates:[{kind:'original',recordedAt:'2026-11-28T00:00:00+09:00',dueAt:'2026-11-30T09:00:00+09:00'}],
    tasks:[task('code',15)], events:[
      {id:'cause1',kind:'blocked',at:'2026-11-28T01:01:00+09:00',taskId:'code',causeKey:'missing-input'},
      {id:'cause2',kind:'blocked',at:'2026-11-28T02:01:00+09:00',taskId:'code',causeKey:'missing-input'},
      {id:'scope1',kind:'scope-change',at:'2026-11-28T02:02:00+09:00',reason:'追加要求'},
    ]};
  const report=forecast(source,{now});
  assert.equal(report.schedule.completionDates.standard,'2026-11-30T09:15:00.000+09:00');
  assert.equal(report.schedule.forecastDeltaMinutes,15);
  assert.ok(report.diagnostics.some(x=>x.code==='scope-change'));
  assert.ok(report.diagnostics.some(x=>x.code==='recurring-obstacle'&&x.action));
  assert.ok(report.diagnostics.some(x=>x.code==='delay'&&x.action));
});

test('known later availability does not delay independent ready work and a read-only task is never ready', () => {
  const source={observationAt:asOf,scopeComplete:true,capacity:{parallelism:1,calendar:'continuous'},
    tasks:[task('later',10,{availableAt:'2026-11-28T03:15:00+09:00'}),task('ready',25),
      task('scope-readback',3,{actionable:false})]};
  const report=forecast(source,{now});
  assert.equal(report.schedule.completionDates.standard,'2026-11-28T03:25:00.000+09:00');
  assert.deepEqual(report.schedule.readyTaskIds,['ready']);
});

test('scoped state cannot use an unverified claim as completion evidence or unlock its next task', () => {
  const requirement={id:'signed-artifact',implemented:true,review:{independent:true,status:'accepted'},
    validation:{status:'passed',source:'recorded claim'},artifact:{usable:true}};
  const source={observationAt:asOf,scopeComplete:true,capacity:{calendar:'continuous'},
    requirements:[requirement],
    tasks:[{id:'claim',status:'verified',requirements:[requirement],requirementIds:[requirement.id]},
      task('delivery',5,{dependencies:['claim']})]};
  const rejected=forecast(source,{now,verifiedTaskIds:new Set()});
  assert.equal(rejected.tasks[0].verified,false);
  assert.deepEqual(rejected.schedule.readyTaskIds,[]);
  assert.equal(rejected.schedule.completionDates,null);
  assert.equal(rejected.progress.formalCompletion,0);
  assert.equal(rejected.checkpoints.accepted,0);
  assert.ok(rejected.gaps.some(row=>row.code==='completion-evidence'));
  const accepted=forecast(source,{now,verifiedTaskIds:new Set(['claim'])});
  assert.equal(accepted.progress.formalCompletion,100);
  assert.deepEqual(accepted.schedule.readyTaskIds,['delivery']);
});

test('a zero claim or a scheduled approval date cannot close an unverified task', () => {
  const source={observationAt:asOf,scopeComplete:true,capacity:{calendar:'continuous'},
    tasks:[task('unknown',0,{status:'unknown',actionable:false})]};
  assert.equal(forecast(source,{now}).schedule.workMinutes,null);
  assert.equal(forecast(source,{now}).schedule.completionDates,null);
  const approval=forecast({...source,tasks:[task('held',9,{status:'approval',actionable:false,
    availableAt:'2026-11-28T03:30:00+09:00'})]},{now});
  assert.deepEqual(approval.schedule.workMinutes,range(9));
  assert.equal(approval.schedule.completionDates,null);
  const owner=forecast({...source,ownerAction:'承認待ち',tasks:[task('would-be-ready',9)]},{now});
  assert.equal(owner.schedule.completionDates,null);
  assert.deepEqual(owner.schedule.readyTaskIds,[]);
  assert.equal(owner.nextUpdate.trigger,'owner-action');
  const independent=forecast({...source,ownerAction:'配布時の本人確認',ownerActionAppliesTo:'release',
    tasks:[task('before-release',9)]},{now});
  assert.deepEqual(independent.schedule.readyTaskIds,['before-release']);
  assert.equal(independent.schedule.completionDates,null);
});
