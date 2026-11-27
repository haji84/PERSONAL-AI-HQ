import {readProjectExecutionBindings} from './portfolio.mjs';
import {executionHeld} from './execution-access.mjs';

const recordAgeMs = 15 * 60 * 1000;
const maxLiveAgeMs = 30 * 1000;
export const unknownExecution = Object.freeze({
  mode:null, modeSource:'unknown', route:null, routeState:'unknown', observedAt:null,
  observedUntil:null, activeUntil:null, stopReason:'settings-unavailable',
});

function recent(when, now, limit = recordAgeMs) {
  const age = now - Date.parse(when);
  return age >= 0 && age <= limit;
}

function newest(codex, api) {
  if (!codex || !api) return codex ?? api;
  const difference = Date.parse(codex.createdAt) - Date.parse(api.createdAt);
  return difference > 0 ? codex : difference < 0 ? api : {reason:'unconfirmed'};
}

function executionSummary(project, policy, activity, apiEnabled, now) {
  const held = executionHeld(project.state);
  const liveAgeMs = activity?.liveAgeMs ?? maxLiveAgeMs;
  const current = !held && activity?.active && recent(activity.observedAt, now, liveAgeMs);
  const route = activity && recent(activity.observedAt,now) ? activity.route : null;
  const instant = route ? Date.parse(activity.observedAt) : null;
  const reason = activity?.reason === 'unconfirmed' || recent(activity?.updatedAt,now) ? activity?.reason : null;
  const stopReason = held && !(project.state === 'waiting' && project.scopeRequired) ? project.state :
    reason ?? (!policy ? 'settings-unavailable'
      : !project.cwd.length ? 'scope-required' : policy.mode === 'api-only' && !apiEnabled ? 'api-disabled' : null);
  return {
    mode:policy?.mode ?? null, modeSource:policy?.modeSource ?? 'unknown',
    route, routeState:!route ? 'unknown' : current ? 'active' : 'observed',
    observedAt:route ? new Date(instant).toISOString() : null,
    observedUntil:route ? new Date(instant + recordAgeMs).toISOString() : null,
    activeUntil:route && current ? new Date(instant + liveAgeMs).toISOString() : null, stopReason,
  };
}

export function createPortfolioExecution(directory, store, operations, apiWork, apiEnabled) {
  return (projects, now = Date.now()) => {
    const bindings = readProjectExecutionBindings(directory,projects.keys());
    const policies = store.portfolioPolicies(bindings);
    const summaries = new Map();
    for (const [id, {project}] of bindings) {
      const prior = projects.get(id);
      if (prior.cwd.length !== project.cwd.length || prior.cwd.some(cwd=>!project.cwd.includes(cwd))) continue;
      const policy = policies.get(id);
      const activity = newest(operations.portfolioActivity(project,now),apiWork.portfolioActivity(project,policy?.operation));
      summaries.set(id,executionSummary(project,policy,activity,apiEnabled,now));
    }
    return summaries;
  };
}
