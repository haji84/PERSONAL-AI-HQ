const isMinutes = value => Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const isTime = value => value !== null;
const integerPercent = (count, total) => Math.round(count * 1000 / total) / 10;

function acceptance(requirement) {
  const {review, validation} = requirement;
  return requirement.implemented === true && review?.independent === true && review.status === 'accepted' &&
    validation?.status === 'passed' && typeof validation.source === 'string' && validation.source.length > 0 &&
    (requirement.targetRuntimeRequired !== true || validation.runtime === 'target');
}

export function requirementProgress(requirements) {
  if (!Array.isArray(requirements) || requirements.length === 0) return null;
  const ids = requirements.map(requirement => requirement?.id);
  if (ids.some(id => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) return null;
  const total = requirements.length;
  const implemented = requirements.filter(requirement => requirement.implemented === true).length;
  const verified = requirements.filter(requirement => requirement.validation?.status === 'passed' &&
    (requirement.targetRuntimeRequired !== true || requirement.validation.runtime === 'target')).length;
  const accepted = requirements.filter(acceptance);
  const useful = accepted.filter(requirement => requirement.artifact?.usable === true).length;
  return {total, accepted: accepted.length, implementationCompletion: integerPercent(implemented, total),
    formalCompletion: integerPercent(accepted.length, total), verifiedCompletion: integerPercent(verified, total),
    usableCompletion: integerPercent(useful, total)};
}

export function remainingEstimate(value) {
  const {optimistic, standard, cautious} = value ?? {};
  if (![optimistic, standard, cautious].every(isMinutes) || optimistic > standard || standard > cautious) return null;
  return {optimistic, standard, cautious};
}

export function taskIsVerified(task, counts = requirementProgress(task?.requirements)) {
  const remaining = task?.remaining;
  const hasRemainingWork = Array.isArray(remaining) && remaining.some(item => typeof item === 'string' && item.trim());
  return task?.status === 'verified' && counts !== null && counts.accepted === counts.total &&
    task.externalWait !== 'unknown' && !hasRemainingWork;
}

export function criticalPath(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 400) return null;
  const ids = tasks.map(task => task?.id);
  if (ids.some(id => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) return null;
  const graph = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set();
  const visited = new Map();

  function finish(id) {
    if (visited.has(id)) return visited.get(id);
    if (visiting.has(id) || !graph.has(id)) return null;
    const task = graph.get(id);
    const dependencies = task.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== 'string')) return null;
    let durations = [0, 0, 0];
    if (!taskIsVerified(task)) {
      const estimate = remainingEstimate(task.remainingMinutes);
      if (!estimate || task.externalWait === 'unknown' ||
        (task.status === 'verified' && estimate.cautious === 0)) return null;
      durations = [estimate.optimistic, estimate.standard, estimate.cautious];
    }
    visiting.add(id);
    const predecessor = dependencies.map(finish);
    visiting.delete(id);
    if (predecessor.some(value => value === null)) return null;
    const completed = predecessor.reduce((current, entry) => current.map((value, index) => Math.max(value, entry[index])), [0, 0, 0]);
    const result = completed.map((value, index) => value + durations[index]);
    visited.set(id, result);
    return result;
  }

  const ends = ids.map(finish);
  if (ends.some(value => value === null)) return null;
  const [optimistic, standard, cautious] = ends.reduce((values, entry) => values.map((value, index) =>
    Math.max(value, entry[index])), [0, 0, 0]);
  return {optimistic, standard, cautious};
}

function minutesOutside(intervals, subtract = []) {
  const points = [...intervals.flatMap(([start, end]) => [[start, 1, 0], [end, -1, 0]]),
    ...subtract.flatMap(([start, end]) => [[start, 0, 1], [end, 0, -1]])].sort((a, b) => a[0] - b[0]);
  let prior = points[0]?.[0] ?? 0;
  let counted = 0;
  let excluded = 0;
  let elapsed = 0;
  for (const [at, delta, omitted] of points) {
    if (counted > 0 && excluded === 0) elapsed += at - prior;
    counted += delta;
    excluded += omitted;
    prior = at;
  }
  return elapsed / 60000;
}

export function observedTime(intervals) {
  if (!Array.isArray(intervals) || !intervals.length || intervals.length > 10000) return null;
  const running = [];
  const waiting = [];
  const agents = new Map();
  for (const interval of intervals) {
    const start = timestamp(interval?.start);
    const end = timestamp(interval?.end);
    if (!isTime(start) || !isTime(end) || end < start || !['active', 'waiting'].includes(interval.kind)) return null;
    if (interval.kind === 'waiting') { waiting.push([start, end]); continue; }
    running.push([start, end]);
    const agent = agents.get(interval.agent) ?? [];
    agent.push([start, end]);
    agents.set(interval.agent, agent);
  }
  return {activeMinutes: minutesOutside(running), waitingMinutes: minutesOutside(waiting, running),
    agentMinutes: agents.has(undefined) || agents.has(null) ? null :
      [...agents.values()].reduce((sum, value) => sum + minutesOutside(value), 0)};
}

export function deliveryProgress(delivery, now = new Date()) {
  const counts = requirementProgress(delivery?.requirements);
  const durations = criticalPath(delivery?.tasks);
  const asOf = timestamp(delivery?.observationAt);
  const baseline = timestamp(delivery?.estimates?.[0]?.dueAt);
  const expected = durations && isTime(asOf) ? asOf + durations.standard * 60000 : null;
  const done = counts && counts.accepted === counts.total;
  const drift = isTime(expected) && isTime(baseline) ? (expected - baseline) / 60000 : null;
  return {counts, durations, time: observedTime(delivery?.intervals),
    originalDueAt: isTime(baseline) ? new Date(baseline).toISOString() : null,
    estimateFinish: isTime(expected) && Number.isFinite(new Date(expected).getTime()) ? new Date(expected).toISOString() : null,
    forecastDeltaMinutes: drift,
    delayed: done ? false : isTime(baseline) && counts ? Number(now) > baseline || (drift !== null && drift > 0) : null};
}
