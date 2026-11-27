const isMinutes = value => Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const isTime = value => value !== null;
const progressPercent = (count, total) => count === total ? 100 : Math.min(99.9, Math.round(count * 1000 / total) / 10);
const openTaskStates = new Set(['pending','active','waiting','paused','approval','limit','blocked','failed']);

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
  return {total, accepted: accepted.length, implementationCompletion: progressPercent(implemented, total),
    formalCompletion: progressPercent(accepted.length, total), verifiedCompletion: progressPercent(verified, total),
    usableCompletion: progressPercent(useful, total)};
}

export function remainingEstimate(value) {
  const {optimistic, standard, cautious} = value ?? {};
  if (![optimistic, standard, cautious].every(isMinutes) || optimistic > standard || standard > cautious) return null;
  return {optimistic, standard, cautious};
}

export function taskHasOpenWork(task) {
  return openTaskStates.has(task?.status) ||
    (typeof task?.blocker === 'string' && Boolean(task.blocker.trim())) ||
    (Array.isArray(task?.remaining) && task.remaining.some(item => typeof item === 'string' && item.trim()));
}

export function taskIsVerified(task, counts = requirementProgress(task?.requirements)) {
  return task?.status === 'verified' && counts !== null && counts.accepted === counts.total &&
    task.externalWait !== 'unknown' && !taskHasOpenWork(task);
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
        (estimate.cautious === 0 && (task.status === 'verified' || taskHasOpenWork(task)))) return null;
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

const forecastScenarios = ['optimistic','standard','cautious'];
const forecastMinute = 60_000;
const forecastDay = 86_400_000;
const forecastJapanOffset = 9 * 60 * forecastMinute;
const forecastProjectHolds = new Set(['paused','cancelled','blocked','approval','awaiting_approval','limit',
  'resource_limited','offline','completed','complete']);
const forecastTaskHolds = new Set(['paused','blocked','failed','waiting','approval','limit']);

function forecastString(value, limit = 360) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
}

function forecastList(value, limit = 12) {
  return Array.isArray(value) ? value.slice(0,limit).map(item=>forecastString(item)).filter(Boolean) : [];
}

function forecastJst(value) {
  if (!isTime(value) || !Number.isFinite(value) || !Number.isFinite(new Date(value + forecastJapanOffset).getTime())) return null;
  return new Date(value + forecastJapanOffset).toISOString().replace('Z','+09:00');
}

function comparableForecast(task, samples) {
  if (!forecastString(task.kind,80) || !isMinutes(task.units) || task.units <= 0) return null;
  const matches = Array.isArray(samples) ? samples.slice(0,200).filter(sample=>sample?.kind===task.kind &&
    isMinutes(sample.minutes) && sample.minutes > 0 && isMinutes(sample.units) && sample.units > 0 &&
    forecastString(sample.source)) : [];
  if (!matches.length) return null;
  const minutes = matches.map(sample=>sample.minutes / sample.units * task.units).sort((a,b)=>a-b);
  const middle = Math.floor(minutes.length/2);
  const center = minutes.length%2 ? minutes[middle] : (minutes[middle-1]+minutes[middle])/2;
  const remainingMinutes = remainingEstimate({optimistic:Math.round(minutes[0]*0.8),
    standard:Math.round(center),cautious:Math.ceil(minutes.at(-1)*1.5)});
  if (!remainingMinutes || remainingMinutes.cautious === 0) return null;
  return {remainingMinutes, estimate:{basis:'照合済みの同種作業を作業量で換算',confidence:matches.length>=3?'medium':'low',
    assumptions:['同じ種類の作業と単位。標準は換算値の中央値、範囲は観測された最短と最長に余裕を加えたもの。'],
    evidence:[...new Set(matches.map(sample=>forecastString(sample.source)))].slice(0,8)}};
}

function makeForecastTask(task, verifiedIds, now, comparableRuns) {
  const verified = verifiedIds instanceof Set ? task.status === 'verified' && verifiedIds.has(task.id) &&
    task.externalWait !== 'unknown' && !taskHasOpenWork(task) : taskIsVerified(task);
  const direct = remainingEstimate(task.remainingMinutes);
  const comparable = !direct && !verified ? comparableForecast(task,comparableRuns) : null;
  const proposed = direct ?? comparable?.remainingMinutes ?? null;
  const observedAt = timestamp(task.observedAt);
  const validUntil = timestamp(task.estimate?.validUntil);
  const expires = validUntil ?? (task.status==='active' && observedAt!==null && direct
    ? observedAt + direct.standard*forecastMinute : null);
  const expired = !verified && expires!==null && expires<=now;
  const rejectedCompletion = !verified && task.status==='verified';
  const remainingMinutes = verified ? {optimistic:0,standard:0,cautious:0} :
    expired || proposed?.cautious===0 ? null : proposed;
  const estimate = comparable?.estimate ?? {basis:forecastString(task.estimate?.basis),
    confidence:['low','medium','high'].includes(task.estimate?.confidence)?task.estimate.confidence:null,
    assumptions:forecastList(task.estimate?.assumptions),evidence:forecastList(task.estimate?.evidence,8)};
  return {id:task.id,title:forecastString(task.title,140)??task.id,
    status:verified?'verified':rejectedCompletion?'unknown':forecastString(task.status,30)??'unknown',
    verified,unconfirmedCompletion:rejectedCompletion,actionable:task.actionable!==false,expired,remainingMinutes,
    previousMinutes:expired?proposed:null,estimate,
    dependencies:task.dependencies==null?[]:Array.isArray(task.dependencies) &&
      task.dependencies.length<=400 && task.dependencies.every(id=>typeof id==='string' && id.length<=120)
      ? task.dependencies : null,requirements:forecastList(task.requirementIds,64),
    remaining:forecastList(task.remaining),observedAt:forecastJst(observedAt),
    availableAt:timestamp(task.availableAt),externalWait:task.externalWait==='unknown',
    blocker:forecastString(task.blocker),cause:forecastString(task.cause),resolution:forecastString(task.resolution),
    nextAction:forecastString(task.nextAction),owner:forecastString(task.owner,80),device:forecastString(task.device,80),
    resource:forecastString(task.resource,80),goalId:forecastString(task.goalId,120),
    ownerAction:forecastString(task.ownerAction)};
}

function forecastGraph(tasks) {
  if (!tasks.length || new Set(tasks.map(task=>task.id)).size!==tasks.length) return null;
  const byId = new Map(tasks.map(task=>[task.id,task]));
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(task) {
    if (visited.has(task.id)) return true;
    if (visiting.has(task.id) || !Array.isArray(task.dependencies) ||
      task.dependencies.some(dep=>typeof dep!=='string' || !byId.has(dep))) return false;
    visiting.add(task.id);
    if (!task.dependencies.every(dep=>visit(byId.get(dep)))) return false;
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
    return true;
  }
  return tasks.every(visit) ? ordered : null;
}

function forecastCalendar(value) {
  if (value==='continuous') return value;
  if (!Array.isArray(value?.weekdays) || !value.weekdays.length || value.weekdays.length>7 ||
      value.weekdays.some(day=>!Number.isInteger(day) || day<0 || day>6) ||
      !Number.isInteger(value.startHourJst) || value.startHourJst<0 || value.startHourJst>23 ||
      !Number.isInteger(value.minutesPerDay) || value.minutesPerDay<1 ||
      value.minutesPerDay>1440-value.startHourJst*60) return null;
  return {weekdays:new Set(value.weekdays),startHourJst:value.startHourJst,minutesPerDay:value.minutesPerDay};
}

function forecastEnd(start, minutes, calendar) {
  if (!minutes) return start;
  if (calendar==='continuous') return start+minutes*forecastMinute;
  let pending = minutes*forecastMinute;
  let localTime = start+forecastJapanOffset;
  for (let steps=0; steps<3660; steps++) {
    const day = Math.floor(localTime/forecastDay)*forecastDay;
    const opens = day+calendar.startHourJst*60*forecastMinute;
    const closes = opens+calendar.minutesPerDay*forecastMinute;
    if (calendar.weekdays.has(new Date(day).getUTCDay()) && localTime<closes) {
      const from = Math.max(localTime,opens);
      if (pending<=closes-from) return from+pending-forecastJapanOffset;
      pending -= closes-from;
    }
    localTime = day+forecastDay;
  }
  return null;
}

function finishForecast(ordered, parallelism, options = {}) {
  if (!ordered || ordered.some(task=>!task.remainingMinutes)) return null;
  const {asOf=0,calendar,resourceLimits=true} = options;
  const tails = new Map();
  for (const task of [...ordered].reverse()) {
    const next = (tails.get(task.id)??0)+task.remainingMinutes.standard;
    tails.set(task.id,next);
    for (const dep of task.dependencies) tails.set(dep,Math.max(tails.get(dep)??0,next));
  }
  const result = {};
  for (const scenario of forecastScenarios) {
    const ends = new Map();
    const resources = new Map();
    const workers = Array.from({length:parallelism},()=>asOf);
    const pending = [...ordered];
    while (pending.length) {
      const worker = workers.indexOf(Math.min(...workers));
      let chosen = -1;
      let start = Infinity;
      for (const [index,task] of pending.entries()) {
        if (!task.dependencies.every(dep=>ends.has(dep))) continue;
        const predecessors = Math.max(asOf,...task.dependencies.map(dep=>ends.get(dep)));
        const earliest = task.verified ? predecessors : Math.max(predecessors,workers[worker],
          (resourceLimits ? resources.get(task.resource) : null)??asOf, calendar ? task.availableAt??asOf : asOf);
        if (earliest<start || (earliest===start && tails.get(task.id)>tails.get(pending[chosen]?.id))) {
          chosen=index;
          start=earliest;
        }
      }
      if (chosen<0) return null;
      const [task]=pending.splice(chosen,1);
      const minutes=task.remainingMinutes[scenario];
      const end=calendar?forecastEnd(start,minutes,calendar):start+minutes;
      if (end===null || !Number.isFinite(end)) return null;
      ends.set(task.id,end);
      if (!task.verified) {
        workers[worker]=end;
        if (resourceLimits && task.resource) resources.set(task.resource,end);
      }
    }
    result[scenario]=Math.max(asOf,...ends.values());
  }
  return {optimistic:Math.min(result.optimistic,result.standard),standard:result.standard,
    cautious:Math.max(result.cautious,result.standard)};
}

function forecastSum(tasks) {
  if (!tasks.length) return null;
  return Object.fromEntries(forecastScenarios.map(key=>[key,tasks.reduce((sum,task)=>sum+task.remainingMinutes[key],0)]));
}

function forecastMilestone(ordered, ids) {
  if (!ordered || !Array.isArray(ids) || !ids.length || ids.length>400) return null;
  const map = new Map(ordered.map(task=>[task.id,task]));
  const included = new Set();
  function add(id) {
    if (included.has(id)) return true;
    const task=map.get(id);
    if (!task) return false;
    included.add(id);
    return task.dependencies.every(add);
  }
  return ids.every(add) ? ordered.filter(task=>included.has(task.id)) : null;
}

function forecastDiagnostics(delivery, tasks, delayed, progress) {
  const results = [];
  const note = (code,reason,action,taskIds=[]) => results.push({code,reason,action,taskIds});
  const events = Array.isArray(delivery.events) ? delivery.events.slice(-200).filter(row=>
    row && forecastString(row.id,120) && timestamp(row.at)!==null) : [];
  const distinct = [...new Map(events.map(row=>[row.id,row])).values()];
  if (delayed===true) note('delay','当初の予定より現在の予測が遅れています。','依存先と待機条件を確認し、着手できる工程を先に進めて再計算する。');
  const scopeChanges = distinct.filter(row=>row.kind==='scope-change');
  if (scopeChanges.length) note('scope-change',forecastString(scopeChanges.at(-1).reason)??'追加要求の記録があります。',
    '変更前後の作業量を照合し、追加分を当初見積もりと分ける。');
  for (const [kind,key,code,reason,action] of [
    ['blocked','causeKey','recurring-obstacle','同じ障害が複数回記録されています。','再試行する前に再発箇所を一つ切り分け、原因を除ける方法へ切り替える。'],
    ['attempt','workKey','repeated-work','同じ作業のやり直しが記録されています。','前回の差分・テスト・成果物を読み戻し、同じ調査や検証を省く。'],
    ['work','workKey','duplicate-work','同じ作業先で担当が重複した記録があります。','作業先と担当の境界を照合し、実装を一つにまとめる。'],
  ]) {
    const groups = new Map();
    for (const event of distinct.filter(row=>row.kind===kind && forecastString(row[key],120))) {
      const list=groups.get(event[key])??[];
      list.push(event);
      groups.set(event[key],list);
    }
    for (const group of groups.values()) {
      if (group.length<2 || group.at(-1).outcome==='resolved') continue;
      if (kind==='work' && !group.some((row,index)=>group.slice(index+1).some(other=>
        row.owner && other.owner && row.owner!==other.owner && timestamp(row.endAt)!==null &&
        timestamp(other.endAt)!==null && timestamp(row.at)<timestamp(other.endAt) && timestamp(other.at)<timestamp(row.endAt)))) continue;
      note(code,reason,action,[...new Set(group.map(row=>forecastString(row.taskId,120)).filter(Boolean))]);
    }
  }
  const handoff = distinct.findLast(row=>row.kind==='handoff');
  if (handoff?.outcome==='incomplete') note('handoff','引き継ぎの不足が記録されています。',
    '着手前にGOAL・要求・証拠の版と、担当者が読んだ版を照合する。');
  const wrongGoal = tasks.filter(task=>task.goalId && delivery.goalId && task.goalId!==delivery.goalId);
  if (wrongGoal.length) note('goal-drift','工程に別のGOALが記録されています。',
    '正本から対応する要求を確認し、今回の作業先と優先順位を修正する。',wrongGoal.map(task=>task.id));
  const history = Array.isArray(delivery.checkpoints) ? delivery.checkpoints.slice(-3).filter(row=>
    timestamp(row?.at)!==null && Number.isSafeInteger(row.accepted) && forecastString(row.scopeRevision)) : [];
  if (history.length===3 && progress && history.every(row=>row.scopeRevision===history[0].scopeRevision &&
    row.accepted===progress.accepted && row.active===true) &&
    timestamp(history[2].at)-timestamp(history[0].at)>=30*forecastMinute) {
    note('stalled','同じ要求範囲の受入件数が3回の実作業観測で増えていません。',
      '検証可能な成果物までの工程を短くし、先に詰まりを解消する。');
  }
  return results.slice(0,16);
}

function forecastBaseline(value) {
  if (!value) return null;
  return {kind:value.kind,target:forecastString(value.target,80),recordedAt:forecastJst(timestamp(value.recordedAt)),
    dueAt:forecastJst(timestamp(value.dueAt)),minutes:remainingEstimate(value.minutes),
    basis:forecastString(value.basis),reason:forecastString(value.reason),assumptions:forecastList(value.assumptions)};
}

export function developmentForecast(delivery = {}, {
  now=Date.now(), status='active', goal=null, nextAction=null, verifiedTaskIds=null, workspaceUnconfirmed=false,
} = {}) {
  delivery = delivery && typeof delivery==='object' ? delivery : {};
  const asOf = timestamp(delivery.observationAt);
  const paused = forecastProjectHolds.has(status);
  const target = forecastString(delivery.goal)??forecastString(typeof goal==='string'?goal:goal?.title);
  const raw = Array.isArray(delivery.tasks) ? delivery.tasks : [];
  const validTasks = raw.length<=400 && new Set(raw.map(task=>task?.id)).size===raw.length &&
    raw.every(task=>typeof task?.id==='string' && task.id.length>0 && task.id.length<=120);
  const tasks = validTasks ? raw.map(task=>makeForecastTask(task,verifiedTaskIds,now,delivery.comparableRuns)) : [];
  const scoped = verifiedTaskIds instanceof Set;
  const confirmedRequirements = new Set(tasks.filter(task=>task.verified).flatMap(task=>task.requirements));
  const requirements = scoped && Array.isArray(delivery.requirements) ? delivery.requirements.map(row=>
    confirmedRequirements.has(row?.id) ? row : {id:row?.id,title:row?.title}) : delivery.requirements;
  const progress = requirementProgress(requirements);
  const checkpoints = validTasks ? raw.map((task,index)=>{
    if (!scoped || tasks[index].verified || !Array.isArray(task.requirements)) return requirementProgress(task.requirements);
    return requirementProgress(task.requirements.map(row=>({id:row?.id})));
  }).filter(Boolean) : [];
  const checkTotal = checkpoints.reduce((sum,row)=>sum+row.total,0);
  const checkAccepted = checkpoints.reduce((sum,row)=>sum+row.accepted,0);
  const outstanding = tasks.filter(task=>!task.verified);
  const ordered = forecastGraph(tasks);
  const calendar = forecastCalendar(delivery.capacity?.calendar);
  const parallelism = Number.isSafeInteger(delivery.capacity?.parallelism) && delivery.capacity.parallelism>0
    ? Math.min(16,delivery.capacity.parallelism) : 1;
  const waits = task=>!task.verified && (task.externalWait || Boolean(task.ownerAction) ||
    (forecastTaskHolds.has(task.status) && (task.status!=='waiting' || task.availableAt===null)));
  const unresolved = outstanding.filter(waits);
  const ownerAction = forecastString(delivery.ownerAction);
  const ownerHold = ownerAction && delivery.ownerActionAppliesTo!=='release';
  const canDate = !paused && !ownerAction && !workspaceUnconfirmed && calendar && asOf!==null && asOf<=now;
  function calendarDates(selected) {
    if (!canDate || !selected || selected.some(task=>waits(task) || task.unconfirmedCompletion || (!task.verified &&
      (!task.estimate.basis || !task.estimate.confidence)))) return null;
    const times=finishForecast(selected,parallelism,{asOf,calendar});
    if (!times || (selected.some(task=>!task.verified) && times.standard<now)) return null;
    const dates=Object.fromEntries(forecastScenarios.map(key=>[key,forecastJst(times[key])]));
    return Object.values(dates).every(Boolean) ? dates : null;
  }
  const total = ordered && tasks.every(task=>task.remainingMinutes) ? forecastSum(tasks) : null;
  const readyTaskIds = paused || ownerHold || workspaceUnconfirmed || !ordered ? [] : outstanding.filter(task=>task.actionable && !task.unconfirmedCompletion && !waits(task) && !forecastTaskHolds.has(task.status) &&
    task.dependencies.every(id=>tasks.find(other=>other.id===id)?.verified) &&
    (task.availableAt===null || task.availableAt<=now)).map(task=>task.id);
  const original = forecastBaseline(Array.isArray(delivery.estimates) ? delivery.estimates.find(row=>row?.kind==='original') : null);
  const retrospective = forecastBaseline(Array.isArray(delivery.estimates) ? delivery.estimates.find(row=>row?.kind==='retrospective') : null);
  const baseline=original??retrospective??null;
  const baselineAt=timestamp(original?.dueAt);
  const completionDates=delivery.scopeComplete===true?calendarDates(ordered):null;
  const firstUsableDates=calendarDates(forecastMilestone(ordered,delivery.firstUsableTaskIds));
  const firstUsableActualAt=timestamp(delivery.firstUsableAt);
  const comparedDate=original?.target==='first-usable' ? firstUsableActualAt??timestamp(firstUsableDates?.standard) : timestamp(completionDates?.standard);
  const delta=baselineAt!==null && comparedDate!==null ? (comparedDate-baselineAt)/forecastMinute : null;
  const delayed=progress?.formalCompletion===100 && ordered && outstanding.length===0 ? false :
    baselineAt!==null && (completionDates || outstanding.length) ? (delta!==null ? delta>0 : now>baselineAt) : null;
  const gaps = [];
  const investigationMinutes=remainingEstimate(delivery.investigationMinutes);
  const missing = (code,reason,action,taskIds=[]) => gaps.push({code,reason,action,taskIds,
    investigationMinutes:['external-wait','owner-action'].includes(code)?null:investigationMinutes});
  if (!target) missing('goal','正式なGOALの参照がありません。','既存のGOAL、課題、または所有者の指示と照合する。');
  if (!progress) missing('requirements','全要求と受入済みの対応が確定していません。','要求の正本と成果物・検証証拠を照合する。');
  if (delivery.scopeComplete!==true) missing('scope','全要求を覆う残工程が確認されていません。','未達要求と既存の作業先を照合し、依存順を特定する。');
  if (!tasks.length || !ordered) missing('dependencies','工程の記録がないか、依存関係を解決できません。','工程一覧、依存ID、循環を正本で確認する。');
  if (asOf===null || asOf>now) missing('observation','有効な観測日時がありません。','発生済みの作業・完了と観測日時を正本で照合する。');
  const unconfirmed=outstanding.filter(task=>task.unconfirmedCompletion);
  if (unconfirmed.length) missing('completion-evidence','完了を証明する保存済みの証拠が一致しません。',
    '完了条件と同じ版の成果物を再確認し、証拠のハッシュと受入結果を記録する。',unconfirmed.map(task=>task.id));
  const untimed=outstanding.filter(task=>!task.remainingMinutes&&!task.expired);
  if (untimed.length) missing('task-estimate','工程の残り工数を算出する根拠が足りません。',
    '各作業量・既存資産を確認し、同じ種類の実績または根拠付きの時間幅を取得する。',untimed.map(task=>task.id));
  const datedButUnfounded=outstanding.filter(task=>task.remainingMinutes&&(!task.estimate.basis||!task.estimate.confidence));
  if (datedButUnfounded.length) missing('estimate-basis','保存済み工数の前提か確度を照合できません。',
    '見積もり時の根拠・前提・確度を読み戻す。',datedButUnfounded.map(task=>task.id));
  const expired=outstanding.filter(task=>task.expired);
  if (expired.length) missing('estimate-expired','以前の見込みの有効期限を過ぎました。',
    '未完了の作業だけを確認し、同じ工程の時間幅を更新する。',expired.map(task=>task.id));
  if (unresolved.length) missing('external-wait','停止や外部待ちの解消時刻を確定できません。',
    unresolved.find(task=>task.resolution)?.resolution??'止まっている入力・承認・端末の状態を確認し、解消時に更新する。',
    unresolved.map(task=>task.id));
  if (ownerAction) missing('owner-action','利用者の対応が残っています。',ownerAction);
  if (workspaceUnconfirmed) missing('workspace-observation','この端末の作業先で進行状態を確認できていません。',
    '保存済みの進行状態と作業先を照合してから着手する。');
  if (!calendar) missing('calendar','稼働を予定できる時間帯が未確認です。','担当と利用枠、稼働時間帯を確認し、経過時間から完成日時を計算する。');
  if (!original) missing('baseline','保存された開始前の見積もりがありません。','既存の履歴を照合し、復元した見込みには事後推定と記録する。');
  const start = timestamp(delivery.startedAt);
  const end = timestamp(delivery.completedAt)??(asOf!==null && asOf<=now ? asOf : null);
  const observed = observedTime(delivery.intervals);
  const action = forecastString(nextAction)??forecastString(delivery.nextAction) ??
    outstanding.find(task=>readyTaskIds.includes(task.id))?.nextAction ?? gaps[0]?.action ?? null;
  return {goal:target,stage:forecastString(delivery.stage),status,observedAt:forecastJst(asOf),progress,
    checkpoints:checkTotal ? {accepted:checkAccepted,total:checkTotal,percent:progressPercent(checkAccepted,checkTotal)} : null,
    requirements:Array.isArray(requirements)?requirements.slice(0,400).filter(row=>row?.id).map(row=>({
      id:row.id,title:forecastString(row.title,140)??row.id,implemented:row.implemented===true,accepted:acceptance(row),
      usable:acceptance(row)&&row.artifact?.usable===true})):[],
    baseline:{kind:original?'original':retrospective?'retrospective':'unavailable',
      original,retrospective,revisionReason:forecastString(delivery.revisionReason)??forecastString(baseline?.reason)},
    actual:{...observed,elapsedMinutes:start!==null&&end!==null&&end>=start?(end-start)/forecastMinute:null,
      firstUsableAt:firstUsableActualAt!==null&&firstUsableActualAt<=now?forecastJst(firstUsableActualAt):null},
    schedule:{workMinutes:total,recordedWorkMinutes:forecastSum(outstanding.filter(task=>task.remainingMinutes)),
      criticalPathMinutes:finishForecast(ordered,Math.max(1,tasks.length),{resourceLimits:false}),
      elapsedMinutes:finishForecast(ordered,parallelism),parallelism,completionDates,
      firstUsableDates,
      forecastDeltaMinutes:delta,delayed,readyTaskIds,orderedTaskIds:ordered?.map(task=>task.id)??[]},
    tasks,gaps,nextAction:action,ownerAction,
    nextUpdate:{at:paused||ownerHold?null:forecastJst(timestamp(delivery.nextUpdateAt)??(asOf!==null&&asOf<=now?asOf+15*forecastMinute:null)),
      trigger:paused?'owner-resume':ownerHold?'owner-action':'work-or-observation-change'},
    diagnostics:forecastDiagnostics(delivery,tasks,delayed,progress)};
}
