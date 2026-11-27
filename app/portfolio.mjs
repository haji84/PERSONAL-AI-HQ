import {createHash, randomUUID} from 'node:crypto';
import {closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {lstat, realpath} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {deliveryProgress, remainingEstimate, requirementProgress, taskHasOpenWork, taskIsVerified} from './progress.mjs';
import {readDeliveryRecord, readPortfolioTaskRecords, tasksForRepository} from './delivery-records.mjs';
import {normalizeSettings} from './execution-policy.mjs';

export const projectKey = /^[a-z0-9][a-z0-9_.-]{0,79}$/i;
const requestKey = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const registrationFields = new Set(['requestId', 'name', 'goal', 'settings', 'githubProject']);
const portfolioBytes = 1024 ** 2;
const projectLimit = 250;
const registrationError = (status, message) => Object.assign(new Error(message), {status});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const orderedSettings = settings => ({...settings, stageRoutes:Object.fromEntries(Object.entries(settings.stageRoutes).sort())});
const states = new Set(['unknown', 'developing', 'researching', 'designing', 'verifying', 'fixing', 'integrating',
  'waiting', 'paused', 'approval', 'limit', 'blocked', 'completed', 'offline', 'delayed']);
const taskStates = new Set(['active', 'pending', 'waiting', 'blocked', 'paused', 'approval', 'verified']);
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const strings = (value, limit = 20) => Array.isArray(value) ? value.slice(0, limit).map(item => text(item)).filter(Boolean) : [];
const count = value => Number.isFinite(value) && value >= 0 ? value : null;
const rate = value => count(value) !== null && value <= 100 ? value : null;

function https(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function evidence(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 24).flatMap(row => {
    const label = text(row?.label, 240);
    return label ? [{label, url: https(row.url)}] : [];
  });
}

function apiCreditObservation(value) {
  const observedFrom = date(value?.observedFrom);
  const observedUntil = date(value?.observedUntil);
  const balanceUsd = count(value?.balanceUsd);
  if (!observedFrom || !observedUntil || Date.parse(observedUntil) < Date.parse(observedFrom) || balanceUsd === null ||
      typeof value.expiresOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.expiresOn) ||
      !Number.isFinite(Date.parse(value.expiresOn))) return null;
  return {balanceUsd, observedFrom, observedUntil, expiresOn: value.expiresOn};
}

function taskProgress(delivery) {
  const tasks = delivery?.tasks;
  if (!Array.isArray(tasks) || tasks.length > 400) return [];
  const ids = tasks.map(task => task?.id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !projectKey.test(id))) return [];
  const observedAt = date(delivery.observationAt);
  return tasks.map(task => {
    const counts = requirementProgress(task.requirements);
    const verified = taskIsVerified(task, counts);
    const progress = counts && (verified || counts.accepted < counts.total)
      ? {accepted:counts.accepted, total:counts.total, percent:counts.formalCompletion} : null;
    const rejectedCompletion = task.status === 'verified' && !verified;
    const status = rejectedCompletion || !taskStates.has(task.status) ? 'unknown' : task.status;
    const estimate = remainingEstimate(task.remainingMinutes);
    const remainingMinutes = verified ? {optimistic:0, standard:0, cautious:0} :
      estimate?.cautious === 0 && (rejectedCompletion || taskHasOpenWork(task)) ? null : estimate;
    const device = text(task.device, 60);
    return {id: task.id, title: text(task.title, 120) || task.id, status, progress, remainingMinutes,
      ...(device && {device}),
      observedAt: date(task.observedAt) ?? observedAt, remaining: strings(task.remaining),
      blocker: text(task.blocker, 360), externalWait: task.externalWait === 'unknown', evidence: evidence(task.evidence)};
  });
}

function normalizeProject(row, observedAt) {
  const {id} = row;
  const name = text(row.name, 100);
  if (typeof id !== 'string' || !projectKey.test(id) || !name) throw new Error('Invalid project');
  const declared = Array.isArray(row.cwd) ? row.cwd : [row.cwd];
  const cwd = [...new Set(declared.filter(value => typeof value === 'string' && isAbsolute(value)).map(value => resolve(value)))].slice(0, 12);
  const metrics = row.measurements ?? {};
  const delivery = row.delivery ? deliveryProgress(row.delivery) : null;
  const computed = delivery?.counts;
  const observed = date(row.observedAt) ?? observedAt;
  const stateScope = text(row.stateScope, 60);
  const age = Date.now() - Date.parse(observed);
  const live = age >= 0 && age <= 15 * 60 * 1000;
  const needsFreshObservation = ['developing', 'researching', 'designing', 'verifying', 'fixing', 'integrating'].includes(row.state);
  return {id, name, goal: text(row.goal, 1500), state: states.has(row.state) && (!needsFreshObservation || live) ? row.state : 'unknown',
    ...(stateScope && {stateScope}),
    observedAt: observed, summary: text(row.summary, 1200), remaining: strings(row.remaining), tasks: taskProgress(row.delivery),
    handoverRequirements: typeof row.handoverRequirements === 'string' && row.handoverRequirements.length <= 240 ? row.handoverRequirements : null,
    nativeHandover: row.nativeHandover ?? null,
    evidence: evidence(row.evidence), repository: https(row.repository), cwd, codexScopes: cwd.length,
    codexWrite: row.enableCodexWrite === true,
    ...(row.registrationRequestId && !cwd.length && {scopeRequired:true}),
    measurements: {formalCompletion: computed?.formalCompletion ?? rate(metrics.formalCompletion), verifiedCompletion: computed?.verifiedCompletion ?? rate(metrics.verifiedCompletion),
      usableCompletion: computed?.usableCompletion ?? rate(metrics.usableCompletion), implementationCompletion: computed?.implementationCompletion ?? rate(metrics.implementationCompletion),
      estimateFinish: delivery?.estimateFinish ?? date(metrics.estimateFinish), activeMinutes: delivery?.time?.activeMinutes ?? count(metrics.activeMinutes),
    },
    schedule: delivery && {originalDueAt: delivery.originalDueAt, estimatedFinish: delivery.estimateFinish, remainingMinutes: delivery.durations,
      forecastDeltaMinutes: delivery.forecastDeltaMinutes, delayed: delivery.delayed},
  };
}

async function normalizeArtifact(row, projects, observedAt) {
  if (typeof row?.id !== 'string' || !projectKey.test(row.id) || !projects.has(row.project) || !text(row.title)) return null;
  const info = {id: row.id, title: text(row.title, 160), project: row.project, kind: text(row.kind, 40),
    description: text(row.description), observedAt: date(row.observedAt) ?? observedAt};
  if (typeof row.file === 'string' && isAbsolute(row.file)) {
    try {
      const actual = await realpath(row.file);
      const stat = await lstat(actual);
      if (!stat.isFile()) return null;
      return {...info, file: actual, href: `/api/artifacts/file?id=${encodeURIComponent(row.id)}`};
    } catch { return null; }
  }
  const href = https(row.href);
  return href ? {...info, href} : null;
}

function definitionSnapshot(file) {
  let raw, bytes = null;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > portfolioBytes) throw new Error('Invalid portfolio file');
    bytes = readFileSync(file);
    if (bytes.length > portfolioBytes) throw new Error('Invalid portfolio file');
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    raw = {projects: [], artifacts: [], limits: ['案件の確認記録がありません。']};
  }
  if (!Array.isArray(raw?.projects) || raw.projects.length > projectLimit) throw new Error('Invalid portfolio');
  return {raw, bytes};
}

function readDefinition(directory) {
  return definitionSnapshot(join(directory, 'portfolio.json')).raw;
}

export function readCurrentProject(directory, id) {
  const raw = readDefinition(directory);
  const rows = raw.projects.filter(row => row?.id === id);
  return rows.length === 1 ? normalizeProject(rows[0], date(raw.observedAt)) : null;
}

export function readProjectInitialExecution(directory, id) {
  const rows = readDefinition(directory).projects.filter(row => row?.id === id);
  const row = rows.length === 1 ? rows[0] : null;
  if (!row || (row.registrationRequestId === undefined && row.initialExecution === undefined &&
      row.registrationFingerprint === undefined)) return null;
  const initial = row.initialExecution;
  try {
    if (typeof row.registrationRequestId === 'string' && requestKey.test(row.registrationRequestId) &&
        typeof row.registrationFingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.registrationFingerprint) &&
        date(initial?.updatedAt) && initial.settings && isDeepStrictEqual(normalizeSettings(initial.settings), initial.settings) &&
        initial.sha256 === digest([id, initial.updatedAt, orderedSettings(initial.settings)])) {
      return {updatedAt:initial.updatedAt, settings:initial.settings};
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  throw registrationError(409, 'この案件の初回実行設定を照合できません。');
}

function saveRegistration(file, before, raw) {
  const bytes = Buffer.from(JSON.stringify(raw, null, 2) + '\n');
  if (bytes.length > portfolioBytes) throw registrationError(409, '案件の保存領域に空きがありません。');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const output = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(output, bytes);
      fsyncSync(output);
    } finally { closeSync(output); }
    if (!isDeepStrictEqual(definitionSnapshot(file).bytes, before)) {
      throw registrationError(409, '案件の記録が更新されたため、確認してからもう一度登録してください。');
    }
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// The caller holds the existing SQLite writer lock while replacing the portfolio.
export function registerProject(directory, input, {github, hasSavedWork}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(field => !registrationFields.has(field)) ||
      typeof input.requestId !== 'string' || !requestKey.test(input.requestId)) {
    throw registrationError(400, '案件の登録内容を確認してください。');
  }
  const fromGithub = Object.hasOwn(input, 'githubProject');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  if ((fromGithub ? typeof input.githubProject !== 'string' || !/^github-[1-9][0-9]{0,15}$/.test(input.githubProject) ||
    Object.hasOwn(input, 'name') : !name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) ||
    (Object.hasOwn(input, 'goal') && (typeof input.goal !== 'string' || goal.length > 1500 || /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(goal)))) {
    throw registrationError(400, '案件名とGOALを確認してください。');
  }
  let settings;
  try { settings = normalizeSettings(input.settings); }
  catch { throw registrationError(400, '実行モード、指定経路、上限の組み合わせを確認してください。'); }

  const file = join(directory, 'portfolio.json');
  const {raw, bytes:before} = definitionSnapshot(file);
  const id = fromGithub ? input.githubProject : 'project-' + input.requestId;
  const fingerprint = digest([id, name, goal, orderedSettings(settings)]);
  const previous = raw.projects.filter(row => row?.registrationRequestId === input.requestId);
  if (previous.length) {
    const registered = previous[0];
    if (previous.length === 1 && registered.id === id && registered.registrationFingerprint === fingerprint) {
      return {id, created:false};
    }
    throw registrationError(409, 'この登録番号は別の案件または設定に使われています。');
  }
  if (raw.projects.some(row => row?.id?.toLowerCase() === id) ||
      (Array.isArray(raw.artifacts) && raw.artifacts.some(row => typeof row?.project === 'string' && row.project.toLowerCase() === id)) ||
      hasSavedWork(id)) {
    throw registrationError(409, 'この案件には既存の登録または実行記録があります。');
  }
  if (raw.projects.length >= projectLimit) throw registrationError(409, '登録できる案件数の上限に達しました。');
  const projects = raw.projects.map(row => normalizeProject(row, date(raw.observedAt)));
  const candidate = fromGithub && github?.view(projects, false)?.projects
    .find(project => project.id === id && project.registrationAvailable === true);
  if (fromGithub && !candidate) throw registrationError(409, 'GitHubで現在確認済みの登録候補を選んでください。');
  if (!fromGithub && projects.some(project => project.name.toLowerCase() === name.toLowerCase())) {
    throw registrationError(409, '同じ名前の案件が既に登録されています。');
  }

  const updatedAt = new Date().toISOString();
  const row = {id, name: candidate ? candidate.name : name, goal, state:'waiting', observedAt:updatedAt,
    ...(candidate && {repository:candidate.repository}), registrationRequestId:input.requestId, registrationFingerprint:fingerprint,
    initialExecution:{updatedAt, settings, sha256:digest([id, updatedAt, orderedSettings(settings)])}};
  const definition = before ? raw : {observedAt:updatedAt, artifacts:[]};
  saveRegistration(file, before, {...definition, projects:[...raw.projects, row]});
  return {id, created:true};
}

export function readProjectEstimateBinding(directory, id) {
  if (typeof id !== 'string' || !projectKey.test(id)) return null;
  const raw = readDefinition(directory);
  const rows = raw.projects.filter(row=>row?.id === id);
  if (rows.length !== 1) return null;
  const [row] = rows;
  return {
    source:row.deliverySource?.kind === 'integration-milestone' ? row.deliverySource : null,
    estimates:row.delivery?.estimates ?? [],
  };
}

export function readProjectDeliverySource(directory, id) {
  if (typeof id !== 'string' || !projectKey.test(id)) return null;
  const rows = readDefinition(directory).projects.filter(row => row?.id === id);
  return rows.length === 1 ? rows[0].deliverySource ?? null : null;
}

export async function readPortfolio(directory, githubProjects, refreshGithub = false) {
  const raw = readDefinition(directory);
  const observedAt = date(raw.observedAt);
  const projects = raw.projects.map(row => normalizeProject(row, observedAt));
  const byId = new Map(projects.map(row => [row.id, row]));
  if (projects.length !== byId.size) throw new Error('Duplicate project');
  const github = githubProjects?.view(projects, refreshGithub);
  const discovered = (github?.projects ?? []).map(row => ({...normalizeProject(row, observedAt), registration: 'github',
    registrationAvailable: row.registrationAvailable === true}));
  const related = raw.projects.filter(row => row.deliverySource).slice(0,8);
  const [deliveryEntries, taskRecords] = refreshGithub ? await Promise.all([
    Promise.all(related.map(async row => [row.id, await readDeliveryRecord(row.deliverySource)])),
    raw.taskProgressSource ? readPortfolioTaskRecords(raw.taskProgressSource) : null,
  ]) : [[], null];
  const deliveryRecords = new Map(deliveryEntries);
  const visible = [...projects, ...discovered];
  const taskMatches = new Map();
  for (const row of projects) {
    const record = tasksForRepository(taskRecords, row.repository);
    if (record) taskMatches.set(record, (taskMatches.get(record) ?? 0) + 1);
  }
  const unmatchedTaskRecords = [...(taskRecords?.projects.values() ?? [])].filter(record => taskMatches.get(record) !== 1).length;
  const rawArtifacts = Array.isArray(raw.artifacts) ? raw.artifacts.slice(0, 150) : [];
  const artifacts = (await Promise.all(rawArtifacts.map(row => normalizeArtifact(row, byId, observedAt)))).filter(Boolean);
  if (new Set(artifacts.map(row => row.id)).size !== artifacts.length) throw new Error('Duplicate artifact');
  const devices = Array.isArray(raw.devices) ? raw.devices.slice(0, 12).map(row => ({
    name: text(row?.name, 60), state: text(row?.state, 120), observedAt: date(row?.observedAt),
  })).filter(row => row.name) : [];
  const scope = strings(raw.limits, 24);
  return {
    projects: byId,
    discoveredProjects: new Set(discovered.map(row => row.id)),
    artifacts: new Map(artifacts.map(row => [row.id, row])),
    view: {observedAt, limits: scope, devices, apiCreditObservation: apiCreditObservation(raw.apiCreditObservation),
      ...(github && {githubRegistration: {status:github.status, observedAt:github.observedAt, count:github.count}}),
      ...(refreshGithub && raw.taskProgressSource && {taskProgressSource: taskRecords ?
        {status: 'current', observedAt: taskRecords.observedAt, evidence: taskRecords.source, unmatched: unmatchedTaskRecords} :
        {status: 'unavailable'}}),
      projects: visible.map(({cwd, handoverRequirements, nativeHandover, ...project}) => {
        const tracking = byId.has(project.id) && tasksForRepository(taskRecords, project.repository);
        if (!project.tasks.length && tracking && taskMatches.get(tracking) === 1) project.tasks = taskProgress(tracking);
        const deliveryRecord = deliveryRecords.get(project.id);
        if (deliveryRecord) {
          project.deliveryRecord = deliveryRecord;
          if (deliveryRecord.scope === '統合アプリの初回提供') {
            project.measurements = {...project.measurements, estimateFinish:project.schedule?.estimatedFinish ?? null};
          }
        }
        return project;
      }),
      artifacts: artifacts.map(({file, ...artifact}) => artifact)},
  };
}
