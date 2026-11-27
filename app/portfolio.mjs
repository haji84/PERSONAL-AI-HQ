import {lstatSync, readFileSync} from 'node:fs';
import {lstat, realpath} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {deliveryProgress} from './progress.mjs';
import {readDeliveryRecord} from './delivery-records.mjs';

export const projectKey = /^[a-z0-9][a-z0-9_.-]{0,79}$/i;
const states = new Set(['unknown', 'developing', 'researching', 'designing', 'verifying', 'fixing', 'integrating',
  'waiting', 'paused', 'approval', 'limit', 'blocked', 'completed', 'offline', 'delayed']);
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
  const live = observed && Date.now() - Date.parse(observed) <= 15 * 60 * 1000;
  const needsFreshObservation = ['developing', 'researching', 'designing', 'verifying', 'fixing', 'integrating'].includes(row.state);
  return {id, name, goal: text(row.goal, 1500), state: states.has(row.state) && (!needsFreshObservation || live) ? row.state : 'unknown',
    observedAt: observed, summary: text(row.summary, 1200), remaining: strings(row.remaining),
    handoverRequirements: typeof row.handoverRequirements === 'string' && row.handoverRequirements.length <= 240 ? row.handoverRequirements : null,
    nativeHandover: row.nativeHandover ?? null,
    evidence: evidence(row.evidence), repository: https(row.repository), cwd, codexScopes: cwd.length,
    codexWrite: row.enableCodexWrite === true,
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

function readDefinition(directory) {
  const file = join(directory, 'portfolio.json');
  let raw;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 ** 2) throw new Error('Invalid portfolio file');
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    raw = {projects: [], artifacts: [], limits: ['案件の確認記録がありません。']};
  }
  if (!Array.isArray(raw.projects) || raw.projects.length > 250) throw new Error('Invalid portfolio');
  return raw;
}

export function readCurrentProject(directory, id) {
  const raw = readDefinition(directory);
  const rows = raw.projects.filter(row => row?.id === id);
  return rows.length === 1 ? normalizeProject(rows[0], date(raw.observedAt)) : null;
}

export async function readPortfolio(directory, githubProjects, refreshGithub = false) {
  const raw = readDefinition(directory);
  const observedAt = date(raw.observedAt);
  const projects = raw.projects.map(row => normalizeProject(row, observedAt));
  const byId = new Map(projects.map(row => [row.id, row]));
  if (projects.length !== byId.size) throw new Error('Duplicate project');
  const github = githubProjects?.view(projects, refreshGithub);
  const discovered = (github?.projects ?? []).map(row => ({...normalizeProject(row, observedAt), registration: 'github'}));
  const related = raw.projects.filter(row => row.deliverySource).slice(0,8);
  const deliveryRecords = new Map(refreshGithub ? await Promise.all(related.map(async row =>
    [row.id, await readDeliveryRecord(row.deliverySource)])) : []);
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
      projects: [...projects, ...discovered].map(({cwd, handoverRequirements, nativeHandover, ...project}) => {
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
