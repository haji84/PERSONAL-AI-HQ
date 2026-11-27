import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readPortfolio } from '../app/portfolio.mjs';

test('equivalent absolute workspace paths use the host format before Codex scope checks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-portfolio-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    assert.ok(target.includes('hq-portfolio-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const workspace = resolve(directory, 'workspace');
  const portable = workspace.replaceAll('\\', '/') + '/';
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({
    projects: [{ id: 'project-a', name: 'Path test', cwd: [portable, workspace, 'relative-workspace'] }],
  }));
  const portfolio = await readPortfolio(directory);
  assert.deepEqual(portfolio.projects.get('project-a').cwd, [workspace]);
  assert.equal(portfolio.view.projects[0].cwd, undefined);
});

test('the private portfolio publishes task-level evidence, estimates and unavailable fields separately', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-task-progress-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const observedAt = '2026-11-27T14:00:00.000Z';
  const estimate = {optimistic: 10, standard: 20, cautious: 25};
  const requirement = {id: 'native', implemented: true, targetRuntimeRequired: true,
    review: {independent: true, status: 'accepted'},
    validation: {status: 'passed', source: 'runtime observation', runtime: 'target'}};
  const tasks = [
    {id: 'dashboard', title: 'ダッシュボード', status: 'active', remaining: ['ZBookで画面を照合'],
      requirements: [requirement, {id: 'phone'}], remainingMinutes: estimate,
      evidence: [{label: '実動の記録', url: 'https://example.com/observations'}]},
    {id: 'api', title: 'API受入', status: 'blocked', blocker: '特典残高の確認待ち',
      externalWait: 'unknown', remainingMinutes: estimate, evidence: [{label: 'invalid', url: 'javascript:alert(1)'}]},
    {id: 'mobile', title: 'スマートフォン', status: 'pending', remainingMinutes: {standard: 8}},
    {id: 'fixture', title: '隔離試験', status: 'verified', requirements: [requirement]},
    {id: 'mismatch', title: '未照合の作業', status: 'verified', requirements: [{id: 'missing'}]},
    {id: 'missing-denominator', title: '確認項目が不明', status: 'verified', remaining: ['再確認']},
    {id:'still-held', title:'承認待ち', status:'verified', requirements:[requirement], blocker:'承認が必要',
      remainingMinutes:{optimistic:0, standard:0, cautious:0}},
    {id:'unperformed', title:'未着手', status:'pending', remaining:['実機確認'],
      remainingMinutes:{optimistic:0, standard:0, cautious:0}},
  ];
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({observedAt,
    projects: [
      {id: 'hq', name: 'HQ', delivery: {observationAt: observedAt, tasks}},
      {id: 'invalid', name: 'Invalid', delivery: {tasks: [tasks[0], tasks[0]]}},
      {id: 'legacy', name: 'Legacy', remaining: ['古い記録']},
    ],
  }));
  const {view} = await readPortfolio(directory);
  const [hq, invalid, legacy] = view.projects;
  assert.equal(hq.measurements.formalCompletion, null);
  assert.equal(hq.schedule.remainingMinutes, null);
  assert.deepEqual(hq.tasks[0], {
    id: 'dashboard', title: 'ダッシュボード', status: 'active', remaining: ['ZBookで画面を照合'],
    progress: {accepted: 1, total: 2, percent: 50}, observedAt, remainingMinutes: estimate,
    blocker: '', externalWait: false, evidence: [{label: '実動の記録', url: 'https://example.com/observations'}],
  });
  assert.equal(hq.tasks[1].progress, null);
  assert.equal(hq.tasks[1].externalWait, true);
  assert.equal(hq.tasks[1].blocker, '特典残高の確認待ち');
  assert.equal(hq.tasks[1].evidence[0].url, null);
  assert.deepEqual(hq.tasks[1].remainingMinutes, estimate);
  assert.equal(hq.tasks[2].remainingMinutes, null);
  assert.equal(hq.tasks[3].remainingMinutes.standard, 0);
  assert.equal(hq.tasks[4].status, 'unknown');
  assert.equal(hq.tasks[4].remainingMinutes, null);
  assert.equal(hq.tasks[5].status, 'unknown');
  assert.deepEqual(hq.tasks[5].remaining, ['再確認']);
  assert.equal(hq.tasks[6].status,'unknown');
  assert.equal(hq.tasks[6].progress,null);
  assert.equal(hq.tasks[6].remainingMinutes,null);
  assert.equal(hq.tasks[7].remainingMinutes,null);
  assert.deepEqual(invalid.tasks, []);
  assert.deepEqual(legacy.tasks, []);
  assert.deepEqual(legacy.remaining, ['古い記録']);
});
