import {execFile, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {lstat, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, join, normalize} from 'node:path';
import {promisify} from 'node:util';
import {readBoundedWorkspaceFile, readOnlyGitInvocation, readOnlyGitOutput} from './api-workspace.mjs';

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
const evidenceBytes = 256 * 1024;
const timelineBytes = 4 * 1024 * 1024;

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

async function checkCheckout(checkout) {
  if (typeof checkout !== 'string' || !isAbsolute(checkout) || normalize(checkout) !== checkout) {
    throw new Error('Invalid delivery checkout');
  }
  const owner = process.getuid?.();
  const info = await lstat(checkout);
  if (!info.isDirectory() || (owner !== undefined && info.uid !== owner) || normalize(await realpath(checkout)) !== checkout) {
    throw new Error('Invalid delivery checkout');
  }
}

async function openSource(source, {allowHead=false, localOnly=false} = {}) {
  const {checkout, ref} = source;
  const repository = gitHubRepository(source.repository);
  if ((!repository && !localOnly) || typeof ref !== 'string' ||
      (!(allowHead && ref==='HEAD') && !sourceRef.test(ref)) || ref.includes('..') || ref.endsWith('/')) throw new Error('Invalid delivery source');
  await checkCheckout(checkout);
  const signal = AbortSignal.timeout(4000);
  async function git(...arguments_) {
    const command = readOnlyGitInvocation(checkout, arguments_);
    return (await cli(command.executable, command.args, {env:command.env, signal, encoding:'buffer',
      timeout:3000, maxBuffer:evidenceBytes})).stdout;
  }
  const root = await git('rev-parse','--show-toplevel');
  if (normalize(root.toString().trim()) !== checkout) throw new Error('Delivery source identity did not match');
  const [origin, selected] = await Promise.all([localOnly ? null : git('config','--local','--get','remote.origin.url'),
    git('rev-parse','--verify',ref + '^{commit}')]);
  const revision = selected.toString().trim();
  if ((!localOnly && gitHubRepository(origin.toString().trim())?.toLowerCase() !== repository.toLowerCase()) ||
      !commitId.test(revision)) throw new Error('Delivery source identity did not match');
  async function treeEntries(version, names, includeSize = false) {
    const flags = includeSize ? ['-l','-z'] : ['-z'];
    const tree = (await git('ls-tree',...flags,version,'--',...names)).toString().split('\0');
    return names.map(name => {
      const entry = tree.find(line => line.indexOf('\t') >= 0 && line.slice(line.indexOf('\t') + 1) === name);
      const match = /^100(?:644|755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)(?: +(\d+))?$/.exec(entry?.split('\t',1)[0] ?? '');
      if (!match) throw new Error('Delivery record is not a file');
      return {oid:match[1],size:Number(match[2])};
    });
  }
  async function objects(version, names) {
    return (await treeEntries(version,names)).map(entry => entry.oid);
  }
  async function files(version, names) {
    return Promise.all((await objects(version,names)).map(object => git('cat-file','blob',object)));
  }
  async function* timelineLines() {
    const [{oid,size}] = await treeEntries(revision,[timelinePath],true);
    if (!Number.isSafeInteger(size) || size < 0 || size > timelineBytes) throw new Error('Invalid delivery timeline size');
    const decoder = new TextDecoder('utf-8',{fatal:true});
    let sizeRead = 0;
    let remainder = '';
    for await (const chunk of readOnlyGitOutput(checkout,['cat-file','blob',oid],signal)) {
      sizeRead += chunk.length;
      if (sizeRead > size) throw new Error('Delivery timeline did not match its Git blob');
      const lines = (remainder + decoder.decode(chunk,{stream:true})).split('\n');
      remainder = lines.pop();
      if (remainder.length > evidenceBytes) throw new Error('Delivery timeline line is too long');
      for (const line of lines) {
        if (line.length > evidenceBytes) throw new Error('Delivery timeline line is too long');
        yield line.endsWith('\r') ? line.slice(0,-1) : line;
      }
    }
    if (sizeRead !== size) throw new Error('Delivery timeline did not match its Git blob');
    const tail = remainder + decoder.decode();
    if (tail) yield tail.endsWith('\r') ? tail.slice(0,-1) : tail;
  }
  return {repository, revision, git, files, objects, timelineLines};
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
  const [[baseline], [evidence], nextAction, commitDate, initialCommitDate, evidenceCommitDate] = await Promise.all([
    files(baselineCommit,[timelinePath]), files(observationCommit,[firstReleasePath]), latestTimelineAction(reader),
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
  return {observedAt:iso(commitDate.toString().trim()), nextAction,
    originalFullForecast:plan.originalFullForecast,
    firstUsable:{baselineRecordedAt:plan.baselineRecordedAt,baselineMinutes:plan.baselineMinutes,actualAt,elapsedSeconds,
      varianceSeconds:elapsedSeconds - plan.baselineMinutes.standard * 60},
    links:[link(repository,baselineCommit,timelinePath,'着手前の見積もり'),
      link(repository,observationCommit,firstReleasePath,'実際の初回提供'),
      link(repository,revision,timelinePath,'開発の進行記録')]};
}

async function latestTimelineAction(reader) {
  let count = 0;
  let next;
  for await (const line of reader.timelineLines()) {
    if (/^#{2,3} .+$/.test(line)) {
      count = 0;
      next = undefined;
    } else if (line.startsWith('- 次は')) {
      count++;
      next = line.slice('- 次は'.length).trim();
    }
  }
  return count === 1 && next && next.length <= 360 ? next : undefined;
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

export async function readChatProjectRecord(source) {
  if (!source) return null;
  const reader = await openSource(source);
  const {repository,revision,git,files} = reader;
  const pinned = (version,file) => ({url:link(repository,version,file,'').url,revision:version});
  if (source.kind === 'integration-milestone' && hasOwnerRequestAnchor(source)) {
    const original = source.ownerRequestRevision;
    const [[owner],[current],nextAction] = await Promise.all([
      files(original,[ownerRequestPath]),files(revision,[ownerRequestPath]),latestTimelineAction(reader),
      git('merge-base','--is-ancestor',original,revision),
    ]);
    const sha256 = createHash('sha256').update(owner).digest('hex');
    if (!owner.equals(current) || sha256 !== source.ownerRequestSha256) throw new Error('The original requirements changed');
    return {requirements:{...pinned(original,ownerRequestPath),sha256},
      progress:{...pinned(revision,timelinePath),
        ...(nextAction && !/[\p{Cc}\p{Cf}]/u.test(nextAction) && {nextAction})}};
  }
  if (source.kind === 'environment-audit') {
    await environmentRecord(source,reader);
    const [owner] = await files(source.requirementsCommit,[ownerPath]);
    return {requirements:{...pinned(source.requirementsCommit,ownerPath),sha256:createHash('sha256').update(owner).digest('hex')},
      progress:pinned(revision,auditPath)};
  }
  throw new Error('No verified project record');
}

export function chatProjectRecordIsCurrent(source, record) {
  if (!source) return record === null;
  if (!record || typeof source.ref !== 'string' || !sourceRef.test(source.ref) ||
      source.ref.includes('..') || source.ref.endsWith('/')) return false;
  try {
    const command = readOnlyGitInvocation(source.checkout,['rev-parse','--verify',source.ref+'^{commit}']);
    return execFileSync(command.executable,command.args,{env:command.env,stdio:['ignore','pipe','ignore'],
      encoding:'utf8',timeout:1500,maxBuffer:1024,windowsHide:true}).trim() === record.progress.revision;
  } catch { return false; }
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
    const rows = [];
    let block = null;
    let blockBytes = 0;
    for await (const line of reader.timelineLines()) {
      if (/^```route-estimates[ \t]*$/.test(line)) {
        if (block) throw new Error('Incomplete route estimate');
        block = [];
        blockBytes = 0;
      } else if (block && /^```[ \t]*$/.test(line)) {
        const items = JSON.parse(block.join('\n'));
        if (!Array.isArray(items) || items.some(item => typeof item?.project !== 'string')) throw new Error('Invalid route estimate');
        rows.push(...items.filter(item => item.project === projectId));
        if (rows.length > 256) throw new Error('Too many route estimates');
        block = null;
      } else if (block) {
        blockBytes += Buffer.byteLength(line) + 1;
        if (blockBytes > evidenceBytes) throw new Error('Route estimate block is too large');
        block.push(line);
      }
    }
    if (block) throw new Error('Incomplete route estimate');
    if (rows.some(row=>!Array.isArray(row.evidence) || !row.evidence.length ||
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
    const localRecords = observation?.localProjects ?? [];
    if (!observedAt || !Array.isArray(records) || !Array.isArray(localRecords) || records.length + localRecords.length > 250) return null;
    const projects = new Map();
    for (const record of records) {
      const repository = gitHubRepository(record?.repository)?.toLowerCase();
      if (!repository || record.localProjectId !== undefined || projects.has(repository) || !Array.isArray(record.tasks)) return null;
      projects.set(repository, {...record, observationAt: iso(record.observationAt) ?? observedAt});
    }
    for (const record of localRecords) {
      const id = record?.localProjectId;
      if (typeof id !== 'string' || !lifecycleId.test(id) || id.length > 80 || record.repository !== undefined ||
          projects.has(id) || !Array.isArray(record.tasks)) return null;
      projects.set(id, {...record, observationAt: iso(record.observationAt) ?? observedAt});
    }
    return {observedAt, projects, source: link(reader.repository, reader.revision, portfolioObservationPath, '案件の観測記録')};
  } catch { return null; }
}

const lifecycleStateFile = '.codex/autonomy-state.json';
const lifecycleStates = new Set(['active','paused','cancelled','awaiting_approval','resource_limited','blocked','complete']);
const lifecycleTaskStates = new Set(['pending','running','verified','failed','blocked']);
const lifecycleId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const lifecycleStateLimit = 128 * 1024;
const lifecycleEvidenceLimit = 256 * 1024;
const lifecycleSourceLimit = 8 * 1024 * 1024;
const lifecycleFileStats = {bigint:true,throwIfNoEntry:false};
const lifecycleHolds = new Map([
  ['paused', 'paused'], ['cancelled', 'blocked'], ['blocked', 'blocked'],
  ['awaiting_approval', 'approval'], ['resource_limited', 'limit'], ['complete', 'complete'],
]);

function validLifecycleState(state) {
  return state?.version === 1 && lifecycleStates.has(state.status) && typeof state.goal?.title === 'string' &&
    Array.isArray(state.tasks) && state.tasks.length <= 64 && state.tasks.every(task =>
      lifecycleId.test(task?.id ?? '') && lifecycleTaskStates.has(task.status) && typeof task.actionable === 'boolean' &&
      Array.isArray(task.depends_on) && task.depends_on.length <= 64);
}

const sameEntry = (left, right) => right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;

function readLifecycleSnapshot(checkout, filename, maxBytes) {
  const folder = dirname(filename);
  const uid = process.getuid?.();
  const owned = stat => uid === undefined || stat.uid === BigInt(uid);
  const root = lstatSync(checkout, lifecycleFileStats);
  if (!root) throw new Error('Lifecycle checkout is unavailable');
  if (!root.isDirectory() || !owned(root) || normalize(realpathSync(checkout)) !== checkout) {
    throw new Error('Invalid lifecycle checkout');
  }
  const parent = lstatSync(folder, lifecycleFileStats);
  if (!parent) return null;
  if (!parent.isDirectory() || !owned(parent) || normalize(realpathSync(folder)) !== folder) {
    throw new Error('Invalid lifecycle folder');
  }
  const entry = lstatSync(filename, lifecycleFileStats);
  if (!entry) return null;
  if (!entry.isFile() || entry.nlink !== 1n || !owned(entry) || entry.size > BigInt(maxBytes) ||
      normalize(realpathSync(filename)) !== filename) throw new Error('Invalid lifecycle file');
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, lifecycleFileStats);
    if (!before.isFile() || before.nlink !== 1n || !sameEntry(entry, before) || before.size !== entry.size ||
        before.ctimeNs !== entry.ctimeNs) throw new Error('Lifecycle file changed');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    const after = lstatSync(filename, lifecycleFileStats);
    if (BigInt(size) !== before.size || !sameEntry(before, after) || !after.isFile() || after.nlink !== 1n ||
        after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs || after.size !== before.size ||
        !sameEntry(root, lstatSync(checkout, lifecycleFileStats)) || !sameEntry(parent, lstatSync(folder, lifecycleFileStats)) ||
        normalize(realpathSync(filename)) !== filename) throw new Error('Lifecycle file changed');
    return buffer.subarray(0,size);
  } finally { closeSync(fd); }
}

// A saved stop stays in force even if its optional forecast source has moved.
export function readProjectLifecycleHold(checkout, {verifySource = true} = {}) {
  if (typeof checkout !== 'string' || !isAbsolute(checkout) || normalize(checkout) !== checkout) return 'unverified';
  try {
    const statePath = join(checkout,lifecycleStateFile);
    const bytes = readLifecycleSnapshot(checkout,statePath,lifecycleStateLimit);
    if (!bytes) return null;
    const state = JSON.parse(bytes);
    if (!validLifecycleState(state) || typeof state.goal.id !== 'string' || !lifecycleId.test(state.goal.id)) return 'unverified';
    const hold = lifecycleHolds.get(state.status);
    if (hold) return hold;
    if (verifySource && state.source !== undefined) {
      if (!state.source || !lifecyclePathValid(state.source.path) ||
          typeof state.source.sha256 !== 'string' || !contentDigest.test(state.source.sha256)) return 'unverified';
      const source = readLifecycleSnapshot(checkout,join(checkout,state.source.path),lifecycleSourceLimit);
      if (!source || createHash('sha256').update(source).digest('hex') !== state.source.sha256 ||
          !bytes.equals(readLifecycleSnapshot(checkout,statePath,lifecycleStateLimit) ?? Buffer.alloc(0))) return 'unverified';
    }
    return null;
  } catch { return 'unverified'; }
}

function lifecyclePathValid(file) {
  return typeof file==='string' && file.length<=240 && file.split('/').every(part=>
    part!=='.' && part!=='..' && /^[A-Za-z0-9._-]+$/.test(part) &&
    !/\.$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    !/^(?:\.git$|\.env(?:\.|$))|\.(?:key|pem|pfx|p12)$/i.test(part));
}

async function isUnversionedWorkspace(checkout) {
  await checkCheckout(checkout);
  for (let directory = checkout; ; directory = dirname(directory)) {
    try {
      await lstat(join(directory,'.git'));
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(directory) === directory) return true;
  }
}

export async function readProjectForecastState(checkout, repository) {
  if (!checkout) return null;
  const localOnly = repository == null;
  try {
    const folder = await lstat(join(checkout,'.codex'));
    if (!folder.isDirectory() || folder.isSymbolicLink()) return null;
    const file = await lstat(join(checkout,lifecycleStateFile));
    if (!file.isFile() || file.size>lifecycleStateLimit) return null;
    const unversioned = localOnly && await isUnversionedWorkspace(checkout);
    const reader = unversioned ? null : await openSource({checkout,repository,ref:'HEAD'},{allowHead:true,localOnly});
    async function read(name, maxBytes = lifecycleEvidenceLimit) {
      if (unversioned) {
        if (!await isUnversionedWorkspace(dirname(join(checkout,name)))) throw new Error('Workspace evidence crosses a Git boundary');
        return readBoundedWorkspaceFile(checkout,name,maxBytes);
      }
      const [content] = await reader.files(reader.revision,[name]);
      if (content.length > maxBytes) throw new Error('Workspace evidence exceeds its size limit');
      return content;
    }
    const bytes = await read(lifecycleStateFile,lifecycleStateLimit);
    const state = JSON.parse(bytes);
    if (!validLifecycleState(state)) return null;
    if (state.source) {
      if (!lifecyclePathValid(state.source.path) || !contentDigest.test(state.source.sha256??'')) return null;
      const canonical = await read(state.source.path);
      if (createHash('sha256').update(canonical).digest('hex')!==state.source.sha256) return null;
    }
    const validEvidence = task=>Array.isArray(task.evidence) && task.evidence.length>0 && task.evidence.length<=8 &&
      task.evidence.every(item=>lifecyclePathValid(item?.path) && contentDigest.test(item?.sha256??''));
    const verification = state.tasks.filter(task=>task.status==='verified' && validEvidence(task));
    const names = [...new Set(verification.flatMap(task=>task.evidence.map(item=>item.path)))].slice(0,24);
    const proof = new Map(await Promise.all(names.map(async name=>{
      try {
        const content = await read(name);
        return [name,createHash('sha256').update(content).digest('hex')];
      } catch { return [name,null]; }
    })));
    const verifiedTaskIds = new Set(verification.filter(task=>task.evidence.every(item=>
      proof.get(item.path)===item.sha256)).map(task=>task.id));
    const planning = Array.isArray(state.delivery?.tasks) ? state.delivery.tasks.slice(0,64) : [];
    const byId = new Map();
    for (const task of planning) if (lifecycleId.test(task?.id??'')) {
      byId.set(task.id,byId.has(task.id)?null:task);
    }
    const tasks = state.tasks.map(({evidence,depends_on,...task})=>({...byId.get(task.id),...task,
      status:task.status==='running'?'active':task.status,dependencies:depends_on}));
    if (unversioned && !bytes.equals(await read(lifecycleStateFile,lifecycleStateLimit))) return null;
    return {delivery:{...state.delivery,tasks,goal:state.goal.title,goalId:state.goal.id,
      observationAt:iso(state.delivery?.observationAt)},
      nextAction:state.next_action,status:state.status,verifiedTaskIds,
      source:localOnly ? {label:unversioned ? '作業先に保存した進行状態の照合値' : '作業先の保存済み進行状態',
        revision:reader?.revision ?? createHash('sha256').update(bytes).digest('hex')} :
        link(reader.repository,reader.revision,lifecycleStateFile,'案件の保存済み進行状態')};
  } catch { return null; }
}
export function tasksForProject(observation, projectId, repository) {
  const key = repository == null ? projectId : gitHubRepository(repository)?.toLowerCase();
  return observation?.projects.get(key) ?? null;
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
