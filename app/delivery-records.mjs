import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';
import {isAbsolute, normalize} from 'node:path';
import {promisify} from 'node:util';
import {readOnlyGitInvocation} from './api-workspace.mjs';

const cli = promisify(execFile);
const initiative = 'docs/initiatives/chatgpt-codex-integration';
const timelinePath = initiative + '/DELIVERY.md';
const firstReleasePath = initiative + '/mac-first-release-observation.json';
const ownerPath = 'OWNER_REQUIREMENTS.md';
const auditPath = 'verification/final-shared-goal-audit.json';
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sourceRef = /^refs\/(?:heads|remotes\/origin)\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,179}$/;
const accepted = new Set(['ACCEPTED_RUNTIME_BOTH_HOSTS', 'PROVEN_WITH_LIMITS', 'PROVEN', 'PROVEN_WITH_SCOPE',
  'ACCEPTED', 'PROVEN_FOR_SCOPED_ARTIFACTS']);
const recordScope = {'integration-milestone':'統合アプリの初回提供', 'environment-audit':'共通開発環境の初期構築'};

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

async function openSource(source) {
  const {checkout, ref} = source;
  const repository = gitHubRepository(source.repository);
  if (!repository || typeof checkout !== 'string' || !isAbsolute(checkout) || normalize(checkout) !== checkout ||
      typeof ref !== 'string' || !sourceRef.test(ref) || ref.includes('..') || ref.endsWith('/')) throw new Error('Invalid delivery source');
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
  async function files(version, names) {
    const tree = (await git('ls-tree','-z',version,'--',...names)).toString().split('\0');
    return Promise.all(names.map(name => {
      const object = tree.find(line => line.endsWith('\t' + name))?.split('\t')[0];
      if (!/^100(?:644|755) blob (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object ?? '')) throw new Error('Delivery record is not a file');
      return git('cat-file','blob',object.split(' ')[2]);
    }));
  }
  return {repository, revision, git, files};
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

export async function readDeliveryRecord(source) {
  const kind = source?.kind;
  const scope = typeof kind === 'string' && Object.hasOwn(recordScope,kind) ? recordScope[kind] : null;
  if (!scope) return null;
  try {
    const reader = await openSource(source);
    const record = kind === 'integration-milestone' ? await integrationRecord(source,reader) : await environmentRecord(source,reader);
    return {status:'current', scope, ...record};
  } catch {
    return {status:'unavailable', scope, observedAt:null, links:[]};
  }
}
