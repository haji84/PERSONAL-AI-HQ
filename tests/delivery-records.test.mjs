import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {readCurrentProject, readPortfolio} from '../app/portfolio.mjs';
import * as deliveryRecords from '../app/delivery-records.mjs';
import {startOwnerApp} from '../app/server.mjs';
import {ensurePrivateDirectory} from '../app/private-directory.mjs';

const initiative = 'docs/initiatives/chatgpt-codex-integration';
const repository = 'https://github.com/fixture-owner/delivery-records';
const ref = 'refs/heads/stable-test';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hq-delivery-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const directory = await ensurePrivateDirectory(join(root, 'runtime'));
  const checkout = join(directory, 'checkout');
  await mkdir(checkout);
  const git = (args, date) => execFileSync('git', args, {cwd:checkout, encoding:'utf8',
    env:{...process.env, GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid',
      GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid',
      ...(date && {GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date})}, stdio:['ignore','pipe','pipe']}).trim();
  git(['init', '-q', '-b', 'stable-test']);
  git(['remote', 'add', 'origin', repository + '.git']);
  async function commit(files, date) {
    for (const [name, text] of Object.entries(files)) {
      const destination = join(checkout, name);
      await mkdir(dirname(destination), {recursive:true});
      await writeFile(destination, text);
    }
    git(['add', '--', ...Object.keys(files)]);
    git(['commit', '-q', '-m', 'Fixture observation'], date);
    return git(['rev-parse', 'HEAD']);
  }
  const portfolioPath = join(directory, 'portfolio.json');
  async function configure(rows) {
    const text = JSON.stringify({projects:rows});
    await writeFile(portfolioPath, text, {mode:0o600});
    return text;
  }
  return {directory, checkout, commit, configure, portfolioPath};
}

const plan = `# 実行記録

## 当初見積もり（2026-11-27 15:29 JST、実装前）

| 初回提供の経過時間 | 2.5h | 4.5h | 8h |

全体の条件付き予測は最短7〜10作業日、標準12〜18作業日、慎重25〜35作業日。実機への接続が可能な場合の見込み。外部待機日数と全機能の無条件な完成日は不明。

## 現在地

- 次は保存された要求を確認する。
`;
const first = {goalStartedAt:'2026-11-27T06:25:25Z', firstUsableAt:'2026-11-27T06:51:19Z',
  elapsedToFirstUsableSeconds:1554, observedAt:'2026-11-27T07:08:21Z', platform:'MacBook',
  localReadback:{anonymousDataStatus:401, ownerSessionStatus:303, portfolioRows:18}};

test('dashboard task observations follow committed records and preserve project identity and pause state', async t => {
  const {directory, checkout, commit, configure, portfolioPath} = await fixture(t);
  const path = initiative + '/portfolio-observation.json';
  const observedAt = '2026-11-27T15:30:00.000Z';
  const tracked = 'https://github.com/fixture-owner/Tracked';
  const taskProgress = {observedAt, projects: [{repository: tracked,
    tasks: [{id: 'verification', title: 'Initial work', status: 'active'}]}]};
  const original = {taskProgress};
  const saved = await commit({[path]: JSON.stringify(original)});
  await configure([
    {id: 'same-repository', name: 'Tracked', state: 'paused', repository: tracked.toLowerCase() + '.git'},
    {id: 'different-repository', name: 'Different', repository: tracked + '-different'},
  ]);
  const settings = JSON.parse(await readFile(portfolioPath, 'utf8'));
  settings.taskProgressSource = {checkout, repository, ref};
  await writeFile(portfolioPath, JSON.stringify(settings));
  const view = async () => (await readPortfolio(directory, undefined, true)).view;
  const initial = await view();
  assert.equal(initial.taskProgressSource.status, 'current');
  assert.equal(initial.taskProgressSource.observedAt, observedAt);
  assert.ok(initial.taskProgressSource.evidence.url.includes(saved));
  assert.equal(initial.projects[0].state, 'paused');
  assert.equal(initial.projects[0].tasks[0].title, 'Initial work');
  assert.deepEqual(initial.projects[1].tasks, []);
  assert.ok(!JSON.stringify(initial).includes(checkout));

  taskProgress.projects[0].tasks[0].title = 'Saved update';
  await writeFile(join(checkout, path), JSON.stringify(original));
  assert.equal((await view()).projects[0].tasks[0].title, 'Initial work');
  await commit({[path]: JSON.stringify(original)});
  assert.equal((await view()).projects[0].tasks[0].title, 'Saved update');
  settings.projects[1].repository = tracked;
  await writeFile(portfolioPath, JSON.stringify(settings));
  const ambiguous = await view();
  assert.equal(ambiguous.taskProgressSource.unmatched, 1);
  assert.ok(ambiguous.projects.every(project => !project.tasks.length));
  taskProgress.projects.push({...taskProgress.projects[0]});
  await commit({[path]: JSON.stringify(original)});
  assert.equal((await view()).taskProgressSource.status, 'unavailable');
  assert.deepEqual((await view()).projects[0].tasks, []);
  assert.deepEqual(JSON.parse(await readFile(portfolioPath, 'utf8')), settings);

  const candidate = tracked+'-candidate';
  taskProgress.projects = [{repository:tracked,tasks:[]},{repository:candidate,
    tasks:[{id:'private-work', title:'Separate progress', status:'pending'}]}];
  await commit({[path]:JSON.stringify(original)});
  settings.projects[0].delivery = {tasks:[{id:'local-work', title:'Locally recorded task', status:'pending'}]};
  settings.projects[1].repository = tracked+'-different';
  await writeFile(portfolioPath, JSON.stringify(settings));
  const github = {view:()=>({projects:[{id:'github-candidate',name:'Unregistered candidate',repository:candidate}]})};
  const scoped = (await readPortfolio(directory,github,true)).view;
  assert.equal(scoped.taskProgressSource.unmatched,1);
  assert.equal(scoped.projects[0].tasks[0].title,'Locally recorded task');
  assert.deepEqual(scoped.projects.find(project=>project.id==='github-candidate').tasks,[]);
});

test('the initial estimate and actual first usable delivery come from fixed commits while the next action updates', async t => {
  const {directory, checkout, commit, configure, portfolioPath} = await fixture(t);
  const baselineCommit = await commit({[initiative + '/DELIVERY.md']:plan}, '2026-11-27T06:31:00Z');
  const observationCommit = await commit({[initiative + '/mac-first-release-observation.json']:JSON.stringify(first)}, '2026-11-27T07:10:00Z');
  const definitions = [
    {id:'integration', name:'Integration', state:'paused', measurements:{estimateFinish:'2026-11-27T19:55:00+09:00'},
      deliverySource:{kind:'integration-milestone', checkout, repository, ref, baselineCommit, observationCommit}},
    {id:'manual', name:'Other project', measurements:{formalCompletion:33, estimateFinish:'2026-11-28T11:00:00+09:00'}},
  ];
  const original = await configure(definitions);
  const view = async () => (await readPortfolio(directory, undefined, true)).view.projects;
  let [row, manual] = await view();
  assert.equal(row.state, 'paused');
  assert.equal(row.deliveryRecord.status, 'current');
  assert.deepEqual(row.deliveryRecord.firstUsable, {baselineRecordedAt:'2026-11-27T06:29:00.000Z',
    baselineMinutes:{optimistic:150,standard:270,cautious:480}, actualAt:'2026-11-27T06:51:19.000Z',
    elapsedSeconds:1554,varianceSeconds:-14646});
  assert.match(row.deliveryRecord.originalFullForecast, /条件付き予測/);
  assert.equal(row.deliveryRecord.nextAction, '保存された要求を確認する。');
  assert.equal(row.measurements.estimateFinish, null);
  assert.equal(row.measurements.formalCompletion, null);
  assert.equal(manual.measurements.formalCompletion, 33);
  assert.ok(manual.measurements.estimateFinish);
  assert.equal(readCurrentProject(directory, row.id).measurements.estimateFinish, '2026-11-27T10:55:00.000Z');
  assert.ok(row.deliveryRecord.links.some(link => link.url.includes(baselineCommit)));
  assert.ok(row.deliveryRecord.links.some(link => link.url.includes(observationCommit)));
  assert.ok(!JSON.stringify(row).includes(checkout));
  assert.equal(await readFile(portfolioPath, 'utf8'), original);

  await writeFile(join(checkout, initiative, 'DELIVERY.md'), plan.replace('保存された要求を確認する。','未保存の値。'));
  assert.equal((await view())[0].deliveryRecord.nextAction, '保存された要求を確認する。');
  const revision = await commit({[initiative + '/DELIVERY.md']:plan.replace('4.5h','5h').replace('保存された要求を確認する。','次の作業を照合する。')});
  [row] = await view();
  assert.equal(row.deliveryRecord.nextAction, '次の作業を照合する。');
  assert.equal(row.deliveryRecord.firstUsable.baselineMinutes.standard, 270);
  assert.ok(row.deliveryRecord.links.some(link => link.url.includes(revision)));
  await commit({[initiative + '/DELIVERY.md']:plan + '\n### 新しい観測\n更新を確認した。\n'});
  assert.equal((await view())[0].deliveryRecord.nextAction, undefined);
  await commit({[initiative + '/DELIVERY.md']:plan + '\n### 新しい観測\n- 次は短い予定。\n- 次は' + '長'.repeat(361) + '\n'});
  assert.equal((await view())[0].deliveryRecord.nextAction, undefined);
  definitions[0].deliverySource.repository = 'https://github.com/different-owner/delivery-records';
  await configure(definitions);
  assert.equal((await view())[0].deliveryRecord.status, 'unavailable');
});

test('execution forecasts read committed matching project records and require the claimed evidence blobs', async t => {
  const {checkout, commit} = await fixture(t);
  const file = initiative + '/DELIVERY.md';
  const proof = 'mac-fixture-observation.json';
  await commit({[file]:plan, [initiative+'/'+proof]:'{"evidence":true}\n'});
  const condition = {kind:'integration-milestone', checkout, repository, ref};
  const empty = await deliveryRecords.readExecutionEstimateSource(condition,'integration');
  assert.deepEqual(empty,{rows:[], unavailable:false});
  const estimate = {project:'integration', recordedAt:'2026-11-27T06:30:00Z', execution:{mode:'subscription-only'},
    target:'milestone', scope:'Scoped first usable delivery', firstUsableMinutes:{optimistic:4,standard:6,cautious:9},
    basis:'The recorded verification milestone', evidence:[proof]};
  const fence = '\u0060'.repeat(3);
  const withRows = rows => plan+'\n'+fence+'route-estimates\n'+JSON.stringify(rows)+'\n'+fence+'\n';
  const revision = await commit({[file]:withRows([estimate])});
  const saved = await deliveryRecords.readExecutionEstimateSource(condition,'integration');
  assert.equal(saved.unavailable,false);
  assert.equal(saved.rows.length,1);
  assert.deepEqual(saved.rows[0].firstUsableMinutes,estimate.firstUsableMinutes);
  assert.ok(saved.rows[0].links.some(link=>link.url.includes(revision) && link.url.endsWith(proof)));
  assert.ok(!JSON.stringify(saved).includes(checkout));
  assert.deepEqual((await deliveryRecords.readExecutionEstimateSource(condition,'unrelated')).rows,[]);
  await writeFile(join(checkout,file),withRows([{...estimate,firstUsableMinutes:{optimistic:99,standard:99,cautious:99}}]));
  assert.equal((await deliveryRecords.readExecutionEstimateSource(condition,'integration')).rows[0].firstUsableMinutes.standard,6);
  await commit({[file]:withRows([{...estimate,evidence:['absent-observation.json']}])});
  assert.deepEqual(await deliveryRecords.readExecutionEstimateSource(condition,'integration'),{rows:[],unavailable:true});
});

test('a scoped environment audit requires the untouched owner requirement bytes and all twelve sections', async t => {
  const {directory, checkout, commit, configure} = await fixture(t);
  const owner = Array.from({length:12}, (_,index) => (index+1) + '. Original section').join('\n');
  const report = {schema_version:1, goal_complete:true, audit_at:'2026-11-26T17:35:57.230Z',
    original_requirements:{sha256:hash(owner),verbatim_body_match:true}, auditor_independence:'Independent reviewer',
    remaining_material_conditions:[], overall_status:'ACCEPTED_ALL_ORIGINAL_REQUIREMENTS',
    functional_acceptance:'ACCEPTED_BOTH_HOSTS_WITH_EXPLICIT_LIMITATIONS',
    requirements:Array.from({length:12},(_,index) =>
      ({section:index+1, status:'ACCEPTED', proven:['observed'], evidence:['independent report']}))};
  const reportPath = 'verification/final-shared-goal-audit.json';
  const requirementsCommit = await commit({'OWNER_REQUIREMENTS.md':owner, [reportPath]:JSON.stringify(report)});
  await configure([{id:'environment',name:'Environment',state:'paused',
    deliverySource:{kind:'environment-audit', checkout, repository, ref, requirementsCommit}}]);
  const read = async () => (await readPortfolio(directory, undefined, true)).view.projects[0];
  const approved = await read();
  assert.equal(approved.deliveryRecord.status,'current');
  assert.deepEqual(approved.deliveryRecord.audit,{accepted:12,total:12,unit:'節'});
  assert.equal(approved.measurements.formalCompletion,null);
  assert.equal(approved.state,'paused');

  await commit({[reportPath]:JSON.stringify({...report,requirements:report.requirements.slice(0,11)})});
  const incomplete = await read();
  assert.equal(incomplete.deliveryRecord.status,'unavailable');
  assert.equal(incomplete.deliveryRecord.audit,undefined);
  assert.equal(incomplete.state,'paused');
  const changed = owner+'\nchanged';
  await commit({'OWNER_REQUIREMENTS.md':changed, [reportPath]:JSON.stringify({...report,
    original_requirements:{sha256:hash(changed),verbatim_body_match:true}})});
  assert.equal((await read()).deliveryRecord.status,'unavailable');
});

test('owner requirement coverage exposes exact source lines and committed evidence only to the selected signed-in project', async t => {
  const {directory, checkout, commit, configure} = await fixture(t);
  const ownerPath = initiative + '/OWNER_REQUEST_20261127.txt';
  const coveragePath = initiative + '/owner-requirement-coverage.json';
  const owner = '# Owner request\n\n## First section\nKeep authorized state.\nhttps://example.org/reference\n\n## Second section\nVerify the real device.\n';
  const evidenceFile = 'mac-fixture-observation.json';
  const baseline = await commit({[ownerPath]:owner,[initiative+'/'+evidenceFile]:'{"fixture":true}\n'});
  const rows = [
    {line:4,status:'verified',note:'Fixture checked the existing state.',evidence:[evidenceFile]},
    {line:5,status:'reference',note:'Source reference.',evidence:[]},
    {line:8,status:'blocked',note:'Device has not been tested.',evidence:[]},
  ];
  const document = {schemaVersion:1, ownerRevision:baseline, ownerSha256:hash(owner), evidenceRevision:baseline, rows};
  await commit({[coveragePath]:JSON.stringify(document)});
  const binding = {kind:'integration-milestone', checkout, repository, ref,
    ownerRequestRevision:baseline, ownerRequestSha256:hash(owner)};
  await configure([
    {id:'integration',name:'Integration',state:'paused',deliverySource:binding},
    {id:'unrelated',name:'Other project'},
  ]);
  const read = () => deliveryRecords.readOwnerRequirementCoverage(binding);
  assert.deepEqual(await deliveryRecords.readOwnerRequirementCoverage({...binding, ownerRequestSha256:undefined}),{status:'unavailable'});
  const projection = await read();
  assert.equal(projection.status,'current');
  assert.deepEqual(projection.counts,{total:3,verified:1,partial:0,open:0,blocked:1,reference:1});
  assert.deepEqual(projection.sections.map(section=>section.title),['First section','Second section']);
  assert.match(projection.sections[0].rows[0].sourceUrl,/#L4$/);
  assert.ok(projection.sections[0].rows[0].evidence[0].url.includes(baseline));
  assert.equal(projection.sections[1].rows[0].status,'blocked');
  assert.ok(!JSON.stringify(projection).includes(checkout));

  const portal=await startOwnerApp({directory,port:0,codex:{}});
  try {
    const route=portal.url+'/api/portfolio/requirements?project=';
    assert.equal((await fetch(route+'integration')).status,401);
    const html=await readFile(portal.signInFile,'utf8');
    const key=/name="key" value="([a-f0-9]{64})"/.exec(html)[1];
    const login=await fetch(portal.url+'/api/session',{method:'POST',redirect:'manual',
      headers:{Origin:'null'},body:new URLSearchParams({key})});
    assert.equal(login.status,303);
    const headers={cookie:login.headers.get('set-cookie').split(';')[0]};
    assert.equal((await fetch(route+'unrelated',{headers})).status,404);
    assert.equal((await fetch(route+'integration&project=unrelated',{headers})).status,404);
    assert.deepEqual(await (await fetch(route+'integration',{headers})).json(),projection);
  } finally {
    await portal.close();
  }

  await commit({[coveragePath]:JSON.stringify({...document,rows:rows.slice(0,2)})});
  assert.deepEqual(await read(),{status:'unavailable'});
  await commit({[coveragePath]:JSON.stringify({...document,rows:[...rows.slice(0,2),{...rows[2],status:'reference'}]})});
  assert.deepEqual(await read(),{status:'unavailable'});
  await commit({[coveragePath]:JSON.stringify({...document,rows:[{...rows[0],evidence:['mac-missing-observation.json']},...rows.slice(1)]})});
  assert.deepEqual(await read(),{status:'unavailable'});
  const shortened = owner.split('\n').slice(0,6).join('\n') + '\n';
  const replacement = await commit({[ownerPath]:shortened});
  await commit({[coveragePath]:JSON.stringify({...document,ownerRevision:replacement,ownerSha256:hash(shortened),
    evidenceRevision:replacement,rows:rows.slice(0,2)})});
  assert.deepEqual(await read(),{status:'unavailable'});
});

test('a scoped existing checkout contributes committed lifecycle state without importing another repository or dirty edits', async t => {
  const {directory,checkout,commit,configure}=await fixture(t);
  const source='.codex/autonomy-state.json';
  const observedAt=new Date().toISOString();
  const state={version:1,goal:{id:'managed',title:'Committed GOAL',acceptance:['Checked SHA']},
    status:'active',next_action:'Finish the accepted artifact',tasks:[
      {id:'verified',status:'verified',actionable:false,depends_on:[],evidence:[{path:'proof.txt',sha256:hash('pass')}]},
      {id:'open',status:'pending',actionable:true,depends_on:['verified'],evidence:[]},
    ],delivery:{observationAt:observedAt,stage:'開発中',scopeComplete:true,capacity:{parallelism:1,calendar:'continuous'},
      tasks:[{id:'open',remainingMinutes:{optimistic:5,standard:8,cautious:12},
        estimate:{basis:'Current source comparison',confidence:'medium'}}]}};
  await commit({[source]:JSON.stringify(state),'proof.txt':'pass'});
  await configure([{id:'existing',name:'Existing',cwd:[checkout],repository},
    {id:'foreign',name:'Foreign',cwd:[checkout],repository:repository+'-other'}]);
  async function views(){ return (await readPortfolio(directory,undefined,true)).view.projects; }
  const [active,foreign]=await views();
  assert.equal(active.forecast.goal,'Committed GOAL');
  assert.equal(active.forecast.schedule.workMinutes.standard,8);
  assert.deepEqual(active.forecast.schedule.readyTaskIds,['open']);
  assert.equal(foreign.forecast.goal,null);
  assert.ok(!JSON.stringify(active).includes(checkout));
  state.status='paused';
  await writeFile(join(checkout,source),JSON.stringify(state));
  assert.deepEqual((await views())[0].forecast.schedule.readyTaskIds,['open']);
  await commit({[source]:JSON.stringify(state),'proof.txt':'changed'});
  const [held]=await views();
  assert.equal(held.forecast.status,'paused');
  assert.equal(held.forecast.schedule.workMinutes,null);
  assert.deepEqual(held.forecast.schedule.readyTaskIds,[]);
});
