import {createHash} from 'node:crypto';
import {constants, lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename, join, resolve, sep} from 'node:path';
import {readApiAuthority} from './api-authority.mjs';
import {apiJobRounds, createApiResponseClient, maximumApiJobUsd} from './api-response.mjs';
import {prepareApiWorkspace} from './api-workspace.mjs';
import {STAGES, moneyMicros} from './execution-policy.mjs';
import {readCurrentProject} from './portfolio.mjs';
import {ensurePrivateDirectory} from './private-directory.mjs';

const taskKey = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const held = new Set(['paused', 'approval', 'limit', 'blocked', 'offline', 'waiting', 'completed']);
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value));
const problem = (status, code) => Object.assign(new Error(code), {status, code});
const publicPhase = {reserved: 'reserved', running: 'running', uncertain: 'unconfirmed', awaiting_settlement: 'unconfirmed',
  completed: 'completed', failed: 'failed', interrupted: 'interrupted', cancelled: 'interrupted'};
const terminalPhases = new Set(['completed', 'failed', 'interrupted']);
const observedAt = work => work.completedAt ?? work.settlementObservedAt ?? work.dispatchedAt ?? work.createdAt;

function currentPhase(work, local) {
  if (local?.controller.signal.aborted && ['reserved', 'running'].includes(work.status)) return 'interrupting';
  if (!local && work.status === 'running') return 'unconfirmed';
  return publicPhase[work.status];
}

function latestApiActivity(store, projectId, localJob) {
  const {operation} = store.getWork(projectId);
  if (operation?.route !== 'api') return null;
  const phase = currentPhase(operation, localJob(operation.executionId));
  return {id: operation.taskId, kind: 'api', phase, route: operation.route, model: operation.model, stage: operation.task?.stage,
    observedAt: observedAt(operation), createdAt: operation.createdAt, startedAt: operation.dispatchedAt ?? null,
    terminal: terminalPhases.has(phase)};
}

export function createApiDevelopment({directory, store, conversations, withProjectWorkLock, hasNativeWork,
  getKey = () => process.env.OPENAI_API_KEY, fetchImpl, readAuthority = readApiAuthority}) {
  const jobs = new Map();
  const artifacts = join(directory, 'api-work');
  let closing = false;

  function ownedProject(projectId) {
    const current = readCurrentProject(directory, projectId);
    if (!current || held.has(current.state) || closing) throw problem(409, 'EXECUTION_HELD');
    const checkout = join(directory, 'workspaces', projectId);
    try {
      const marker = join(checkout, '.hq-owned-workspace');
      const info = lstatSync(marker);
      if (!current.cwd.includes(checkout) || realpathSync(checkout) !== checkout || !info.isFile() ||
          info.uid !== process.getuid() || info.nlink !== 1 || info.size > 100 || readFileSync(marker, 'utf8').trim() !== projectId) {
        throw problem(409, 'API_WORKSPACE_NOT_ENROLLED');
      }
    } catch { throw problem(409, 'API_WORKSPACE_NOT_ENROLLED'); }
    return {current, checkout};
  }

  function authorized(projectId, forDispatch = true) {
    if (process.platform !== 'darwin') throw problem(409, 'API_RUNTIME_UNSUPPORTED');
    const key = getKey();
    if (typeof key !== 'string' || !key.trim()) throw problem(409, 'API_AUTHORIZATION_REQUIRED');
    const owned = ownedProject(projectId);
    let authority;
    try { authority = readAuthority(directory, Date.now(), {forDispatch}); }
    catch (cause) { throw problem(409, cause.code ?? 'API_AUTHORITY_INVALID'); }
    let actualBinding;
    try { actualBinding = store.reservationBinding(); } catch { throw problem(409, 'API_AUTHORITY_UNBOUND'); }
    if (!actualBinding || authority.reservationAuthorityId !== store.authorityId || authority.ledgerBinding !== actualBinding) {
      throw problem(409, 'API_AUTHORITY_UNBOUND');
    }
    if (!Object.hasOwn(authority.projects, projectId)) throw problem(409, 'API_WORKSPACE_NOT_ENROLLED');
    return {...owned, authority, enrollment: authority.projects[projectId]};
  }

  function context(authority, model) {
    return {capabilities: {api: {available: true, executorId: 'owner-mac-responses', defaultModel: authority.defaultModel,
      models: authority.models}}, safety: {authorized: true, status: 'ready', allowedRoutes: ['api'], api: {
      organizationId: authority.organization, creditOrganizationId: authority.credit.organization,
      reservationAuthorityId: authority.reservationAuthorityId, ledgerBinding: authority.ledgerBinding,
      availableCreditUsd: authority.credit.availableCreditUsd, observedAt: authority.credit.observedAt,
      expiresAt: authority.credit.safeUntil, zeroAdditionalCostGuaranteed: true,
      maxRequestCostUsd: maximumApiJobUsd(model),
    }}};
  }

  function binding(scope, model) {
    return digest({organization: scope.authority.organization, project: scope.authority.providerProject,
      ledger: scope.authority.ledgerBinding, checkout: scope.checkout, goal: scope.current.goal, enrollment: scope.enrollment, model});
  }

  function resultReport(work) {
    if (!work?.artifactsHash) return null;
    try {
      const file = join(artifacts, work.executionId, 'result.json');
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 131072 || stat.nlink !== 1) return null;
      const bytes = readFileSync(file);
      if (sha(bytes) !== work.artifactsHash) return null;
      return JSON.parse(bytes);
    } catch { return null; }
  }

  function view(project, work) {
    if (!work || work.route !== 'api') return {operation: null};
    const phase = currentPhase(work, jobs.get(work.executionId));
    const output = resultReport(work);
    const changes = work.status === 'completed' ? output?.changes ?? [] : [];
    return {operation: {id: work.taskId, project, route: 'api', stage: work.task?.stage, model: work.model, phase,
      createdAt: work.createdAt, startedAt: work.dispatchedAt ?? null, updatedAt: observedAt(work),
      result: output?.reason ?? work.reason ?? (phase === 'unconfirmed' ? 'API_SETTLEMENT_UNKNOWN' : null),
      verification: output?.verification ?? null, artifactCount: changes.length,
      changes: changes.map(({path, sha256, bytes}) => ({path, sha256, bytes}))}};
  }

  function archiveOutcome(projectId, work) {
    const outcome = publicPhase[work.status];
    if (!terminalPhases.has(outcome) && outcome !== 'unconfirmed') return;
    const report = outcome === 'completed' ? resultReport(work) : null;
    if (outcome === 'completed' && !report) throw problem(409, 'API_ARTIFACT_CHANGED');
    conversations.finishDevelopment(projectId, {id: work.executionId, outcome, summary: report?.summary ?? '',
      updatedAt: observedAt(work)});
  }

  async function run({projectId, operation, prior, scope, model, prompt, controller}) {
    const {executionId, taskId} = operation;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const jobRoot = join(artifacts, executionId);
    let dispatched = false;
    let awaitingReceipt = false;
    let spentMicros = 0;
    let baseSha = null;
    let verification = null;
    let finished = null;
    let summary = '';
    let conversationSaved = false;
    let reason = 'API_VERIFICATION_FAILED';
    const fingerprint = binding(scope, model);
    const reauthorize = (forDispatch = true) => {
      signal.throwIfAborted();
      const fresh = authorized(projectId, forDispatch);
      const selected = fresh.authority.models.find(item => item.id === model.id);
      if (!selected || binding(fresh, selected) !== fingerprint) throw problem(409, 'API_AUTHORITY_CHANGED');
      return fresh;
    };
    try {
      conversations.beginDevelopment(projectId, {id: executionId, prompt, model: model.id, createdAt: operation.createdAt});
      conversationSaved = true;
      await ensurePrivateDirectory(artifacts);
      reauthorize();
      const previousChanges = new Map();
      for (const verified of prior.verifiedApiOperations) {
        const priorResult = resultReport(verified);
        if (!priorResult?.verification?.passed || !priorResult.changes?.length) throw problem(409, 'API_CANDIDATE_HANDOVER_REQUIRED');
        for (const change of priorResult.changes) previousChanges.set(change.path, change);
      }
      const candidate = await prepareApiWorkspace({checkout: scope.checkout, jobRoot, files: scope.enrollment.files,
        testPaths: scope.enrollment.testPaths, priorChanges: [...previousChanges.values()], signal});
      baseSha = candidate.context().baseSha;
      const client = createApiResponseClient({key: getKey(), organization: scope.authority.organization,
        project: scope.authority.providerProject, fetchImpl});
      for (let round = 0; round < apiJobRounds; round++) {
        const answer = await client.propose({model, effort: operation.reasoningEffort, prompt, context: candidate.context(),
          feedback: verification?.output, signal, beforeSend: () => {
            const fresh = reauthorize();
            const policy = context(fresh.authority, model);
            const decision = dispatched ? store.recheckDispatched(projectId, taskId, executionId, policy)
              : store.markDispatched(projectId, taskId, executionId, policy);
            if (!decision.dispatchable) throw problem(409, decision.code);
            dispatched = true;
            awaitingReceipt = true;
          }});
        spentMicros += moneyMicros(answer.accountedUsd, 'ceil');
        awaitingReceipt = false;
        signal.throwIfAborted();
        if (!answer.proposal || spentMicros > operation.reservedMicros) {
          reason = answer.code ?? 'API_RESERVATION_EXCEEDED';
          break;
        }
        await candidate.apply(answer.proposal.changes);
        verification = await candidate.verify({signal});
        signal.throwIfAborted();
        if (verification.passed) {
          const result = await candidate.finish();
          if (result.changes.length) { finished = result; summary = answer.proposal.summary; reason = null; }
          else reason = 'API_NO_WORKSPACE_CHANGE';
          break;
        }
      }
    } catch (cause) {
      reason = signal.aborted ? 'INTERRUPTED' : cause.code ?? 'API_WORKSPACE_FAILED';
    }

    if (!dispatched) {
      const saved = store.cancelReserved(projectId, taskId, executionId, Date.now(), reason);
      if (conversationSaved) archiveOutcome(projectId, saved.operation);
      return;
    }
    if (awaitingReceipt) {
      const saved = store.recordOutcome({projectId, taskId, executionId, outcome: 'interrupted', confirmedTerminal: false, effectsReconciled: false});
      archiveOutcome(projectId, saved.operation);
      return;
    }
    if (finished) {
      try { reauthorize(false); }
      catch (cause) { finished = null; reason = signal.aborted ? 'INTERRUPTED' : cause.code ?? 'API_AUTHORITY_CHANGED'; }
    }
    const report = {executionId, projectId, baseSha, reason, verification, summary: finished ? summary : '',
      candidate: finished ? basename(finished.candidatePath) : null,
      changes: finished?.changes ?? []};
    const bytes = JSON.stringify(report);
    writeFileSync(join(jobRoot, 'result.json'), bytes, {flag: 'wx', mode: 0o600});
    const checkpoint = {id: executionId, version: (prior.checkpoint?.version ?? 0) + 1, goalId: projectId,
      requirementsHash: digest({goal: scope.current.goal, baseSha, files: scope.enrollment.files}),
      conversationHash: digest({prior: prior.checkpoint?.conversationHash ?? null, instruction: operation.instructionDigest}),
      stopHash: digest({scope: fingerprint, phase: signal.aborted ? 'interrupted' : 'settled'}),
      budgetHash: digest({organization: scope.authority.organization, reservedMicros: operation.reservedMicros, spentMicros}),
      artifactsHash: sha(bytes)};
    const saved = store.recordOutcome({projectId, taskId, executionId, outcome: signal.aborted ? 'interrupted' : finished ? 'completed' : 'failed',
      confirmedTerminal: true, effectsReconciled: true, actualCostUsd: spentMicros / 1_000_000, checkpoint});
    archiveOutcome(projectId, saved.operation);
  }

  return {
    activity(project) { return latestApiActivity(store, project.id, id => jobs.get(id)); },
    conversationView(project, result, offset) {
      const {conversation} = result;
      if (conversation.source !== 'api-development' || terminalPhases.has(conversation.outcome)) return result;
      const observed = outcome => ({...result, conversation: {...conversation, outcome}});
      try {
        const work = store.findExecution(project.id, conversation.id.slice('api/'.length));
        if (work?.route !== 'api') return observed('unconfirmed');
        const saved = publicPhase[work.status];
        if (terminalPhases.has(saved) || (saved === 'unconfirmed' && conversation.outcome !== 'unconfirmed')) {
          archiveOutcome(project.id, work);
          return conversations.read(project.id, conversation.id, offset);
        }
        const phase = currentPhase(work, jobs.get(work.executionId));
        return observed(phase === 'running' ? 'in_progress' : phase);
      } catch { return observed('unconfirmed'); }
    },
    capabilities(project) {
      try {
        if (!store.getSettings(project.id).settings.allowedRoutes.includes('api')) throw problem(409, 'ROUTE_NOT_ALLOWED');
        const {authority} = authorized(project.id);
        return {available: true, defaultModel: authority.defaultModel,
          models: authority.models.map(({id, reasoningEfforts}) => ({id, reasoningEfforts}))};
      } catch (cause) { return {available: false, reason: cause.code ?? 'API_AUTHORIZATION_REQUIRED', models: []}; }
    },
    read(project, id) {
      if (id !== undefined && !taskKey.test(id)) throw problem(400, 'API_TASK_INVALID');
      return view(project.id, store.getWork(project.id, id).operation);
    },
    start(project, input) {
      if (!taskKey.test(input?.id ?? '') || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000 ||
          !STAGES.includes(input.stage ?? 'implementation') || input.model !== undefined && typeof input.model !== 'string' ||
          input.effort !== undefined && typeof input.effort !== 'string') throw problem(400, 'API_TASK_INVALID');
      const projectId = project.id;
      const inputDigest = sha(input.prompt);
      const task = {stage: input.stage ?? 'implementation', route: 'api', ...(input.model ? {model: input.model} : {}),
        ...(input.effort ? {reasoningEffort: input.effort} : {})};
      return withProjectWorkLock(project, () => {
        const duplicate = store.getWork(projectId, input.id).operation;
        if (duplicate) {
          if (duplicate.instructionDigest !== inputDigest || digest(duplicate.task) !== digest(task)) throw problem(409, 'TASK_ID_CONFLICT');
          return view(projectId, duplicate);
        }
        if (hasNativeWork(project)) throw problem(409, 'HANDOVER_REQUIRED');
        const scope = authorized(projectId);
        const prior = store.getWork(projectId);
        const {settings, revision} = store.getSettings(projectId);
        const model = scope.authority.models.find(item => item.id === (input.model ?? settings.model ?? scope.authority.defaultModel));
        if (!model) throw problem(409, 'MODEL_UNAVAILABLE');
        const receipt = store.prepareDispatch({projectId, taskId: input.id, instructionDigest: inputDigest, expectedRevision: revision, task},
          context(scope.authority, model));
        if (!receipt.dispatchable) throw problem(409, receipt.code);
        const operation = receipt.operation;
        const controller = new AbortController();
        const worker = Promise.resolve().then(() => run({projectId, operation, prior, scope, model, prompt: input.prompt, controller})).catch(() => {
          // Ambiguous persistence or provider state holds the reservation. Never restart on its own.
        }).finally(() => jobs.delete(operation.executionId));
        jobs.set(operation.executionId, {worker, controller});
        return view(projectId, operation);
      });
    },
    interrupt(project, taskId) {
      if (typeof taskId !== 'string' || !taskKey.test(taskId)) throw problem(400, 'API_TASK_INVALID');
      const {operation} = store.getWork(project.id, taskId);
      if (!operation || operation.route !== 'api') throw problem(404, 'API_TASK_NOT_FOUND');
      const local = jobs.get(operation.executionId);
      if (local) local.controller.abort();
      if (operation.status === 'reserved') store.cancelReserved(project.id, taskId, operation.executionId);
      return view(project.id, store.getWork(project.id, taskId).operation);
    },
    async artifact(project, taskId, index) {
      if (typeof taskId !== 'string' || !taskKey.test(taskId) || !Number.isSafeInteger(index) || index < 0) throw problem(404, 'API_ARTIFACT_NOT_FOUND');
      const {operation} = store.getWork(project.id, taskId);
      const result = operation?.status === 'completed' ? resultReport(operation) : null;
      const file = result?.changes?.[index];
      if (!file || !/^candidate-[1-9]\d*$/.test(result.candidate)) throw problem(404, 'API_ARTIFACT_NOT_FOUND');
      const root = join(artifacts, operation.executionId, result.candidate);
      const destination = resolve(root, file.path);
      let handle;
      try {
        if (!destination.startsWith(root + sep) || realpathSync(destination) !== destination) throw problem(404, 'API_ARTIFACT_NOT_FOUND');
        handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch { throw problem(404, 'API_ARTIFACT_NOT_FOUND'); }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size !== file.bytes || stat.size > 1024 * 1024) {
          throw problem(404, 'API_ARTIFACT_NOT_FOUND');
        }
        const bytes = await handle.readFile();
        if (sha(bytes) !== file.sha256) throw problem(409, 'API_ARTIFACT_CHANGED');
        return {bytes, name: basename(file.path)};
      } finally { await handle.close(); }
    },
    async close() {
      closing = true;
      for (const {controller} of jobs.values()) controller.abort();
      await Promise.allSettled([...jobs.values()].map(item => item.worker));
    },
  };
}
