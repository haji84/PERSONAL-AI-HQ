import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {link, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {readCurrentProject, readPortfolio, registerProject} from '../app/portfolio.mjs';
import * as deliveryRecords from '../app/delivery-records.mjs';
import {startOwnerApp} from '../app/server.mjs';
import {ensurePrivateDirectory} from '../app/private-directory.mjs';

const initiative = 'docs/initiatives/chatgpt-codex-integration';
const repository = 'https://github.com/fixture-owner/delivery-records';
const ref = 'refs/heads/stable-test';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, {versioned=true}={}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hq-delivery-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const directory = await ensurePrivateDirectory(join(root, 'runtime'));
  const checkout = join(directory, 'checkout');
  await mkdir(checkout);
  const git = (args, date) => execFileSync('git', args, {cwd:checkout, encoding:'utf8',
    env:{...process.env, GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid',
      GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid',
      ...(date && {GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date})}, stdio:['ignore','pipe','pipe']}).trim();
  if (versioned) {
    git(['init', '-q', '-b', 'stable-test']);
    git(['remote', 'add', 'origin', repository + '.git']);
  }
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
  state.status='active';
  delete state.delivery.observationAt;
  await commit({[source]:JSON.stringify(state),'proof.txt':'pass'});
  let [undated]=await views();
  assert.equal(undated.forecast.observedAt,null);
  assert.equal(undated.forecast.schedule.completionDates,null);
  await commit({'README.md':'Unrelated commit'});
  [undated]=await views();
  assert.equal(undated.forecast.observedAt,null);
  assert.equal(undated.forecast.schedule.completionDates,null);
});

test('a newly registered repository switches from intake to the committed plan and retains both estimates', async t => {
  const {directory,checkout,commit,configure,portfolioPath}=await fixture(t);
  const source='.codex/autonomy-state.json';
  await configure([]);
  const input={requestId:randomUUID(),githubProject:'github-100',goal:'Registration goal',settings:{mode:'subscription-only'}};
  const projectStub={id:input.githubProject,name:'New delivery',repository,registrationAvailable:true};
  const registration={github:{view:()=>({projects:[projectStub]})},hasSavedWork:()=>false};
  registerProject(directory,input,registration);
  const view=async ()=>(await readPortfolio(directory,undefined,true)).view.projects[0];
  const first=await view();
  assert.equal(first.forecast.stage,'着手前');
  assert.equal(first.forecast.tasks[0].id,'requirements-readback');
  assert.equal(first.schedule?.remainingMinutes??null,null);
  assert.equal(first.measurements.estimateFinish,null);
  const intake=first.forecast.baseline.original;
  const saved=JSON.parse(await readFile(portfolioPath,'utf8'));
  saved.projects[0].cwd=[checkout];
  await writeFile(portfolioPath,JSON.stringify(saved));

  const requirement={id:'build',implemented:true,review:{independent:true,status:'accepted'},
    validation:{status:'passed',source:'Runtime observation'}};
  const planning={id:'build',title:'Build the requested result',requirements:[requirement],
    remainingMinutes:{optimistic:8,standard:12,cautious:20},estimate:{basis:'Current scope',confidence:'medium'}};
  const state={version:1,status:'active',goal:{id:'build',title:'Committed delivery goal'},next_action:'Check the saved result',
    tasks:[{id:'build',status:'verified',actionable:false,depends_on:[],evidence:[{path:'proof.txt',sha256:hash('pass')}]}],
    delivery:{stage:'検証中',observationAt:new Date().toISOString(),tasks:[planning],
      estimates:[{kind:'original',target:'first-usable',minutes:{optimistic:10,standard:15,cautious:24}}]}};
  const revision=await commit({[source]:JSON.stringify(state),'proof.txt':'pass'});
  const active=await view();
  assert.equal(active.forecast.stage,'検証中');
  assert.equal(active.forecast.goal,'Committed delivery goal');
  assert.equal(active.forecast.source.url.includes(revision),true);
  assert.equal(active.forecast.baseline.original.minutes.standard,15);
  assert.deepEqual(active.forecast.baseline.intake,intake);
  assert.equal(active.schedule?.remainingMinutes??null,null);
  assert.equal(active.measurements.estimateFinish,null);
  assert.deepEqual(active.tasks.map(task=>[task.id,task.status,task.remainingMinutes.standard]),[['build','verified',0]]);

  await commit({'proof.txt':'changed'});
  const unconfirmed=await view();
  assert.equal(unconfirmed.tasks[0].status,'unknown');
  assert.equal(unconfirmed.tasks[0].progress,null);
  assert.equal(unconfirmed.forecast.tasks[0].unconfirmedCompletion,true);
  assert.equal(unconfirmed.forecast.schedule.completionDates,null);
  state.tasks[0].remaining=['Check the handset'];
  state.tasks[0].externalWait='unknown';
  await commit({[source]:JSON.stringify(state),'proof.txt':'pass'});
  const unfinished=await view();
  assert.equal(unfinished.tasks[0].status,'unknown');
  assert.deepEqual(unfinished.tasks[0].remaining,['Check the handset']);
  assert.equal(unfinished.forecast.tasks[0].externalWait,true);
  assert.equal(unfinished.tasks[0].remainingMinutes.standard,12);
  assert.equal(registerProject(directory,input,registration).created,false);
  assert.deepEqual(JSON.parse(await readFile(portfolioPath,'utf8')),saved);

  const completePlan=structuredClone(state);
  completePlan.tasks=[{id:'build',status:'pending',actionable:true,depends_on:[],evidence:[]}];
  completePlan.delivery.requirements=[{id:'build',title:'Complete the accepted result'}];
  completePlan.delivery.scopeComplete=true;
  completePlan.delivery.capacity={calendar:'continuous',parallelism:1};
  completePlan.delivery.observationAt=new Date().toISOString();
  const dueAt=new Date(Date.now()+20*60000).toISOString();
  completePlan.delivery.estimates=[{kind:'original',target:'completion',dueAt}];
  await commit({[source]:JSON.stringify(completePlan)});
  const planned=await view();
  assert.equal(planned.measurements.formalCompletion,0);
  assert.equal(planned.schedule.originalDueAt,dueAt);
  assert.deepEqual(planned.schedule.remainingMinutes,planning.remainingMinutes);
  assert.equal(planned.measurements.estimateFinish,new Date(planned.forecast.schedule.completionDates.standard).toISOString());
  assert.equal(planned.schedule.estimatedFinish,planned.measurements.estimateFinish);
  assert.deepEqual(planned.forecast.baseline.intake,intake);

  saved.taskProgressSource={checkout,repository,ref};
  const tracking={observationAt:state.delivery.observationAt,stage:'共有済み',nextAction:'Continue shared work',
    scopeComplete:true,capacity:{calendar:'continuous'}};
  state.status='paused';
  await commit({[source]:JSON.stringify(state),[initiative+'/portfolio-observation.json']:JSON.stringify({
    taskProgress:{observedAt:tracking.observationAt,projects:[{
      repository,tasks:[{...planning,status:'pending',actionable:true}],delivery:tracking}]}})});
  await writeFile(portfolioPath,JSON.stringify(saved));
  const held=await view();
  assert.equal(held.forecast.status,'paused');
  assert.equal(held.forecast.stage,'検証中');
  assert.deepEqual(held.forecast.schedule.readyTaskIds,[]);
  assert.equal(held.measurements.estimateFinish,null);

  delete saved.projects[0].cwd;
  await writeFile(portfolioPath,JSON.stringify(saved));
  const shared=await view();
  assert.equal(shared.forecast.stage,'共有済み');
  assert.equal(shared.forecast.nextAction,'Continue shared work');
  assert.equal(shared.forecast.schedule.workMinutes.standard,12);
  assert.deepEqual(shared.forecast.schedule.readyTaskIds,[]);
  assert.equal(shared.forecast.schedule.completionDates,null);
  assert.deepEqual(shared.schedule.remainingMinutes,planning.remainingMinutes);
  assert.equal(shared.measurements.estimateFinish,null);
  assert.ok(shared.forecast.ownerAction);
  assert.deepEqual(shared.forecast.baseline.intake,intake);
  assert.equal(shared.tasks[0].id,'build');
});

test('a registered local Git project adopts its own exact checkout without publishing a local path', async t => {
  const {directory,checkout,commit,configure,portfolioPath}=await fixture(t);
  const source='.codex/autonomy-state.json';
  await configure([]);
  const {id}=registerProject(directory,{requestId:randomUUID(),name:'Local project',goal:'Local goal',
    settings:{mode:'subscription-only'}},{hasSavedWork:()=>false});
  const saved=JSON.parse(await readFile(portfolioPath,'utf8'));
  saved.projects[0].cwd=[checkout];
  await writeFile(portfolioPath,JSON.stringify(saved));
  const revision=await commit({[source]:JSON.stringify({version:1,status:'paused',goal:{id:'local',title:'Committed local goal'},
    next_action:'Review local result after resuming',tasks:[{id:'review',status:'pending',actionable:true,depends_on:[]}],
    delivery:{observationAt:new Date().toISOString(),stage:'現地確認',tasks:[{id:'review',
      remainingMinutes:{optimistic:4,standard:6,cautious:10}}]}})});
  const {view}=await readPortfolio(directory,undefined,true);
  const project=view.projects.find(item=>item.id===id);
  assert.equal(project.forecast.goal,'Committed local goal');
  assert.equal(project.forecast.stage,'現地確認');
  assert.equal(project.forecast.status,'paused');
  assert.equal(project.forecast.schedule.completionDates,null);
  assert.deepEqual(project.forecast.schedule.readyTaskIds,[]);
  assert.equal(project.forecast.source.revision,revision);
  assert.equal(project.forecast.source.url,undefined);
  assert.equal(project.tasks[0].id,'review');
  assert.ok(!JSON.stringify(project).includes(checkout));

  saved.projects[0].repository=repository.replace('https:','http:');
  await writeFile(portfolioPath,JSON.stringify(saved));
  const rejected=(await readPortfolio(directory,undefined,true)).view.projects[0];
  assert.equal(rejected.forecast.goal,'Local goal');
  assert.equal(rejected.forecast.source,null);
});

test('an unversioned project reads its own bounded state, honors pending work, and never chooses an ambiguous workspace', async t => {
  const {directory,checkout,configure}=await fixture(t,{versioned:false});
  const file=join(checkout,'.codex','autonomy-state.json');
  const canonical=join(checkout,'PLAN.md');
  const proof=join(checkout,'proof.txt');
  const row={id:'local',name:'Local work',goal:'Registration goal',cwd:[checkout]};
  await configure([row]);
  await mkdir(dirname(file));
  await writeFile(canonical,'Existing plan');
  await writeFile(proof,'Evidence saved here');
  const state={version:1,status:'active',goal:{id:'local-delivery',title:'Local project plan'},
    next_action:'Inspect the finished result',source:{path:'PLAN.md',sha256:hash('Existing plan')},
    tasks:[
      {id:'draft',status:'verified',actionable:false,depends_on:[],evidence:[{path:'proof.txt',sha256:hash('Evidence saved here')}]},
      {id:'review',status:'pending',actionable:true,depends_on:['draft'],evidence:[]},
    ],
    delivery:{stage:'検証中',observationAt:new Date().toISOString(),scopeComplete:true,capacity:{calendar:'continuous'},
      tasks:[{id:'review',remainingMinutes:{optimistic:4,standard:6,cautious:10},
        estimate:{basis:'Saved output is ready for inspection',confidence:'medium'}}]}};
  async function save() {
    await writeFile(file,JSON.stringify(state));
  }
  const view=async ()=>(await readPortfolio(directory,undefined,true)).view.projects[0];
  await save();
  let result=await view();
  assert.equal(result.forecast.goal,'Local project plan');
  assert.equal(result.forecast.stage,'検証中');
  assert.deepEqual(result.forecast.schedule.readyTaskIds,['review']);
  assert.equal(result.forecast.schedule.workMinutes.standard,6);
  assert.equal(result.forecast.source.revision,hash(await readFile(file)));
  assert.equal(result.forecast.source.url,undefined);
  assert.ok(!JSON.stringify(result).includes(JSON.stringify(checkout).slice(1,-1)));

  const otherLink=join(directory,'alias-proof.txt');
  await link(proof,otherLink);
  result=await view();
  assert.equal(result.forecast.tasks[0].unconfirmedCompletion,true);
  assert.deepEqual(result.forecast.schedule.readyTaskIds,[]);
  assert.equal(result.forecast.schedule.completionDates,null);
  await unlink(otherLink);

  const independentRepo=join(checkout,'independent');
  await mkdir(independentRepo);
  execFileSync('git',['init','-q',independentRepo]);
  await writeFile(join(independentRepo,'proof.txt'),'Evidence saved here');
  state.tasks[0].evidence[0].path='independent/proof.txt';
  await save();
  result=await view();
  assert.equal(result.forecast.tasks[0].unconfirmedCompletion,true);
  assert.deepEqual(result.forecast.schedule.readyTaskIds,[]);
  state.tasks[0].evidence[0].path='proof.txt';
  await save();

  await writeFile(canonical,'Changed plan');
  result=await view();
  assert.equal(result.forecast.goal,'Registration goal');
  assert.equal(result.forecast.source,null);
  await writeFile(canonical,'Existing plan');

  state.status='paused';
  await save();
  result=await view();
  assert.equal(result.forecast.status,'paused');
  assert.deepEqual(result.forecast.schedule.readyTaskIds,[]);
  assert.equal(result.forecast.schedule.completionDates,null);

  await configure([row,{...row,id:'another',name:'Another project'}]);
  result=await view();
  assert.equal(result.forecast.goal,'Registration goal');
  assert.equal(result.forecast.source,null);

  const nested=join(checkout,'nested');
  await mkdir(nested);
  await configure([row,{id:'nested',name:'Nested project',cwd:[nested]}]);
  result=await view();
  assert.equal(result.forecast.goal,'Registration goal');
  assert.equal(result.forecast.source,null);
  await configure([row]);

  execFileSync('git',['init','-q',directory]);
  result=await view();
  assert.equal(result.forecast.goal,'Registration goal');
  assert.equal(result.forecast.source,null);
});

test('the existing shared observation can carry a local project across devices by its registered ID', async t => {
  const {directory,checkout,commit,configure,portfolioPath}=await fixture(t);
  const id='registered-offline-project';
  const observedAt=new Date().toISOString();
  const task={id:'compare',status:'pending',actionable:true,remainingMinutes:{optimistic:4,standard:6,cautious:10},
    estimate:{basis:'The saved evidence narrows the remaining check',confidence:'medium'}};
  const localRecord={localProjectId:id,tasks:[task],delivery:{
    stage:'Evidence check',scopeComplete:true,capacity:{calendar:'continuous'},nextAction:'Start the recorded work'}};
  const path=initiative+'/portfolio-observation.json';
  const saved=await commit({[path]:JSON.stringify({taskProgress:{observedAt,projects:[],localProjects:[localRecord]}})});
  const registeredWorkspace=join(directory,'local-workspace');
  await mkdir(registeredWorkspace);
  const local={id,name:'Same name',cwd:[registeredWorkspace]};
  await configure([local,{id:'different',name:'Same name'}]);
  const settings=JSON.parse(await readFile(portfolioPath,'utf8'));
  settings.taskProgressSource={checkout,repository,ref};
  await writeFile(portfolioPath,JSON.stringify(settings));
  async function view() {return (await readPortfolio(directory,undefined,true)).view;}
  let portfolio=await view();
  let [matched,other]=portfolio.projects;
  assert.equal(matched.forecast.stage,'Evidence check');
  assert.equal(matched.forecast.schedule.workMinutes.standard,6);
  assert.ok(matched.forecast.source.url.includes(saved));
  assert.deepEqual(matched.forecast.schedule.readyTaskIds,[]);
  assert.equal(matched.forecast.schedule.completionDates,null);
  assert.equal(matched.forecast.ownerAction,null);
  assert.ok(matched.forecast.gaps.some(({code})=>code==='workspace-observation'));
  assert.equal(matched.forecast.nextAction,'保存済みの進行状態と作業先を照合する。');
  assert.equal(other.forecast.source,null);
  assert.equal(portfolio.taskProgressSource.unmatched,0);

  const requirement={id:'checked',implemented:true,review:{independent:true,status:'accepted'},
    validation:{status:'passed',source:'Recorded elsewhere'},artifact:{usable:true}};
  await commit({[path]:JSON.stringify({taskProgress:{
    observedAt,projects:[],localProjects:[{...localRecord,
      delivery:{...localRecord.delivery,requirements:[requirement]},
      tasks:[{...task,status:'verified',actionable:false,requirementIds:['checked'],requirements:[requirement]}]}]}})});
  matched=(await view()).projects[0];
  assert.equal(matched.forecast.progress.formalCompletion,0);
  assert.equal(matched.tasks[0].status,'unknown');
  assert.equal(matched.tasks[0].progress,null);
  assert.equal(matched.tasks[0].remainingMinutes.standard,6);

  settings.projects[0].registrationRequestId=randomUUID();
  delete settings.projects[0].cwd;
  await writeFile(portfolioPath,JSON.stringify(settings));
  const withoutWorkspace=(await view()).projects[0];
  assert.equal(withoutWorkspace.scopeRequired,true);
  assert.equal(withoutWorkspace.forecast.ownerAction,null);
  assert.equal(withoutWorkspace.forecast.nextAction,'保存済みの進行状態と作業先を照合する。');

  settings.projects[0].repository='http://github.com/fixture-owner/unrelated';
  await writeFile(portfolioPath,JSON.stringify(settings));
  portfolio=await view();
  assert.equal(portfolio.projects[0].forecast.source,null);
  assert.equal(portfolio.taskProgressSource.unmatched,1);

  await commit({[path]:JSON.stringify({taskProgress:{
    observedAt,projects:[],localProjects:[{...localRecord,repository}]}})});
  assert.equal((await view()).taskProgressSource.status,'unavailable');
});

test('unmatched shared local records remain visible without joining the project registration or execution scope', async t => {
  const {directory,checkout,commit,configure,portfolioPath}=await fixture(t);
  const observedAt=new Date().toISOString();
  const task={id:'verify-package',title:'Waiting for a real machine',status:'pending',actionable:true,
    remainingMinutes:{optimistic:5,standard:10,cautious:20},estimate:{basis:'Saved test conditions',confidence:'medium'},
    evidence:[{label:'Other host signed link',url:'https://fixture.invalid/file?token=fixture-capability'}]};
  const requirement={id:'check',implemented:true,review:{independent:true,status:'accepted'},
    validation:{status:'passed',source:'Recorded elsewhere'},artifact:{usable:true}};
  const localProjects=[
    {localProjectId:'other-host',name:'Other machine project',workspace:'/private/not-a-binding',codexWrite:true,
      observationAt:observedAt,delivery:{stage:'Review the delivery',nextAction:'Check the original acceptance'},
      tasks:[{...task,status:'active'},{...task,id:'old-completion',status:'verified',requirements:[requirement],
        remainingMinutes:{optimistic:0,standard:0,cautious:0}}]},
    {localProjectId:'also-registered',tasks:[{...task,status:'waiting',externalWait:'unknown'}]},
    {localProjectId:'already-linked',tasks:[task]},
  ];
  const observation=initiative+'/portfolio-observation.json';
  const revision=await commit({[observation]:JSON.stringify({taskProgress:{observedAt,projects:[],localProjects}})});
  await configure([
    {id:'also-registered',name:'GitHub registration',repository:'https://github.com/fixture-owner/committed-project'},
    {id:'already-linked',name:'Existing local registration',state:'paused'},
  ]);
  const config=JSON.parse(await readFile(portfolioPath,'utf8'));
  config.taskProgressSource={checkout,repository,ref};
  await writeFile(portfolioPath,JSON.stringify(config));
  const original=await readFile(portfolioPath);

  const result=await readPortfolio(directory,undefined,true);
  const {view}=result;
  assert.deepEqual([...result.projects.keys()],['also-registered','already-linked']);
  assert.equal(readCurrentProject(directory,'other-host'),null);
  assert.deepEqual(view.projects.find(project=>project.id==='also-registered').tasks,[]);
  const linked=view.projects.find(project=>project.id==='already-linked');
  assert.equal(linked.state,'paused');
  assert.deepEqual(linked.forecast.schedule.readyTaskIds,[]);
  assert.equal(linked.tasks.length,1);
  assert.equal(view.taskProgressSource.unmatched,2);
  assert.ok(view.taskProgressSource.evidence.url.includes(revision));
  const shared=view.taskProgressSource.unlinkedLocalProjects;
  assert.deepEqual(shared.map(row=>[row.id,row.sameIdRegistration]),[['other-host',null],['also-registered','GitHub registration']]);
  assert.deepEqual([shared[0].name,shared[0].stage,shared[0].nextAction,shared[0].observedAt],
    ['Other machine project','Review the delivery','Check the original acceptance',observedAt]);
  assert.equal(shared[0].tasks[0].status,'unknown');
  assert.equal(shared[0].tasks[0].remainingMinutes.standard,10);
  assert.deepEqual([shared[0].tasks[1].status,shared[0].tasks[1].progress,shared[0].tasks[1].remainingMinutes],['unknown',null,null]);
  assert.deepEqual([shared[1].tasks[0].status,shared[1].tasks[0].externalWait],['waiting',true]);
  assert(!JSON.stringify(shared).includes('/private/not-a-binding'));
  assert(!JSON.stringify(shared).includes('fixture-capability'));
  assert.deepEqual(await readFile(portfolioPath),original);

  await commit({[observation]:JSON.stringify({taskProgress:{observedAt,projects:[],localProjects:[localProjects[2]]}})});
  const refreshed=(await readPortfolio(directory,undefined,true)).view;
  assert.equal(refreshed.taskProgressSource.unmatched,0);
  assert.equal(refreshed.taskProgressSource.unlinkedLocalProjects,undefined);
});
