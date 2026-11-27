import {createHash} from 'node:crypto';
import {constants, lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {mkdir, open} from 'node:fs/promises';
import {basename, join, resolve, sep} from 'node:path';
import {readApiAuthority, readBoundApiAuthority, verifiedApiCredit} from './api-authority.mjs';
import {apiAdviceMaxLength, apiJobRounds, createApiResponseClient, maximumApiJobUsd} from './api-response.mjs';
import {checkedEvidenceIsCurrent, prepareApiWorkspace, readAdvisoryWorkspace, readCommittedEvidence} from './api-workspace.mjs';
import {STAGES, moneyMicros} from './execution-policy.mjs';
import {readCurrentProject} from './portfolio.mjs';
import {ensurePrivateDirectory} from './private-directory.mjs';
import {observedWorkTime, workOutcomeLimit} from './work-outcomes.mjs';

const taskKey = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const receiptKey = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const evidenceHash = /^[a-f0-9]{64}$/;
const gitRevision = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const held = new Set(['paused', 'approval', 'limit', 'blocked', 'offline', 'waiting', 'completed']);
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value));
const problem = (status, code) => Object.assign(new Error(code), {status, code});
const isAdvisoryStage = stage => stage === 'consultation' || stage === 'design';
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
  const {operation} = store.getWork(projectId, undefined, {excludeRealtime: true});
  if (operation?.route !== 'api') return null;
  const phase = currentPhase(operation, localJob(operation.executionId));
  return {id: operation.taskId, kind: 'api', phase, route: operation.route, model: operation.model, stage: operation.task?.stage,
    observedAt: observedAt(operation), createdAt: operation.createdAt, startedAt: operation.dispatchedAt ?? null,
    terminal: terminalPhases.has(phase)};
}

export function createApiDevelopment({directory, store, conversations, withProjectWorkLock, hasNativeWork, hasActiveWork,
  completedNativeSource, readHandoverTurn,
  getKey = () => process.env.OPENAI_API_KEY, fetchImpl, readAuthority = readApiAuthority}) {
  const jobs = new Map();
  const artifacts = join(directory, 'api-work');
  let closing = false;

  function enrolledCheckout(current) {
    const projectId = current.id;
    const checkout = join(directory, 'workspaces', projectId);
    try {
      const marker = join(checkout, '.hq-owned-workspace');
      const info = lstatSync(marker);
      if (!current.cwd.includes(checkout) || realpathSync(checkout) !== checkout || !info.isFile() ||
          info.uid !== process.getuid() || info.nlink !== 1 || info.size > 100 || readFileSync(marker, 'utf8').trim() !== projectId) {
        throw problem(409, 'API_WORKSPACE_NOT_ENROLLED');
      }
    } catch { throw problem(409, 'API_WORKSPACE_NOT_ENROLLED'); }
    return checkout;
  }

  function ownedProject(projectId) {
    const current = readCurrentProject(directory, projectId);
    if (!current || held.has(current.state) || closing) throw problem(409, 'EXECUTION_HELD');
    return {current, checkout:enrolledCheckout(current)};
  }

  function reservationAuthority(forDispatch, now = Date.now()) {
    try { return readBoundApiAuthority(directory, store, now, {forDispatch, readAuthority}); }
    catch (cause) { throw problem(409, cause.code ?? 'API_AUTHORITY_INVALID'); }
  }

  function authorized(projectId, forDispatch = true) {
    if (process.platform !== 'darwin') throw problem(409, 'API_RUNTIME_UNSUPPORTED');
    const key = getKey();
    if (typeof key !== 'string' || !key.trim()) throw problem(409, 'API_AUTHORIZATION_REQUIRED');
    const owned = ownedProject(projectId);
    const authority = reservationAuthority(forDispatch);
    if (!Object.hasOwn(authority.projects, projectId)) throw problem(409, 'API_WORKSPACE_NOT_ENROLLED');
    return {...owned, authority, enrollment: authority.projects[projectId]};
  }

  function context(authority, model, stage) {
    return {capabilities: {api: {available: true, executorId: 'owner-mac-responses', defaultModel: authority.defaultModel,
      models: authority.models}}, safety: {authorized: true, status: 'ready', allowedRoutes: ['api'], api: {
      ...verifiedApiCredit(authority),
      maxRequestCostUsd: maximumApiJobUsd(model, isAdvisoryStage(stage) ? 1 : apiJobRounds),
    }}};
  }

  function binding(scope, model) {
    return digest({organization: scope.authority.organization, project: scope.authority.providerProject,
      ledger: scope.authority.ledgerBinding, checkout: scope.checkout, goal: scope.current.goal,
      requirementsSource: scope.current.handoverRequirements, enrollment: scope.enrollment, model});
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

  function completedReport(projectId, work) {
    if (work?.status !== 'completed') return null;
    const report = resultReport(work);
    if (report?.projectId !== projectId || report.executionId !== work.executionId || !Array.isArray(report.changes)) return null;
    if (report.kind === 'advice') {
      return isAdvisoryStage(work.task?.stage) && report.changes.length === 0 && report.candidate === null &&
        typeof report.summary === 'string' && report.summary.trim() && report.summary.length <= apiAdviceMaxLength ? report : null;
    }
    return report.verification?.passed === true && report.changes.length ? report : null;
  }

  function verifiedReport(projectId, work) {
    const report = completedReport(projectId, work);
    return report?.changes.length ? report : null;
  }

  function retainedChanges(projectId, operations) {
    const changes = new Map();
    for (const work of operations) {
      const report = completedReport(projectId, work);
      if (!report) throw problem(409, 'API_CANDIDATE_HANDOVER_REQUIRED');
      for (const change of report.changes) changes.set(change.path, change);
      for (const artifact of report.nativeHandover?.artifacts ?? []) changes.set(artifact.path, artifact);
    }
    return [...changes.values()];
  }

  function view(project, work) {
    if (!work || work.route !== 'api' || work.kind === 'realtime-voice') return {operation: null};
    const phase = currentPhase(work, jobs.get(work.executionId));
    const output = resultReport(work);
    const changes = work.status === 'completed' ? output?.changes ?? [] : [];
    return {operation: {id: work.taskId, project, route: 'api', stage: work.task?.stage, model: work.model, phase,
      createdAt: work.createdAt, startedAt: work.dispatchedAt ?? null, updatedAt: observedAt(work),
      ...(work.nativeOrigin ? {nativeOrigin: work.nativeOrigin} : {}),
      ...(work.providerReceipts?.length ? {providerReceipts: work.providerReceipts} : {}),
      result: output?.reason ?? work.reason ?? (phase === 'unconfirmed' ? 'API_SETTLEMENT_UNKNOWN' : null),
      ...(work.status === 'completed' && output?.kind === 'advice' ? {advice: output.summary} : {}),
      verification: output?.verification ?? null, artifactCount: changes.length,
      changes: changes.map(({path, sha256, bytes}) => ({path, sha256, bytes}))}};
  }

  function archiveOutcome(projectId, work) {
    const outcome = publicPhase[work.status];
    if (!terminalPhases.has(outcome) && outcome !== 'unconfirmed') return;
    const report = outcome === 'completed' ? resultReport(work) : null;
    if (outcome === 'completed' && !report) throw problem(409, 'API_ARTIFACT_CHANGED');
    conversations.finishDevelopment(projectId, {id: work.executionId, outcome, summary: report?.summary ?? '',
      preserveSummary: report?.kind === 'advice', updatedAt: observedAt(work)});
  }

  async function run({project, operation, prior, scope, model, prompt, controller, approvedArtifacts}) {
    const projectId = project.id;
    const {executionId, taskId} = operation;
    const stage = operation.task?.stage;
    const advice = isAdvisoryStage(stage);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const jobRoot = join(artifacts, executionId);
    let dispatched = false;
    let awaitingReceipt = false;
    let spentMicros = 0;
    let baseSha = null;
    let verification = null;
    let finished = null;
    let completed = false;
    let requirements = null;
    let summary = '';
    let conversationSaved = false;
    let handover;
    let reason = advice ? 'API_OUTPUT_UNUSABLE' : 'API_VERIFICATION_FAILED';
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
      let previousChanges = retainedChanges(projectId, prior.verifiedApiOperations);
      const requirementsPath = scope.current.handoverRequirements;
      if (requirementsPath && scope.enrollment.files.some(file => file.path === requirementsPath && file.writable)) {
        throw problem(409, 'HANDOVER_REQUIREMENTS_CHANGED');
      }
      if (approvedArtifacts) {
        const changed = new Map(approvedArtifacts.map(file => [file.path, file]));
        previousChanges = previousChanges.map(change => changed.get(change.path) ?? change);
      }
      const workspace = {checkout: scope.checkout, jobRoot, files: scope.enrollment.files,
        testPaths: scope.enrollment.testPaths, priorChanges: previousChanges, signal};
      const candidate = advice ? null : await prepareApiWorkspace(workspace);
      const advisoryContext = advice ? await readAdvisoryWorkspace(workspace) : null;
      if (advice) await mkdir(jobRoot, {mode: 0o700});
      baseSha = advisoryContext?.baseSha ?? candidate.context().baseSha;
      if (requirementsPath) {
        const source = await checkedEvidence(scope.checkout, [requirementsPath], signal, 'HANDOVER_REQUIREMENTS_CHANGED');
        if (source.head !== baseSha) throw problem(409, 'HANDOVER_REQUIREMENTS_CHANGED');
        [requirements] = source.files;
      }
      if (operation.nativeOrigin) {
        handover = await approvedNativeOrigin(project, operation.nativeOrigin, operation);
        const supplied = new Map(advisoryContext.files.map(file => [file.path, file.text]));
        if (handover.proof.checkoutHead !== baseSha || handover.files.some(file =>
          typeof supplied.get(file.path) !== 'string' || sha(supplied.get(file.path)) !== file.sha256)) {
          throw problem(409, 'NATIVE_HANDOVER_ENROLLMENT_REQUIRED');
        }
      }
      const client = createApiResponseClient({key: getKey(), organization: scope.authority.organization,
        project: scope.authority.providerProject, fetchImpl});
      const respond = advice ? client.advise : client.propose;
      for (let round = 0; round < (advice ? 1 : apiJobRounds); round++) {
        const answer = await respond({model, effort: operation.reasoningEffort, prompt,
          context: advice ? {...advisoryContext, requirements, ...(handover ? {handover: handover.context} : {})} : candidate.context(),
          feedback: verification?.output, signal, beforeSend: () => {
            const fresh = reauthorize();
            const policy = context(fresh.authority, model, stage);
            if (handover) {
              handover.assertCurrent();
              policy.nativeOrigin = operation.nativeOrigin;
            }
            const decision = dispatched ? store.recheckDispatched(projectId, taskId, executionId, policy)
              : store.markDispatched(projectId, taskId, executionId, policy);
            if (!decision.dispatchable) throw problem(409, decision.code);
            dispatched = true;
            awaitingReceipt = true;
          }});
        const accountedMicros = moneyMicros(answer.accountedUsd, 'ceil');
        store.recordApiReceipt({projectId, taskId, executionId, round, receipt: answer.receipt, accountedMicros});
        spentMicros += accountedMicros;
        awaitingReceipt = false;
        signal.throwIfAborted();
        if (!(advice ? answer.answer : answer.proposal) || spentMicros > operation.reservedMicros) {
          reason = answer.code ?? 'API_RESERVATION_EXCEEDED';
          break;
        }
        if (advice) {
          summary = answer.answer;
          completed = true;
          reason = null;
          break;
        }
        await candidate.apply(answer.proposal.changes);
        verification = await candidate.verify({signal});
        signal.throwIfAborted();
        if (verification.passed) {
          const result = await candidate.finish();
          if (result.changes.length) { finished = result; summary = answer.proposal.summary; completed = true; reason = null; }
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
    if (completed) {
      try {
        if (requirements) {
          const source = await checkedEvidence(scope.checkout, [requirements.path], signal, 'HANDOVER_REQUIREMENTS_CHANGED');
          if (source.head !== baseSha || source.files[0].sha256 !== requirements.sha256) throw problem(409, 'HANDOVER_REQUIREMENTS_CHANGED');
        }
        reauthorize(false);
        handover?.assertCurrent();
      } catch (cause) {
        finished = null;
        completed = false;
        reason = signal.aborted ? 'INTERRUPTED' : cause.code ?? 'API_AUTHORITY_CHANGED';
      }
    }
    const report = {executionId, projectId, baseSha, reason, verification, kind: advice ? 'advice' : 'development',
      summary: completed ? summary : '', requirements,
      ...(handover ? {nativeHandover: {...handover.proof, threadId: handover.context.threadId, turnId: handover.context.turnId}} : {}),
      candidate: finished ? basename(finished.candidatePath) : null,
      changes: finished?.changes ?? []};
    const bytes = JSON.stringify(report);
    writeFileSync(join(jobRoot, 'result.json'), bytes, {flag: 'wx', mode: 0o600});
    const checkpoint = {id: executionId, version: (prior.checkpoint?.version ?? 0) + 1, goalId: projectId,
      requirementsHash: digest({goal: scope.current.goal, baseSha, files: scope.enrollment.files, requirements}),
      conversationHash: digest({prior: prior.checkpoint?.conversationHash ?? null, instruction: operation.instructionDigest,
        ...(handover ? {native: handover.proof.transcript.sha256} : {})}),
      stopHash: digest({scope: fingerprint, phase: signal.aborted ? 'interrupted' : 'settled'}),
      budgetHash: digest({organization: scope.authority.organization, reservedMicros: operation.reservedMicros, spentMicros}),
      artifactsHash: sha(bytes)};
    const saved = store.recordOutcome({projectId, taskId, executionId, outcome: signal.aborted ? 'interrupted' : completed ? 'completed' : 'failed',
      confirmedTerminal: true, effectsReconciled: true, actualCostUsd: spentMicros / 1_000_000, checkpoint});
    archiveOutcome(projectId, saved.operation);
  }

  async function checkedEvidence(checkout, paths, signal, failure) {
    try { return await readCommittedEvidence({checkout, paths, signal}); }
    catch { throw problem(409, failure); }
  }

  function handoverState(project, exceptOperation) {
    const owned = ownedProject(project.id);
    const work = store.getWork(project.id);
    const {settings, revision} = store.getSettings(project.id);
    if (work.busy || hasActiveWork(project, exceptOperation) || conversations.hasActiveLive(project.id)) throw problem(409, 'PROJECT_BUSY');
    if (!settings.allowedRoutes.includes('subscription')) throw problem(409, 'ROUTE_NOT_ALLOWED');
    const stamp = digest({checkout: owned.checkout, goal: owned.current.goal, requirement: owned.current.handoverRequirements,
      status: owned.current.state, revision, settings, checkpoint: work.checkpoint, settledApiMicros: work.settledApiMicros,
      artifactReceipts: work.verifiedApiOperations.map(operation => operation.artifactsHash)});
    return {owned, work, revision, stamp, settings};
  }

  async function inspectHandover(project, receipt, exceptOperation) {
    if (!receiptKey.test(receipt ?? '')) throw problem(404, 'API_TASK_NOT_FOUND');
    const {owned, work, revision, stamp, settings} = handoverState(project, exceptOperation);
    const predecessor = work.checkpointOperation;
    if (predecessor?.executionId !== receipt || predecessor.route !== 'api' || !work.checkpoint ||
        work.checkpoint.artifactsHash !== predecessor.artifactsHash) throw problem(409, 'HANDOVER_RECEIPT_STALE');
    const report = completedReport(project.id, predecessor);
    if (!report) throw problem(409, 'API_CANDIDATE_HANDOVER_REQUIRED');
    if (!owned.current.handoverRequirements || !report.requirements) throw problem(409, 'HANDOVER_REQUIREMENTS_MISSING');
    if (report.requirements.path !== owned.current.handoverRequirements) throw problem(409, 'HANDOVER_REQUIREMENTS_CHANGED');
    const archiveId = `api/${receipt}`;
    const archived = conversations.read(project.id, archiveId, 0)?.conversation;
    const prompt = archived?.messages[0];
    const summary = archived?.messages[1];
    if (archived?.source !== 'api-development' || archived.outcome !== 'completed' || archived.model !== predecessor.model ||
        prompt?.role !== 'user' || sha(prompt.text) !== predecessor.instructionDigest ||
        (report.kind === 'advice' ? report.summary : (report.summary ?? '').trim()) !== (summary?.role === 'assistant' ? summary.text : '')) {
      throw problem(409, 'HANDOVER_CONVERSATION_UNVERIFIED');
    }
    const signal = AbortSignal.timeout(12000);
    const changes = retainedChanges(project.id, work.verifiedApiOperations);
    const current = await checkedEvidence(owned.checkout, [report.requirements.path], signal, 'HANDOVER_REQUIREMENTS_CHANGED');
    if (current.files[0].sha256 !== report.requirements.sha256) throw problem(409, 'HANDOVER_REQUIREMENTS_CHANGED');
    const artifacts = [];
    // Four maximum-size source files fit the evidence reader's per-read limit.
    const groupSize = 4;
    for (let index = 0; index < changes.length; index += groupSize) {
      const group = changes.slice(index, index + groupSize);
      const readback = await checkedEvidence(owned.checkout, group.map(change => change.path), signal, 'API_CANDIDATE_HANDOVER_REQUIRED');
      if (readback.head !== current.head || readback.files.some((file, entry) => file.sha256 !== group[entry].sha256)) {
        throw problem(409, 'API_CANDIDATE_HANDOVER_REQUIRED');
      }
      artifacts.push(...readback.files);
    }
    const finalRequirements = await checkedEvidence(owned.checkout, [report.requirements.path], signal, 'HANDOVER_REQUIREMENTS_CHANGED');
    if (finalRequirements.head !== current.head || finalRequirements.files[0].sha256 !== report.requirements.sha256) {
      throw problem(409, 'HANDOVER_REQUIREMENTS_CHANGED');
    }
    if (handoverState(project, exceptOperation).stamp !== stamp) throw problem(409, 'API_CANDIDATE_HANDOVER_REQUIRED');
    const review = digest({project: project.id, receipt, stamp, checkoutHead: current.head, requirements: finalRequirements.files[0], artifacts});
    const proof = {verified: true, kind: 'rehearsal', source: 'api', destination: 'subscription', receipt, review, archiveId, revision,
      checkoutHead: current.head, requirements: finalRequirements.files[0], artifacts, settledApiMicros: work.settledApiMicros};
    return {proof, checkout: owned.checkout, stamp, context: {project: project.id, goal: owned.current.goal, apiReceipt: receipt, archiveId,
      originalInstruction: prompt.text, resultSummary: summary?.text ?? '', checkoutHead: proof.checkoutHead,
      requirements: proof.requirements, artifacts, settingsRevision: revision, apiBudgetUsd: settings.apiBudgetUsd ?? null,
      settledApiMicros: work.settledApiMicros}};
  }

  function nativeHandoverState(project, threadId, exceptOperation) {
    const owned = ownedProject(project.id);
    const work = store.getWork(project.id);
    const {settings, revision} = store.getSettings(project.id);
    if ((work.busy && work.operation?.executionId !== exceptOperation?.executionId) ||
        hasActiveWork(project) || conversations.hasActiveLive(project.id)) throw problem(409, 'PROJECT_BUSY');
    if (!settings.allowedRoutes.includes('api')) throw problem(409, 'ROUTE_NOT_ALLOWED');
    const source = completedNativeSource(project, owned.checkout, threadId);
    if (!source) throw problem(409, 'HANDOVER_RECEIPT_STALE');
    const checkpoint = owned.current.nativeHandover;
    const fileEvidence = file => typeof file?.path === 'string' && evidenceHash.test(file.sha256 ?? '');
    if (checkpoint?.version !== 1 || checkpoint.operationId !== source.id || checkpoint.threadId !== source.threadId ||
        checkpoint.turnId !== source.turnId || !gitRevision.test(checkpoint.checkoutHead ?? '') ||
        !evidenceHash.test(checkpoint.requirementsSha256 ?? '') || !evidenceHash.test(checkpoint.transcriptSha256 ?? '') ||
        checkpoint.shareConversation !== true || checkpoint.effectsReconciled !== true ||
        !owned.current.handoverRequirements || !fileEvidence(checkpoint.verification) || !Array.isArray(checkpoint.artifacts) ||
        checkpoint.artifacts.length > 22 || !checkpoint.artifacts.every(fileEvidence)) {
      throw problem(409, 'NATIVE_HANDOVER_CHECKPOINT_REQUIRED');
    }
    const requirements = {path: owned.current.handoverRequirements, sha256: checkpoint.requirementsSha256};
    const verification = {path: checkpoint.verification.path, sha256: checkpoint.verification.sha256};
    const artifacts = checkpoint.artifacts.map(({path, sha256}) => ({path, sha256}));
    const stamp = digest({source, checkpoint, requirements, goal: owned.current.goal, status: owned.current.state,
      revision, settings, apiCheckpoint: work.checkpoint, settledApiMicros: work.settledApiMicros});
    return {owned, source, checkpoint, requirements, verification, artifacts, stamp, settings, revision,
      settledApiMicros: work.settledApiMicros};
  }

  async function inspectNativeHandover(project, threadId, exceptOperation) {
    if (typeof threadId !== 'string' || !taskKey.test(threadId)) throw problem(404, 'API_TASK_NOT_FOUND');
    const {owned, source, checkpoint, requirements, verification, artifacts, stamp, settings, revision, settledApiMicros} =
      nativeHandoverState(project, threadId, exceptOperation);
    const files = [requirements, verification, ...artifacts];
    const git = await checkedEvidence(owned.checkout, files.map(file => file.path), AbortSignal.timeout(12000), 'NATIVE_HANDOVER_GIT_CHANGED');
    if (git.head !== checkpoint.checkoutHead || git.files.some((file, index) => file.sha256 !== files[index].sha256)) {
      throw problem(409, 'NATIVE_HANDOVER_GIT_CHANGED');
    }
    const turn = await readHandoverTurn(owned.checkout, threadId, source.turnId, source.id);
    if (turn?.threadId !== threadId || turn.turnId !== source.turnId || !Array.isArray(turn.messages) ||
        digest(turn.messages) !== checkpoint.transcriptSha256) throw problem(409, 'HANDOVER_CONVERSATION_UNVERIFIED');
    function assertCurrent() {
      if (nativeHandoverState(project, threadId, exceptOperation).stamp !== stamp ||
          !checkedEvidenceIsCurrent({checkout: owned.checkout, head: git.head, files, requireClean: true})) {
        throw problem(409, 'NATIVE_HANDOVER_GIT_CHANGED');
      }
    }
    assertCurrent();
    const proof = {verified: true, source: 'subscription', destination: 'api', receipt: source.id, review: stamp,
      checkoutHead: git.head, requirements, artifacts, verification,
      transcript: {sha256: checkpoint.transcriptSha256, messages: turn.messages.length}};
    const context = {project: project.id, goal: owned.current.goal, operationId: source.id, threadId, turnId: source.turnId,
      previousApiReceipt: source.handoverReceipt, checkoutHead: git.head, requirements, artifacts, verification,
      stopState: owned.current.state, settingsRevision: revision, apiBudgetUsd: settings.apiBudgetUsd ?? null,
      settledApiMicros, messages: turn.messages};
    return {proof, assertCurrent, files, context};
  }

  async function approvedNativeOrigin(project, origin, exceptOperation) {
    const checked = await inspectNativeHandover(project, origin.threadId, exceptOperation);
    if (origin.operationId !== checked.proof.receipt || origin.review !== checked.proof.review) {
      throw problem(409, 'HANDOVER_RECEIPT_STALE');
    }
    return checked;
  }

  return {
    async previewHandover(project, receipt) { return (await inspectHandover(project, receipt)).proof; },
    async previewNativeHandover(project, threadId) { return (await inspectNativeHandover(project, threadId)).proof; },
    async prepareNativeHandover(project, {receipt, review}, workspace, exceptOperation) {
      const state = await inspectHandover(project, receipt, exceptOperation);
      if (state.checkout !== workspace || state.proof.review !== review) throw problem(409, 'HANDOVER_RECEIPT_STALE');
      return {context: state.context, revision: state.proof.revision, stillCurrent: () =>
        handoverState(project, exceptOperation).stamp === state.stamp && checkedEvidenceIsCurrent({
          checkout: state.checkout, head: state.proof.checkoutHead, files: [state.proof.requirements, ...state.proof.artifacts],
        })};
    },
    activity(project) { return latestApiActivity(store, project.id, id => jobs.get(id)); },
    recentOutcomes(projects, now) {
      if (process.platform !== 'darwin' || projects.size === 0) return [];
      let authority, settled;
      try {
        authority = reservationAuthority(false, now);
        const enrolled = [...projects.values()].filter(project => {
          if (!Object.hasOwn(authority.projects, project.id)) return false;
          try { return Boolean(enrolledCheckout(project)); } catch { return false; }
        });
        settled = store.listSettledApiWork(enrolled.map(project => project.id));
      } catch { return []; }
      const results = [];
      for (const {project, operation} of settled) {
        const {taskId, executionId, status, createdAt, dispatchedAt, completedAt} = operation;
        if (operation.executorId !== 'owner-mac-responses' || operation.organizationId !== authority.organization ||
            !taskKey.test(taskId) || !receiptKey.test(executionId) || !observedWorkTime(completedAt, now) ||
            !observedWorkTime(dispatchedAt, Date.parse(completedAt)) || !observedWorkTime(createdAt, Date.parse(dispatchedAt))) continue;
        if (status === 'completed') {
          if (!operation.providerReceipts?.some(receipt => receipt.id !== null &&
              observedWorkTime(receipt.observedAt, Date.parse(completedAt)) && receipt.observedAt >= dispatchedAt) ||
              !completedReport(project, operation)) continue;
        } else {
          const report = resultReport(operation);
          const kind = isAdvisoryStage(operation.task?.stage) ? 'advice' : 'development';
          if (report?.projectId !== project || report.executionId !== executionId || report.kind !== kind ||
              typeof report.reason !== 'string' || !report.reason || report.candidate !== null ||
              !Array.isArray(report.changes) || report.changes.length) continue;
        }
        results.push({projectId:project, id:taskId, kind:'api', phase:status, observedAt:completedAt});
        if (results.length === workOutcomeLimit) break;
      }
      return results;
    },
    listArtifacts(projectIds, offset) {
      const operations = store.listVerifiedApiWork(projectIds);
      const page = operations.slice(offset, offset + 16);
      const files = page.flatMap(({project, operation}) => {
        const report = verifiedReport(project, operation);
        if (!report) return [];
        return report.changes.map((file, index) => ({project, kind: 'file', title: file.path, description: '通常APIで検証済み',
          observedAt: operation.completedAt, sha256: file.sha256,
          href: '/api/artifacts/work/file?' + new URLSearchParams({project, id: operation.taskId, index})}));
      });
      const following = offset + page.length;
      return {artifacts: files, nextOffset: following < operations.length ? following : null};
    },
    conversationView(project, result, offset) {
      const {conversation} = result;
      if (conversation.source !== 'api-development') return result;
      const observed = outcome => ({...result, conversation: {...conversation, outcome}});
      try {
        const work = store.findExecution(project.id, conversation.id.slice('api/'.length));
        if (work?.route !== 'api') return terminalPhases.has(conversation.outcome) ? result : observed('unconfirmed');
        const withReceipts = view => work.providerReceipts?.length && view ?
          {...view, conversation: {...view.conversation, providerReceipts: work.providerReceipts}} : view;
        if (terminalPhases.has(conversation.outcome)) return withReceipts(result);
        const saved = publicPhase[work.status];
        if (terminalPhases.has(saved) || (saved === 'unconfirmed' && conversation.outcome !== 'unconfirmed')) {
          archiveOutcome(project.id, work);
          return withReceipts(conversations.read(project.id, conversation.id, offset));
        }
        const phase = currentPhase(work, jobs.get(work.executionId));
        return withReceipts(observed(phase === 'running' ? 'in_progress' : phase));
      } catch { return terminalPhases.has(conversation.outcome) ? result : observed('unconfirmed'); }
    },
    capabilities(project) {
      try {
        if (!store.getSettings(project.id).settings.allowedRoutes.includes('api')) throw problem(409, 'ROUTE_NOT_ALLOWED');
        const {authority} = authorized(project.id);
        return {available: true, defaultModel: authority.defaultModel,
          models: authority.models.map(({id, reasoningEfforts}) => ({id, reasoningEfforts}))};
      } catch (cause) { return {available: false, reason: cause.code ?? 'API_AUTHORIZATION_REQUIRED', models: []}; }
    },
    portfolioActivity(project, operation) {
      if (operation?.route !== 'api' || operation.kind === 'realtime-voice' ||
          !project.cwd.includes(join(directory,'workspaces',project.id))) return null;
      const local = jobs.get(operation.executionId);
      const phase = currentPhase(operation, local);
      const receipts = operation.providerReceipts?.filter(receipt=>receipt.id !== null) ?? [];
      const observed = receipts.at(-1)?.observedAt ?? null;
      const reason = operation.status === 'cancelled' ? 'cancelled' :
        phase === 'unconfirmed' || phase === 'interrupting' || phase === 'reserved' || (phase === 'running' && !observed)
          ? 'unconfirmed' : ['failed','interrupted'].includes(phase) ? phase : null;
      return {route:'api', createdAt:operation.createdAt, updatedAt:observedAt(operation),
        observedAt:observed, active:phase === 'running' && Boolean(observed), reason};
    },
    read(project, id) {
      if (id !== undefined && !taskKey.test(id)) throw problem(400, 'API_TASK_INVALID');
      return view(project.id, store.getWork(project.id, id, {excludeRealtime: true}).operation);
    },
    async start(project, input) {
      if (!taskKey.test(input?.id ?? '') || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000 ||
          !STAGES.includes(input.stage ?? 'implementation') || input.model !== undefined && typeof input.model !== 'string' ||
          input.effort !== undefined && typeof input.effort !== 'string') throw problem(400, 'API_TASK_INVALID');
      const projectId = project.id;
      const inputDigest = sha(input.prompt);
      const task = {stage: input.stage ?? 'implementation', route: 'api', ...(input.model ? {model: input.model} : {}),
        ...(input.effort ? {reasoningEffort: input.effort} : {})};
      const {nativeOrigin} = input;
      if (nativeOrigin !== undefined && (!isAdvisoryStage(task.stage) || !nativeOrigin ||
          Object.keys(nativeOrigin).length !== 3 || ![nativeOrigin.threadId, nativeOrigin.operationId].every(value =>
            typeof value === 'string' && taskKey.test(value)) || typeof nativeOrigin.review !== 'string' ||
          !evidenceHash.test(nativeOrigin.review))) throw problem(400, 'API_TASK_INVALID');
      const replay = () => {
        const duplicate = store.getWork(projectId, input.id).operation;
        if (!duplicate) return null;
        if (duplicate.kind !== undefined || duplicate.instructionDigest !== inputDigest || digest(duplicate.task) !== digest(task) ||
            ['threadId', 'operationId', 'review'].some(key => duplicate.nativeOrigin?.[key] !== nativeOrigin?.[key])) {
          throw problem(409, 'TASK_ID_CONFLICT');
        }
        return view(projectId, duplicate);
      };
      const duplicate = replay();
      if (duplicate) return duplicate;
      let handover;
      if (nativeOrigin) {
        try { handover = await approvedNativeOrigin(project, nativeOrigin); }
        catch (cause) { const concurrent = replay(); if (concurrent) return concurrent; throw cause; }
      }
      return withProjectWorkLock(project, () => {
        const concurrent = replay();
        if (concurrent) return concurrent;
        if (handover) handover.assertCurrent();
        else if (hasNativeWork(project)) throw problem(409, 'HANDOVER_REQUIRED');
        const scope = authorized(projectId);
        const prior = store.getWork(projectId);
        const {settings, revision} = store.getSettings(projectId);
        const model = scope.authority.models.find(item => item.id === (input.model ?? settings.model ?? scope.authority.defaultModel));
        if (!model) throw problem(409, 'MODEL_UNAVAILABLE');
        const receipt = store.prepareDispatch({projectId, taskId: input.id, instructionDigest: inputDigest, expectedRevision: revision, task, nativeOrigin},
          context(scope.authority, model, task.stage));
        if (!receipt.dispatchable) throw problem(409, receipt.code);
        const operation = receipt.operation;
        const controller = new AbortController();
        const worker = Promise.resolve().then(() => run({project, operation, prior, scope, model, prompt: input.prompt, controller,
          approvedArtifacts: handover?.proof.artifacts})).catch(() => {
          // Ambiguous persistence or provider state holds the reservation. Never restart on its own.
        }).finally(() => jobs.delete(operation.executionId));
        jobs.set(operation.executionId, {worker, controller});
        return view(projectId, operation);
      });
    },
    interrupt(project, taskId) {
      if (typeof taskId !== 'string' || !taskKey.test(taskId)) throw problem(400, 'API_TASK_INVALID');
      const {operation} = store.getWork(project.id, taskId);
      if (!operation || operation.route !== 'api' || operation.kind === 'realtime-voice') throw problem(404, 'API_TASK_NOT_FOUND');
      const local = jobs.get(operation.executionId);
      if (local) local.controller.abort();
      if (operation.status === 'reserved') store.cancelReserved(project.id, taskId, operation.executionId);
      return view(project.id, store.getWork(project.id, taskId).operation);
    },
    async artifact(project, taskId, index) {
      if (typeof taskId !== 'string' || !taskKey.test(taskId) || !Number.isSafeInteger(index) || index < 0) throw problem(404, 'API_ARTIFACT_NOT_FOUND');
      const {operation} = store.getWork(project.id, taskId);
      const result = verifiedReport(project.id, operation);
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
