import {MODES, normalizeSettings} from './execution-policy.mjs';
import {criticalPath} from './progress.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const datePattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:[0-5]\d)$/;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const invalid = () => new TypeError('Invalid execution estimate');

function text(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw invalid();
  return value.trim();
}

function executionKey(settings) {
  return JSON.stringify({...settings, allowedRoutes:[...settings.allowedRoutes].sort(),
    stageRoutes:Object.fromEntries(Object.entries(settings.stageRoutes).sort())});
}

function needsApi(settings) {
  if (!settings.allowedRoutes.includes('api')) return false;
  if (settings.allowedRoutes.length === 1) return true;
  if (settings.mode === 'hybrid') return Object.values(settings.stageRoutes).includes('api');
  return settings.mode === 'auto' && settings.preference === 'api-first' && !settings.allowFallback;
}

function duration(value) {
  if (value == null) return null;
  const {optimistic, standard, cautious} = value;
  if (![optimistic, standard, cautious].every(nonnegative) || optimistic > standard || standard > cautious) throw invalid();
  return {optimistic, standard, cautious};
}

function plannedAt(start, minutes) {
  if (minutes == null) return null;
  const date = new Date(start + minutes * 60000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function evidenceLinks(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw invalid();
  return value.map(entry => {
    const label = text(entry?.label, 200);
    const url = new URL(text(entry.url, 2048));
    if (url.protocol !== 'https:' || url.username || url.password || url.search) throw invalid();
    return {label, url:url.href};
  });
}

function normalizeEstimate(value, now) {
  if (!record(value) || !record(value.execution) || !MODES.includes(value.execution.mode) ||
      !['milestone','project'].includes(value.target)) throw invalid();
  if (typeof value.recordedAt !== 'string' || !datePattern.test(value.recordedAt)) throw invalid();
  const time = Date.parse(value.recordedAt);
  const day = value.recordedAt.slice(0,10);
  const calendar = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(time) || time > now || !Number.isFinite(calendar.getTime()) ||
      !calendar.toISOString().startsWith(day + 'T')) throw invalid();
  const settings = normalizeSettings(value.execution);
  const key = executionKey(settings);
  const {mode, allowedRoutes} = settings;
  const apiCostUsd = value.apiCostUsd ?? null;
  const subscriptionTurns = value.subscriptionTurns ?? null;
  if ((apiCostUsd !== null && (!nonnegative(apiCostUsd) || (!allowedRoutes.includes('api') && apiCostUsd !== 0))) ||
      (subscriptionTurns !== null && (!Number.isSafeInteger(subscriptionTurns) || !nonnegative(subscriptionTurns) ||
        (!allowedRoutes.includes('subscription') && subscriptionTurns !== 0)))) throw invalid();
  const assumptions = value.assumptions ?? [];
  if (!Array.isArray(assumptions) || assumptions.length > 8) throw invalid();
  return {
    key, time, mode, target:value.target, scope:text(value.scope, 200), basis:text(value.basis, 800),
    model:settings.model, reasoningEffort:settings.reasoningEffort,
    assumptions:assumptions.map(item=>text(item,300)), links:evidenceLinks(value.links),
    firstUsableMinutes:duration(value.firstUsableMinutes),
    remainingMinutes:value.target === 'project' ? criticalPath(value.tasks) : null,
    apiCostUsd, subscriptionTurns,
  };
}

function visibleEstimate({key, time, ...estimate}, hideDates, now) {
  const first = plannedAt(time, estimate.firstUsableMinutes?.standard);
  const finish = plannedAt(time, estimate.remainingMinutes?.standard);
  const elapsed = at => at !== null && Date.parse(at) < now;
  return {
    ...estimate, recordedAt:new Date(time).toISOString(),
    firstUsableAt:hideDates || elapsed(first) ? null : first,
    estimatedFinish:hideDates || elapsed(finish) ? null : finish,
    stale:!hideDates && (elapsed(first) || elapsed(finish)),
  };
}

export function executionEstimates(input, {settings, revision, apiAvailable}, projectHeld, now = Date.now()) {
  const holdReason = projectHeld ? 'project' : needsApi(settings) && !apiAvailable ? 'api' : null;
  const held = holdReason !== null;
  const summary = {mode:settings.mode, settingsRevision:revision, held, holdReason};
  try {
    if (input.unavailable || !Array.isArray(input.rows) || input.rows.length > 256) throw invalid();
    const estimates = input.rows.map(row=>normalizeEstimate(row,now)).sort((left,right)=>right.time-left.time);
    const seen = new Set();
    for (const {key,time} of estimates) {
      const version = key + ':' + time;
      if (seen.has(version)) throw invalid();
      seen.add(version);
    }
    const key = executionKey(settings);
    const chosen = estimates.find(item=>item.key === key);
    if (!chosen) return {...summary,status:'missing',selected:null,alternatives:[]};
    const alternatives = new Map();
    for (const item of estimates) {
      if (item.mode === settings.mode || alternatives.has(item.mode) ||
          item.target !== chosen.target || item.scope !== chosen.scope) continue;
      alternatives.set(item.mode,visibleEstimate(item,true,now));
    }
    return {...summary,status:'available',selected:visibleEstimate(chosen,held,now),alternatives:[...alternatives.values()]};
  } catch {
    return {...summary,status:'unavailable',selected:null,alternatives:[]};
  }
}
