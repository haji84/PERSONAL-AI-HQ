import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';
import {isAbsolute, join, normalize} from 'node:path';
import {promisify} from 'node:util';
import {readOnlyGitInvocation} from './api-workspace.mjs';

const cli = promisify(execFile);
const initiative = 'docs/initiatives/chatgpt-codex-integration';
const timelinePath = initiative + '/DELIVERY.md';
const firstReleasePath = initiative + '/mac-first-release-observation.json';
const ownerRequestPath = initiative + '/OWNER_REQUEST_20261127.txt';
const ownerCoveragePath = initiative + '/owner-requirement-coverage.json';
const portfolioObservationPath = initiative + '/portfolio-observation.json';
const ownerPath = 'OWNER_REQUIREMENTS.md';
const auditPath = 'verification/final-shared-goal-audit.json';
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const contentDigest = /^[a-f0-9]{64}$/;
const sourceRef = /^refs\/(?:heads|remotes\/origin)\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,179}$/;
const accepted = new Set(['ACCEPTED_RUNTIME_BOTH_HOSTS', 'PROVEN_WITH_LIMITS', 'PROVEN', 'PROVEN_WITH_SCOPE',
  'ACCEPTED', 'PROVEN_FOR_SCOPED_ARTIFACTS']);
const recordScope = {'integration-milestone':'統合アプリの初回提供', 'environment-audit':'共通開発環境の初期構築'};
const coverageStatuses = ['verified','partial','open','blocked','reference'];
const evidenceName = /^(?:[a-z0-9.-]+-observation\.json|DELIVERY\.md|EXECUTION_MODES\.md)$/;

function gitHubRepository(value) {
  return typeof value === 'string' ?
    /^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/?$/i.exec(value.replace(/\.git\/?$/, ''))?.[1] : undefined;
}

function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function link(repository, revision, file, label) {
  return {label, url:'https://github.com/' + repository + '/blob/' + revision + '/' + file};
}

async function openSource(source, {allowHead=false} = {}) {
  const {checkout, ref} = source;
  const repository = gitHubRepository(source.repository);
  if (!repository || typeof checkout !== 'string' || !isAbsolute(checkout) || normalize(checkout) !== checkout ||
      typeof ref !== 'string' || (!(allowHead && ref==='HEAD') && !sourceRef.test(ref)) || ref.includes('..') || ref.endsWith('/')) throw new Error('Invalid delivery source');
  const owner = process.getuid?.();
  const info = await lstat(checkout);
  if (!info.isDirectory() || (owner !== undefined && info.uid !== owner) || normalize(await realpath(checkout)) !== checkout) {
    throw new Error('Invalid delivery checkout');
  }
  const signal = AbortSignal.timeout(4000);
  async function git(...arguments_) {
    const command = readOnlyGitInvocation(checkout, arguments_);
    return (await cli(command.executable, command.args, {env:command.env, signal, encoding:'buffer',
      timeout:3000, maxBuffer:256 * 1024})).stdout;
  }
  const [root, origin, selected] = await Promise.all([git('rev-parse','--show-toplevel'), git('config','--local','--get','remote.origin.url'),
    git('rev-parse','--verify',ref + '^{commit}')]);
  const revision = selected.toString().trim();
  if (normalize(root.toString().trim()) !== checkout || gitHubRepository(origin.toString().trim())?.toLowerCase() !== repository.toLowerCase() ||
      !commitId.test(revision)) throw new Error('Delivery source identity did not match');
  async function objects(version, names) {
    const tree = (await git('ls-tree','-z',version,'--',...names)).toString().split('\0');
    return names.map(name => {
      const object = tree.find(line => line.endsWith('\t' + name))?.split('\t')[0];
      if (!/^100(?:644|755) blob (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object ?? '')) throw new Error('Delivery record is not a file');
      return object.split(' ')[2];
    });
  }
  async function files(version, names) {
    return Promise.all((await objects(version,names)).map(object => git('cat-file','blob',object)));
  }
  return {repository, revision, git, files, objects};
}

function originalPlan(text) {
  const header = /^## 当初見積もり（(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) JST、実装前）\r?\n/m.exec(text);
  if (!header) throw new Error('No original estimate');
  const section = text.slice(header.index + header[0].length).split(/^## /m, 1)[0];
  const estimate = /^\| 初回提供の経過時間 \| (\d+(?:\.\d+)?)h \| (\d+(?:\.\d+)?)h \| (\d+(?:\.\d+)?)h \|\r?$/m.exec(section);
  if (!estimate) throw new Error('No first usable estimate');
  const [optimistic, standard, cautious] = estimate.slice(1).map(value => Number(value) * 60);
  const baselineRecordedAt = iso(header[1] + 'T' + header[2] + ':00+09:00');
  if (!baselineRecordedAt || ![optimistic, standard, cautious].every(Number.isSafeInteger) ||
      optimistic <= 0 || optimistic > standard || standard > cautious) throw new Error('Invalid original estimate');
  return {baselineRecordedAt, baselineMinutes:{optimistic,standard,cautious},
    originalFullForecast:/^全体の条件付き予測は[^\r\n]{1,640}$/m.exec(section)?.[0]};
}

async function integrationRecord(source, reader) {
  const {baselineCommit, observationCommit} = source;
  const {repository,revision,git,files} = reader;
  if (typeof baselineCommit !== 'string' || !commitId.test(baselineCommit) ||
      typeof observationCommit !== 'string' || !commitId.test(observationCommit)) throw new Error('Missing fixed delivery records');
  await Promise.all([git('merge-base','--is-ancestor',baselineCommit,observationCommit),
    git('merge-base','--is-ancestor',observationCommit,revision)]);
  const [[baseline], [evidence], [current], commitDate, initialCommitDate, evidenceCommitDate] = await Promise.all([
    files(baselineCommit,[timelinePath]), files(observationCommit,[firstReleasePath]), files(revision,[timelinePath]),
    git('show','-s','--format=%cI',revision), git('show','-s','--format=%cI',baselineCommit),
    git('show','-s','--format=%cI',observationCommit),
  ]);
  const plan = originalPlan(baseline.toString());
  const proof = JSON.parse(evidence);
  const start = iso(proof.goalStartedAt);
  const actualAt = iso(proof.firstUsableAt);
  const readbackAt = iso(proof.observedAt);
  const baselineSaved = iso(initialCommitDate.toString().trim());
  const evidenceSaved = iso(evidenceCommitDate.toString().trim());
  const elapsedSeconds = (Date.parse(actualAt) - Date.parse(start)) / 1000;
  if (!start || !actualAt || !readbackAt || !baselineSaved || !evidenceSaved ||
      plan.baselineRecordedAt < start || plan.baselineRecordedAt > baselineSaved || baselineSaved >= actualAt ||
      actualAt > readbackAt || readbackAt > evidenceSaved || !Number.isSafeInteger(elapsedSeconds) || elapsedSeconds <= 0 ||
      elapsedSeconds !== proof.elapsedToFirstUsableSeconds || proof.platform !== 'MacBook' ||
      proof.localReadback?.anonymousDataStatus !== 401 || proof.localReadback?.ownerSessionStatus !== 303) {
    throw new Error('First usable observation did not match the original timeline');
  }
  const latestSection = current.toString().trimEnd().split(/^#{2,3} [^\r\n]+\r?\n/m).at(-1);
  const nextItems = [...latestSection.matchAll(/^- 次は([^\r\n]*)\r?$/gm)].map(item => item[1].trim());
  const nextAction = nextItems.length === 1 && nextItems[0].length <= 360 ? nextItems[0] || undefined : undefined;
  return {observedAt:iso(commitDate.toString().trim()), nextAction,
    originalFullForecast:plan.originalFullForecast,
    firstUsable:{baselineRecordedAt:plan.baselineRecordedAt,baselineMinutes:plan.baselineMinutes,actualAt,elapsedSeconds,
      varianceSeconds:elapsedSeconds - plan.baselineMinutes.standard * 60},
    links:[link(repository,baselineCommit,timelinePath,'着手前の見積もり'),
      link(repository,observationCommit,firstReleasePath,'実際の初回提供'),
      link(repository,revision,timelinePath,'開発の進行記録')]};
}

async function environmentRecord(source, reader) {
  const {requirementsCommit} = source;
  const {repository,revision,git,files} = reader;
  if (typeof requirementsCommit !== 'string' || !commitId.test(requirementsCommit)) throw new Error('Missing original requirements');
  await git('merge-base','--is-ancestor',requirementsCommit,revision);
  const [[owner,evidence],[original]] = await Promise.all([files(revision,[ownerPath,auditPath]), files(requirementsCommit,[ownerPath])]);
  const audit = JSON.parse(evidence);
  const observedAt = iso(audit.audit_at);
  const sections = audit.requirements;
  if (audit.schema_version !== 1 || audit.goal_complete !== true || audit.overall_status !== 'ACCEPTED_ALL_ORIGINAL_REQUIREMENTS' ||
      audit.functional_acceptance !== 'ACCEPTED_BOTH_HOSTS_WITH_EXPLICIT_LIMITATIONS' || !observedAt ||
      audit.original_requirements?.verbatim_body_match !== true || !owner.equals(original) ||
      audit.original_requirements.sha256 !== createHash('sha256').update(owner).digest('hex') ||
      typeof audit.auditor_independence !== 'string' || !audit.auditor_independence.trim() ||
      !Array.isArray(audit.remaining_material_conditions) || audit.remaining_material_conditions.length !== 0 ||
      !Array.isArray(sections) || sections.length !== 12 ||
      !sections.every((section,index) => section?.section === index+1 && accepted.has(section.status) &&
        Array.isArray(section.proven) && section.proven.length > 0 && Array.isArray(section.evidence) && section.evidence.length > 0)) {
    throw new Error('The independent audit did not cover its original request');
  }
  return {observedAt,audit:{accepted:sections.length,total:sections.length,unit:'節'},
    links:[link(repository,requirementsCommit,ownerPath,'所有者の原要求'), link(repository,revision,auditPath,'独立最終監査')]};
}

function hasOwnerRequestAnchor(source) {
  return typeof source.ownerRequestRevision === 'string' && commitId.test(source.ownerRequestRevision) &&
    typeof source.ownerRequestSha256 === 'string' && contentDigest.test(source.ownerRequestSha256);
}

export async function readDeliveryRecord(source) {
  const kind = source?.kind;
  const scope = typeof kind === 'string' && Object.hasOwn(recordScope,kind) ? recordScope[kind] : null;
  if (!scope) return null;
  const integration = kind === 'integration-milestone';
  const requirementsReview = integration && hasOwnerRequestAnchor(source);
  try {
    const reader = await openSource(source);
    const record = integration ? await integrationRecord(source,reader) : await environmentRecord(source,reader);
    return {status:'current', scope, ...(requirementsReview && {requirementsReview, requirementsRevision:reader.revision}), ...record};
  } catch {
    return {status:'unavailable', scope, ...(requirementsReview && {requirementsReview}), observedAt:null, links:[]};
  }
}

export async function readExecutionEstimateSource(source, projectId) {
  try {
    const reader = await openSource(source);
    const {repository, revision} = reader;
    const [timeline] = await reader.files(revision,[timelinePath]);
    const text = timeline.toString('utf8');
    const fences = [...text.matchAll(/^```route-estimates[ \t]*\r?$/gm)];
    const blocks = [...text.matchAll(/^```route-estimates[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
    if (fences.length !== blocks.length) throw new Error('Incomplete route estimate');
    const rows = blocks.flatMap(match=>{
      const items = JSON.parse(match[1]);
      if (!Array.isArray(items) || items.some(item=>typeof item?.project !== 'string')) throw new Error('Invalid route estimate');
      return items.filter(item=>item.project === projectId);
    });
    if (rows.length > 256 || rows.some(row=>!Array.isArray(row.evidence) || !row.evidence.length ||
      row.evidence.length > 8 || row.evidence.some(name=>typeof name !== 'string' || !evidenceName.test(name)))) {
      throw new Error('Route estimate evidence is invalid');
    }
    const evidence = new Set(rows.flatMap(row=>row.evidence));
    if (evidence.size) await reader.objects(revision,[...evidence].map(file=>initiative+'/'+file));
    return {rows:rows.map(row=>({...row,links:[link(repository,revision,timelinePath,'記録済みの見積もり'),
      ...row.evidence.map(file=>link(repository,revision,initiative+'/'+file,file))]})),unavailable:false};
  } catch {
    return {rows:[],unavailable:true};
  }
}

export async function readPortfolioTaskRecords(source) {
  try {
    const reader = await openSource(source);
    const [file] = await reader.files(reader.revision, [portfolioObservationPath]);
    const observation = JSON.parse(file).taskProgress;
    const observedAt = iso(observation?.observedAt);
    const records = observation?.projects;
    if (!observedAt || !Array.isArray(records) || records.length > 250) return null;
    const projects = new Map();
    for (const record of records) {
      const repository = gitHubRepository(record?.repository)?.toLowerCase();
      if (!repository || projects.has(repository) || !Array.isArray(record.tasks)) return null;
      projects.set(repository, {...record, observationAt: iso(record.observationAt) ?? observedAt});
    }
    return {observedAt, projects, source: link(reader.repository, reader.revision, portfolioObservationPath, '案件の観測記録')};
  } catch { return null; }
}

const lifecycleStateFile = '.codex/autonomy-state.json';
const lifecycleStates = new Set(['active','paused','cancelled','awaiting_approval','resource_limited','blocked','complete']);
const lifecycleTaskStates = new Set(['pending','running','verified','failed','blocked']);
const lifecycleId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function lifecyclePathValid(file) {
  return typeof file==='string' && file.length<=240 && file.split('/').every(part=>
    part!=='.' && part!=='..' && /^[A-Za-z0-9._-]+$/.test(part) && !/^\.env(?:\.|$)|\.(?:key|pem|pfx|p12)$/i.test(part));
}

export async function readProjectForecastState(checkout, repository) {
  if (!checkout || !repository) return null;
  try {
    const folder = await lstat(join(checkout,'.codex'));
    if (!folder.isDirectory() || folder.isSymbolicLink()) return null;
    const file = await lstat(join(checkout,lifecycleStateFile));
    if (!file.isFile() || file.size>128*1024) return null;
    const reader = await openSource({checkout,repository,ref:'HEAD'},{allowHead:true});
    const [bytes] = await reader.files(reader.revision,[lifecycleStateFile]);
    if (bytes.length>128*1024) return null;
    const state = JSON.parse(bytes);
    if (state?.version!==1 || !lifecycleStates.has(state.status) || typeof state.goal?.title!=='string' ||
        !Array.isArray(state.tasks) || state.tasks.length>64 || state.tasks.some(task=>!lifecycleId.test(task?.id??'') ||
          !lifecycleTaskStates.has(task.status) || typeof task.actionable!=='boolean' ||
          !Array.isArray(task.depends_on) || task.depends_on.length>64)) return null;
    if (state.source) {
      if (!lifecyclePathValid(state.source.path) || !contentDigest.test(state.source.sha256??'')) return null;
      const [canonical] = await reader.files(reader.revision,[state.source.path]);
      if (createHash('sha256').update(canonical).digest('hex')!==state.source.sha256) return null;
    }
    const validEvidence = task=>Array.isArray(task.evidence) && task.evidence.length>0 && task.evidence.length<=8 &&
      task.evidence.every(item=>lifecyclePathValid(item?.path) && contentDigest.test(item?.sha256??''));
    const verification = state.tasks.filter(task=>task.status==='verified' && validEvidence(task));
    const names = [...new Set(verification.flatMap(task=>task.evidence.map(item=>item.path)))].slice(0,24);
    const proof = new Map(await Promise.all(names.map(async name=>{
      try {
        const [content] = await reader.files(reader.revision,[name]);
        return [name,createHash('sha256').update(content).digest('hex')];
      } catch { return [name,null]; }
    })));
    const verifiedTaskIds = new Set(verification.filter(task=>task.evidence.every(item=>
      proof.get(item.path)===item.sha256)).map(task=>task.id));
    const planning = Array.isArray(state.delivery?.tasks) ? state.delivery.tasks.slice(0,64) : [];
    const byId = new Map(planning.filter(task=>lifecycleId.test(task?.id??'')).map(task=>[task.id,task]));
    const tasks = state.tasks.map(task=>({...byId.get(task.id),id:task.id,title:byId.get(task.id)?.title??task.title,
      status:task.status==='running'?'active':task.status,actionable:task.actionable,dependencies:task.depends_on}));
    const [committedAt] = await Promise.all([reader.git('show','-s','--format=%cI',reader.revision)]);
    return {delivery:{...state.delivery,tasks,goal:state.goal.title,goalId:state.goal.id,
      observationAt:iso(state.delivery?.observationAt)??iso(committedAt.toString().trim())},
      nextAction:state.next_action,status:state.status,verifiedTaskIds,
      source:link(reader.repository,reader.revision,lifecycleStateFile,'案件の保存済み進行状態')};
  } catch { return null; }
}
export function tasksForRepository(observation, repository) {
  return observation?.projects.get(gitHubRepository(repository)?.toLowerCase()) ?? null;
}

function isSourceReference(text) {
  return /^https:\/\/\S+$/.test(text) || /^(?:一次資料|参考一次資料)（.+）：$/.test(text) ||
    /^(?:共通開発環境|GORIQ|統合管理構想)：https:\/\/\S+$/.test(text);
}

async function requirementSections(reader, report, owner) {
  let section = {id:'source-intro',title:'所有者の指示',rows:[]};
  const sections = [section];
  const counts = {total:0,verified:0,partial:0,open:0,blocked:0,reference:0};
  const evidencePaths = new Set();
  const source = link(reader.repository,report.ownerRevision,ownerRequestPath,'所有者の原文');
  for (const [index,raw] of owner.toString('utf8').split(/\r?\n/).entries()) {
    const text = raw.trim();
    if (!text) continue;
    const line = index + 1;
    const heading = /^#{1,6}\s+(.+)$/.exec(text);
    if (heading) {
      section = {id:'source-' + line,title:heading[1],rows:[]};
      sections.push(section);
      continue;
    }
    const row = report.rows[counts.total];
    if (row?.line !== line || !coverageStatuses.includes(row.status) ||
        (row.status === 'reference') !== isSourceReference(text) ||
        typeof row.note !== 'string' || row.note.trim().length < 2 || row.note.length > 220 ||
        !Array.isArray(row.evidence) || row.evidence.length > 8 || new Set(row.evidence).size !== row.evidence.length ||
        row.evidence.some(name => typeof name !== 'string' || !evidenceName.test(name)) ||
        (['verified','partial'].includes(row.status) && !row.evidence.length)) throw new Error('Missing or invalid requirement evidence');
    const evidence = row.evidence.map(name => {
      const file = initiative + '/' + name;
      evidencePaths.add(file);
      return link(reader.repository,report.evidenceRevision,file,name);
    });
    section.rows.push({line,status:row.status,note:row.note,sourceUrl:source.url + '#L' + line,evidence});
    counts.total++;
    counts[row.status]++;
  }
  if (!counts.total || counts.total !== report.rows.length) throw new Error('Incomplete requirement coverage');
  if (evidencePaths.size) await reader.objects(report.evidenceRevision,[...evidencePaths]);
  return {status:'current', ownerUrl:source.url, counts, sections:sections.filter(item=>item.rows.length)};
}

export async function readOwnerRequirementCoverage(source) {
  if (source?.kind !== 'integration-milestone' || !hasOwnerRequestAnchor(source)) return {status:'unavailable'};
  try {
    const reader = await openSource(source);
    const [owner, bytes] = await reader.files(reader.revision,[ownerRequestPath,ownerCoveragePath]);
    const report = JSON.parse(bytes);
    if (report.schemaVersion !== 1 || report.ownerRevision !== source.ownerRequestRevision ||
        report.ownerSha256 !== source.ownerRequestSha256 ||
        typeof report.evidenceRevision !== 'string' || !commitId.test(report.evidenceRevision) ||
        report.ownerSha256 !== createHash('sha256').update(owner).digest('hex') ||
        !Array.isArray(report.rows) || report.rows.length > 400) throw new Error('Invalid owner coverage record');
    const [[original]] = await Promise.all([reader.files(report.ownerRevision,[ownerRequestPath]),
      reader.git('merge-base','--is-ancestor',report.ownerRevision,report.evidenceRevision),
      reader.git('merge-base','--is-ancestor',report.evidenceRevision,reader.revision)]);
    if (!original.equals(owner)) throw new Error('The owner request changed since its recorded audit');
    return await requirementSections(reader,report,owner);
  } catch {
    return {status:'unavailable'};
  }
}
