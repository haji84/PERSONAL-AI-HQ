import {readProjectExecutionBindings} from './portfolio.mjs';

export const workOutcomeLimit = 8;

export function observedWorkTime(value, now) {
  const epoch = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) && epoch <= now && new Date(epoch).toISOString() === value;
}

export function measuredTokens(scope, inputTokens, outputTokens, totalTokens) {
  if (![inputTokens, outputTokens, totalTokens].every(count => Number.isSafeInteger(count) && count >= 0) ||
      inputTokens + outputTokens !== totalTokens) return null;
  return {scope, inputTokens, outputTokens, totalTokens};
}

export function codexTurnTiming(turn, now = Date.now()) {
  const {startedAt, completedAt, durationMs} = turn;
  if (![startedAt, completedAt].every(Number.isSafeInteger) || startedAt < 0 ||
      completedAt < startedAt || completedAt * 1000 > now) return null;
  const elapsed = (completedAt - startedAt) * 1000;
  return {startedAt:new Date(startedAt * 1000).toISOString(), completedAt:new Date(completedAt * 1000).toISOString(),
    ...(Number.isSafeInteger(durationMs) && durationMs >= 0 && Math.abs(durationMs - elapsed) < 1000 && {durationMs})};
}

export function recentWorkOutcomes(directory, projects, operations, apiWork) {
  const current = readProjectExecutionBindings(directory, projects.keys());
  const authorized = new Map();
  for (const [id, {project}] of current) {
    const previous = projects.get(id);
    if (project.cwd.length && previous.cwd.length === project.cwd.length &&
        previous.cwd.every(cwd => project.cwd.includes(cwd))) authorized.set(id, project);
  }
  const now = Date.now();
  return [...operations.recentOutcomes(authorized.values(), now), ...apiWork.recentOutcomes(authorized, now)]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.projectId.localeCompare(b.projectId) ||
      a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .slice(0, workOutcomeLimit);
}
