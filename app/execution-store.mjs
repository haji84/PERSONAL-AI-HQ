import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { moneyMicros, normalizeSettings, resolveExecution, verifyHandover } from './execution-policy.mjs';
import {maximumRealtimeCostMicros, normalizeRealtimeCostConfig, realtimeResponseMicros, realtimeTranscriptionMicros} from './realtime-cost.mjs';

const active = new Set(['reserved', 'running', 'uncertain', 'awaiting_settlement']);
const terminals = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const hasApiArtifact = item => item.route === 'api' && item.status === 'completed' && item.artifactsHash;
const hashPattern = /^[a-f0-9]{64}$/;
const realtimeKind = 'realtime-voice';
const realtimePhases = new Set(['not_committed', 'uncertain', 'terminal']);
const realtimeOutcomes = new Set(['completed', 'failed', 'interrupted']);
const responseOutcomes = new Set(['completed', 'cancelled', 'failed', 'incomplete']);
const receiptId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const error = code => { throw new Error(code); };
const clone = value => structuredClone(value);
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value) || ['constructor', 'prototype'].includes(value)) error('INVALID_ID');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const denial = code => ({ allowed: false, dispatchable: false, code });
const validNativeOrigin = origin => origin !== null && typeof origin === 'object' && Object.keys(origin).length === 3 &&
  typeof origin.threadId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(origin.threadId) &&
  typeof origin.operationId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(origin.operationId) &&
  typeof origin.review === 'string' && hashPattern.test(origin.review);
const validProviderReceipt = receipt => receipt !== null && typeof receipt === 'object' && Object.keys(receipt).length === 5 &&
  (receipt.id === null || (typeof receipt.id === 'string' && receipt.id.startsWith('resp_') &&
    receipt.id.length >= 6 && receipt.id.length <= 128 && !/[^A-Za-z0-9]/.test(receipt.id.slice(5)))) &&
  [receipt.inputTokens, receipt.outputTokens, receipt.accountedMicros].every(count => Number.isSafeInteger(count) && count >= 0) &&
  typeof receipt.observedAt === 'string' && Number.isFinite(Date.parse(receipt.observedAt));
const lastOperation = operations => operations.reduce((latest, item) =>
  !latest || item.createdAt >= latest.createdAt ? item : latest, null);
const settingFields = Object.keys(normalizeSettings());
const emptyProject = initial => ({
  revision: 0, settings: initial?.settings ?? normalizeSettings(), updatedAt: initial?.updatedAt,
  history: initial ? [{revision:0, ...initial}] : [], operations: {}, spentMicros: 0,
  lastRoute: null, lastExecution: null, checkpoint: null,
});

function realtimeAdmission(project, task, context) {
  const scope = context.realtimeVoice;
  const config = normalizeRealtimeCostConfig(scope?.config);
  const cost = config && maximumRealtimeCostMicros(config);
  if (!config || !Number.isSafeInteger(cost) || cost <= 0 || cost > 1_000_000_000_000 ||
      !hashPattern.test(scope?.scopeDigest ?? '') || task?.route !== 'api' || task.stage !== 'consultation' ||
      task.model !== config.model || task.reasoningEffort !== 'none') return denial('REALTIME_VOICE_AUTHORITY_REQUIRED');
  if (project.settings.mode === 'hybrid' && project.settings.stageRoutes.consultation !== 'api') return denial('ROUTE_NOT_ALLOWED');
  return {allowed: true, realtimeVoice: {config, scopeDigest: scope.scopeDigest}, context: {...context,
    safety: {...context.safety, api: {...context.safety?.api, maxRequestCostUsd: cost / 1_000_000}}}};
}

function realtimeUsage(usage, kind) {
  if (!usage || typeof usage !== 'object') error('INVALID_REALTIME_RECEIPT');
  if (kind === 'transcription' && usage.type === 'duration') {
    if (!Number.isFinite(usage.seconds) || usage.seconds < 0) error('INVALID_REALTIME_RECEIPT');
    return {type: 'duration', seconds: usage.seconds};
  }
  const {totalTokens, inputTokens, outputTokens} = usage;
  if (![totalTokens, inputTokens, outputTokens].every(count => Number.isSafeInteger(count) && count >= 0) ||
      totalTokens !== inputTokens + outputTokens) error('INVALID_REALTIME_RECEIPT');
  function modalities(details, total) {
    const {textTokens, audioTokens} = details ?? {};
    if (![textTokens, audioTokens].every(count => Number.isSafeInteger(count) && count >= 0) ||
        (total !== undefined && textTokens + audioTokens !== total)) error('INVALID_REALTIME_RECEIPT');
    return {textTokens, audioTokens};
  }
  const input = modalities(usage.input, inputTokens);
  const totals = {totalTokens, inputTokens, outputTokens, input};
  if (kind === 'transcription') {
    if (usage.type !== 'tokens') error('INVALID_REALTIME_RECEIPT');
    return {type: 'tokens', ...totals};
  }
  const cachedInput = modalities(usage.cachedInput);
  if (cachedInput.audioTokens > input.audioTokens || cachedInput.textTokens > input.textTokens) error('INVALID_REALTIME_RECEIPT');
  return {...totals, output: modalities(usage.output, outputTokens), cachedInput};
}

function realtimeSettlement(config, {phase, outcome, receipts, reason}) {
  if (!realtimePhases.has(phase) || !realtimeOutcomes.has(outcome) || typeof receipts?.responseRequested !== 'boolean' ||
      (phase !== 'terminal' && outcome === 'completed') || (reason !== undefined &&
      (typeof reason !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(reason)))) error('INVALID_REALTIME_SETTLEMENT');
  const {responseRequested} = receipts;
  if (phase === 'not_committed' && (responseRequested || receipts.response || receipts.transcription) ||
      !responseRequested && receipts.response || (!responseRequested && phase === 'terminal' && outcome !== 'interrupted')) {
    error('INVALID_REALTIME_SETTLEMENT');
  }
  let response = null;
  let transcription = null;
  if (receipts.response) {
    const {id, status} = receipts.response;
    if (typeof id !== 'string' || !receiptId.test(id) || !responseOutcomes.has(status) ||
        (outcome === 'completed' && status !== 'completed')) error('INVALID_REALTIME_RECEIPT');
    const usage = realtimeUsage(receipts.response.usage, 'response');
    response = {id, status, usage, accountedMicros: realtimeResponseMicros(config, usage)};
  }
  if (receipts.transcription) {
    const {itemId} = receipts.transcription;
    if (typeof itemId !== 'string' || !receiptId.test(itemId)) error('INVALID_REALTIME_RECEIPT');
    const usage = realtimeUsage(receipts.transcription.usage, 'transcription');
    transcription = {itemId, usage, accountedMicros: realtimeTranscriptionMicros(config, usage)};
  }
  return {phase, outcome, responseRequested, response, transcription, ...(reason ? {reason} : {})};
}

// One owner-controlled server is the writer for this store. Do not replicate the
// file to create another budget authority on a second device.
export class ExecutionStore {
  constructor(file, { authorityId, initialProject } = {}) {
    this.file = path.resolve(file);
    this.authorityId = id(authorityId);
    this.initialProject = initialProject;
  }

  #read() {
    let text, info;
    try {
      info = fs.lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 64 * 1024 * 1024) error('STATE_INVALID');
      text = fs.readFileSync(this.file, 'utf8');
    } catch (cause) {
      if (cause.code === 'ENOENT') return { version: 1, authorityId: this.authorityId, projects: {}, organizations: {} };
      throw cause;
    }
    let data;
    try { data = JSON.parse(text); } catch { error('STATE_INVALID'); }
    if (data?.version !== 1 || !data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects) || !data.organizations || typeof data.organizations !== 'object' || Array.isArray(data.organizations)) error('STATE_INVALID');
    if (data.authorityId !== this.authorityId) error('AUTHORITY_MISMATCH');
    if (data.reservationAuthority !== undefined && (typeof data.reservationAuthority !== 'string' ||
      !hashPattern.test(data.reservationAuthority) || info.uid !== process.getuid?.() || (info.mode & 0o077))) error('STATE_INVALID');
    return data;
  }

  #change(action) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lockPath = `${this.file}.lock`;
    let lock;
    try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch (cause) {
      if (cause.code === 'EEXIST') error('STORE_BUSY');
      throw cause;
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const data = this.#read();
      const result = action(data);
      const output = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(output, JSON.stringify(data)); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      fs.renameSync(temporary, this.file);
      return clone(result);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }

  #project(data, projectId, {create = false, includeInitial = create} = {}) {
    id(projectId);
    if (!Object.hasOwn(data.projects, projectId)) {
      const project = emptyProject(includeInitial ? this.initialProject?.(projectId) : null);
      if (!create) return project;
      data.projects[projectId] = project;
    }
    const project = data.projects[projectId];
    if (!Number.isSafeInteger(project.revision) || project.revision < 0 || !Array.isArray(project.history) || !project.operations || typeof project.operations !== 'object' || Array.isArray(project.operations) || !Number.isSafeInteger(project.spentMicros) || project.spentMicros < 0) error('STATE_INVALID');
    if (!project.settings || typeof project.settings !== 'object' || Array.isArray(project.settings) || settingFields.some(key => !Object.hasOwn(project.settings, key))) error('STATE_INVALID');
    try { project.settings = normalizeSettings(project.settings); } catch { error('STATE_INVALID'); }
    if (project.lastRoute && (!project.lastExecution || project.lastExecution.route !== project.lastRoute || !project.lastExecution.model || !project.lastExecution.executorId || !verifyHandover(project.checkpoint, project.checkpoint).ok)) error('STATE_INVALID');
    for (const operation of Object.values(project.operations)) {
      if (!operation || !['api', 'subscription'].includes(operation.route) || (!active.has(operation.status) && !terminals.has(operation.status)) || !Number.isSafeInteger(operation.reservedMicros) || operation.reservedMicros < 0 || !Number.isSafeInteger(operation.costMicros) || operation.costMicros < 0) error('STATE_INVALID');
      if (typeof operation.model !== 'string' || !operation.model || typeof operation.executorId !== 'string' || !operation.executorId || typeof operation.executionId !== 'string' || !hashPattern.test(operation.fingerprint ?? '') || !hashPattern.test(operation.instructionDigest ?? '') || !Number.isSafeInteger(operation.settingsRevision) || operation.settingsRevision < 0) error('STATE_INVALID');
      if (operation.nativeOrigin !== undefined && (operation.route !== 'api' || !validNativeOrigin(operation.nativeOrigin))) error('STATE_INVALID');
      if (operation.providerReceipts !== undefined && (operation.route !== 'api' || !Array.isArray(operation.providerReceipts) ||
          operation.providerReceipts.length > 2 || !operation.providerReceipts.every(validProviderReceipt))) error('STATE_INVALID');
      if (operation.kind !== undefined && (operation.kind !== realtimeKind || operation.route !== 'api' ||
          operation.task?.stage !== 'consultation' || !hashPattern.test(operation.realtimeVoice?.scopeDigest ?? '') ||
          operation.realtimeVoice?.config?.model !== operation.model || operation.nativeOrigin !== undefined ||
          operation.providerReceipts !== undefined || operation.checkpointVersion !== undefined)) error('STATE_INVALID');
      if (operation.route === 'api') { try { id(operation.organizationId); } catch { error('STATE_INVALID'); } }
    }
    return project;
  }

  hasProject(projectId) {
    const key = id(projectId).toLowerCase();
    return Object.keys(this.#read().projects).some(project => project.toLowerCase() === key);
  }

  getSettings(projectId) {
    const project = this.#project(this.#read(), projectId, {includeInitial:true});
    return clone({ revision: project.revision, settings: project.settings, updatedAt: project.updatedAt ?? null, history: project.history });
  }

  #reservationBinding(instance) {
    if (instance === undefined) return null;
    const directory = path.dirname(this.file);
    const location = fs.lstatSync(directory, {bigint: true});
    const uid = process.getuid?.();
    if (!location.isDirectory() || uid === undefined || location.uid !== BigInt(uid) || (location.mode & 0o077n)) error('RESERVATION_AUTHORITY_UNSAFE');
    return digest({authorityId: this.authorityId, instance, host: os.hostname(), directory: fs.realpathSync(directory),
      file: path.basename(this.file), dev: String(location.dev), ino: String(location.ino)});
  }

  reservationBinding() {
    return this.#reservationBinding(this.#read().reservationAuthority);
  }

  initializeReservationAuthority() {
    return this.#change(data => {
      data.reservationAuthority ??= digest(randomUUID());
      return this.#reservationBinding(data.reservationAuthority);
    });
  }

  getWork(projectId, taskId, {excludeRealtime = false} = {}) {
    const project = this.#project(this.#read(), projectId);
    const operations = Object.values(project.operations);
    const selected = taskId === undefined ? lastOperation(excludeRealtime ? operations.filter(item => item.kind !== realtimeKind) : operations)
      : Object.hasOwn(project.operations, id(taskId)) ? project.operations[taskId] : null;
    const operation = excludeRealtime && selected?.kind === realtimeKind ? null : selected;
    const checkpointOperation = project.checkpoint
      ? operations.find(item => item.checkpointVersion === project.checkpoint.version) ?? null : null;
    const verifiedApiOperations = taskId === undefined ? operations.filter(hasApiArtifact)
      .sort((a, b) => a.checkpointVersion - b.checkpointVersion) : [];
    return clone({operation, checkpoint: project.checkpoint, checkpointOperation, verifiedApiOperations, settledApiMicros: project.spentMicros,
      busy: operations.some(item => active.has(item.status))});
  }

  portfolioPolicies(bindings) {
    const results = new Map();
    let data;
    try { data = this.#read(); } catch { return results; }
    for (const [projectId, {initial}] of bindings) {
      try {
        const project = Object.hasOwn(data.projects, projectId) ? this.#project(data, projectId)
          : initial === undefined ? null : emptyProject(initial);
        if (!project) continue;
        results.set(projectId, {mode:project.settings.mode,
          modeSource:project.revision || project.updatedAt ? 'saved' : 'default',
          operation:lastOperation(Object.values(project.operations))});
      } catch { /* A corrupt project must not hide other projects or invent its mode. */ }
    }
    return results;
  }

  findExecution(projectId, executionId) {
    id(executionId);
    const project = this.#project(this.#read(), projectId);
    return clone(Object.values(project.operations).find(item => item.executionId === executionId) ?? null);
  }

  listSettledApiWork(projectIds) {
    const data = this.#read();
    const settled = [];
    for (const project of projectIds) {
      try {
        const operations = this.#project(data, project).operations;
        for (const [key, operation] of Object.entries(operations)) {
          if (operation.route === 'api' && ['completed', 'failed'].includes(operation.status) &&
              operation.taskId === key && typeof operation.completedAt === 'string' &&
              Number.isSafeInteger(operation.checkpointVersion) && operation.checkpointVersion > 0 &&
              typeof operation.artifactsHash === 'string' && hashPattern.test(operation.artifactsHash)) {
            settled.push({project, operation});
          }
        }
      } catch { /* An unreadable project cannot establish its own outcomes. */ }
    }
    return settled.sort((a, b) => b.operation.completedAt.localeCompare(a.operation.completedAt) ||
      a.project.localeCompare(b.project) || a.operation.taskId.localeCompare(b.operation.taskId));
  }

  listVerifiedApiWork(projectIds) {
    const state = this.#read();
    return projectIds.flatMap(project => Object.values(this.#project(state, project).operations).filter(hasApiArtifact)
      .map(operation => ({project, operation})))
      .sort((a, b) => b.operation.completedAt.localeCompare(a.operation.completedAt) ||
        a.operation.executionId.localeCompare(b.operation.executionId));
  }

  updateSettings(projectId, expectedRevision, input) {
    return this.#change(data => {
      const project = this.#project(data, projectId, {create:true});
      if (project.revision !== expectedRevision) error('REVISION_CONFLICT');
      if (Object.values(project.operations).some(operation => active.has(operation.status))) error('PROJECT_BUSY');
      const merged = { ...project.settings, ...input };
      if (input.mode && input.mode !== project.settings.mode) {
        if (!Object.hasOwn(input, 'allowedRoutes')) delete merged.allowedRoutes;
        if (!Object.hasOwn(input, 'stageRoutes')) merged.stageRoutes = {};
        if (!Object.hasOwn(input, 'allowFallback')) merged.allowFallback = false;
      }
      const settings = normalizeSettings(merged);
      project.revision++;
      project.updatedAt = new Date().toISOString();
      project.settings = settings;
      project.history.push({ revision: project.revision, updatedAt: project.updatedAt, settings: clone(settings) });
      return { revision: project.revision, updatedAt: project.updatedAt, settings };
    });
  }

  #resolve(data, project, task, context, excludeExecutionId = null) {
    const safety = { ...context.safety, api: { ...context.safety?.api } };
    const api = safety.api;
    const included = api.includedExecutionIds ?? [];
    if (!Array.isArray(included) || included.some(value => typeof value !== 'string')) return denial('INVALID_CREDIT_RECONCILIATION');
    let withheld = 0, projectReserved = 0;
    for (const projectId of Object.keys(data.projects)) {
      const candidate = this.#project(data, projectId);
      for (const operation of Object.values(candidate.operations)) {
        if (operation.route !== 'api' || operation.executionId === excludeExecutionId) continue;
        if (active.has(operation.status) && candidate === project) projectReserved += operation.reservedMicros;
        if (operation.organizationId !== api.organizationId) continue;
        if (active.has(operation.status)) withheld += operation.reservedMicros;
        else if (!included.includes(operation.executionId)) withheld += operation.costMicros;
      }
    }
    safety.projectSpentUsd = (project.spentMicros + moneyMicros(context.safety?.projectSpentUsd ?? 0, 'ceil')) / 1_000_000;
    safety.projectReservedUsd = (projectReserved + moneyMicros(context.safety?.projectReservedUsd ?? 0, 'ceil')) / 1_000_000;
    if (typeof api.availableCreditUsd === 'number' && Number.isFinite(api.availableCreditUsd) && api.availableCreditUsd >= 0) api.availableCreditUsd = Math.max(0, moneyMicros(api.availableCreditUsd) - withheld) / 1_000_000;
    if (api.organizationId && data.organizations[api.organizationId]?.hold) api.budgetHold = true;
    const decision = resolveExecution({ settings: project.settings, task, capabilities: context.capabilities, safety, now: context.now });
    if (decision.allowed && decision.route === 'api') {
      const binding = this.#reservationBinding(data.reservationAuthority);
      if (api.reservationAuthorityId !== this.authorityId || (binding !== null && api.ledgerBinding !== binding)) {
        return denial('RESERVATION_AUTHORITY_MISMATCH');
      }
    }
    return decision;
  }

  #prepareAdmission(data, project, task, context, isVoice) {
    let realtimeVoice;
    if (isVoice) {
      const admission = realtimeAdmission(project, task, context);
      if (!admission.allowed) return admission;
      ({context, realtimeVoice} = admission);
    }
    const decision = this.#resolve(data, project, task, context);
    if (!decision.allowed) return {...decision, dispatchable: false};
    const executorId = context.capabilities?.[decision.route]?.executorId;
    if (typeof executorId !== 'string' || !executorId || executorId.length > 200) return denial('EXECUTION_TARGET_UNKNOWN');
    if (decision.route === 'api') { try { id(context.safety.api.organizationId); } catch { return denial('CREDIT_ORGANIZATION_MISMATCH'); } }
    let handover = null;
    const identity = {route: decision.route, model: decision.model, reasoningEffort: decision.reasoningEffort, executorId};
    if (project.lastExecution && digest(project.lastExecution) !== digest(identity)) {
      const checked = verifyHandover(project.checkpoint, context.handoverReadback);
      if (!checked.ok) return denial('HANDOVER_REQUIRED');
      handover = {sourceRoute: project.lastRoute, checkpointVersion: project.checkpoint.version,
        checkedAt: new Date(context.now ?? Date.now()).toISOString()};
    }
    return {allowed: true, decision, identity, handover, realtimeVoice};
  }

  previewRealtime(projectId, task, context) {
    const data = this.#read();
    const project = this.#project(data, projectId, {includeInitial: true});
    if (Object.values(project.operations).some(operation => active.has(operation.status))) return denial('PROJECT_BUSY');
    const result = this.#prepareAdmission(data, project, task, context, true);
    return result.allowed ? {allowed: true, reservedMicros: moneyMicros(result.decision.maxCostUsd, 'ceil')} : result;
  }

  prepareDispatch(request, context) {
    id(request.projectId); id(request.taskId);
    if (!hashPattern.test(request.instructionDigest ?? '')) error('INVALID_INSTRUCTION_DIGEST');
    const {kind, nativeOrigin} = request;
    if (kind !== undefined && (kind !== realtimeKind || nativeOrigin !== undefined)) error('INVALID_EXECUTION_KIND');
    if (nativeOrigin !== undefined && (!validNativeOrigin(nativeOrigin) || request.task?.route !== 'api' ||
        !['consultation', 'design'].includes(request.task.stage))) error('INVALID_NATIVE_ORIGIN');
    const fingerprint = digest({ instructionDigest: request.instructionDigest, task: request.task ?? {}, nativeOrigin,
      ...(kind ? {kind} : {}) });
    return this.#change(data => {
      const project = this.#project(data, request.projectId, {create:true});
      const prior = project.operations[request.taskId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) error('TASK_ID_CONFLICT');
        return { allowed: true, dispatchable: false, replayed: true, operation: prior };
      }
      if (project.revision !== request.expectedRevision) return denial('REVISION_CONFLICT');
      if (Object.values(project.operations).some(operation => active.has(operation.status))) return denial('PROJECT_BUSY');
      if (nativeOrigin && Object.values(project.operations).some(operation => operation.dispatchedAt &&
          operation.nativeOrigin?.operationId === nativeOrigin.operationId && operation.instructionDigest === request.instructionDigest)) {
        return denial('NATIVE_HANDOVER_ALREADY_SENT');
      }
      const admission = this.#prepareAdmission(data, project, request.task ?? {}, context, kind === realtimeKind);
      if (!admission.allowed) return admission;
      const {decision, identity, handover, realtimeVoice} = admission;
      const operation = {
        executionId: randomUUID(), taskId: request.taskId, fingerprint, settingsRevision: project.revision,
        ...identity,
        task: clone(request.task ?? {}), instructionDigest: request.instructionDigest,
        ...(nativeOrigin ? {nativeOrigin: clone(nativeOrigin)} : {}),
        ...(realtimeVoice ? {kind, realtimeVoice} : {}),
        organizationId: decision.route === 'api' ? context.safety.api.organizationId : null,
        reservedMicros: moneyMicros(decision.maxCostUsd, 'ceil'), costMicros: 0,
        status: 'reserved', createdAt: new Date(context.now ?? Date.now()).toISOString(), handover,
      };
      project.operations[request.taskId] = operation;
      return { allowed: true, dispatchable: true, replayed: false, operation };
    });
  }

  markDispatched(projectId, taskId, executionId, context) {
    return this.#change(data => {
      const project = this.#project(data, projectId);
      const operation = project.operations[id(taskId)];
      if (!operation || operation.executionId !== executionId) error('EXECUTION_ID_MISMATCH');
      if (operation.status !== 'reserved') return { ...denial('ALREADY_DISPATCHED'), operation };
      const decision = this.#checkDispatch(data, project, operation, context);
      if (!decision.allowed) return decision;
      operation.status = 'running';
      operation.dispatchedAt = new Date(context.now ?? Date.now()).toISOString();
      return { allowed: true, dispatchable: true, operation };
    });
  }

  recordApiReceipt({projectId, taskId, executionId, round, receipt, accountedMicros}) {
    const value = {id: receipt?.id, inputTokens: receipt?.inputTokens, outputTokens: receipt?.outputTokens,
      accountedMicros, observedAt: new Date().toISOString()};
    if (!validProviderReceipt(value) || !Number.isInteger(round) || round < 0 || round > 1) error('INVALID_API_RECEIPT');
    this.#change(data => {
      const project = this.#project(data, projectId);
      const operation = project.operations[id(taskId)];
      if (!operation || operation.executionId !== executionId || operation.route !== 'api') error('EXECUTION_ID_MISMATCH');
      if (operation.kind === realtimeKind) error('EXECUTION_KIND_MISMATCH');
      if (operation.status !== 'running') error('EXECUTION_HELD');
      operation.providerReceipts ??= [];
      if (operation.providerReceipts.length !== round ||
          (value.id !== null && operation.providerReceipts.some(prior => prior.id === value.id))) error('API_RECEIPT_CONFLICT');
      operation.providerReceipts.push(value);
    });
  }

  #checkDispatch(data, project, operation, context) {
    if (project.revision !== operation.settingsRevision) return denial('REVISION_CONFLICT');
    if (operation.kind === realtimeKind) {
      const admission = realtimeAdmission(project, operation.task, context);
      if (!admission.allowed) return admission;
      if (digest(admission.realtimeVoice) !== digest(operation.realtimeVoice)) return denial('DISPATCH_CONTEXT_CHANGED');
      context = admission.context;
    }
    if (operation.nativeOrigin && digest(context.nativeOrigin ?? null) !== digest(operation.nativeOrigin)) return denial('HANDOVER_REQUIRED');
    if (operation.handover && (operation.handover.checkpointVersion !== project.checkpoint?.version ||
        operation.handover.sourceRoute !== project.lastRoute || !verifyHandover(project.checkpoint, context.handoverReadback).ok)) {
      return denial('HANDOVER_REQUIRED');
    }
    if (operation.route === 'api' && operation.organizationId !== context.safety?.api?.organizationId) return denial('CREDIT_ORGANIZATION_MISMATCH');
    const decision = this.#resolve(data, project, operation.task, context, operation.executionId);
    if (!decision.allowed) return { ...decision, dispatchable: false };
    if (decision.route !== operation.route || decision.model !== operation.model || decision.reasoningEffort !== operation.reasoningEffort ||
        context.capabilities?.[decision.route]?.executorId !== operation.executorId || moneyMicros(decision.maxCostUsd, 'ceil') > operation.reservedMicros) {
      return denial('DISPATCH_CONTEXT_CHANGED');
    }
    return {allowed: true, dispatchable: true};
  }

  recheckDispatched(projectId, taskId, executionId, context) {
    const data = this.#read();
    const project = this.#project(data, projectId);
    const operation = project.operations[id(taskId)];
    if (!operation || operation.executionId !== executionId) error('EXECUTION_ID_MISMATCH');
    if (operation.status !== 'running') return denial('EXECUTION_HELD');
    return this.#checkDispatch(data, project, operation, context);
  }

  cancelReserved(projectId, taskId, executionId, now = Date.now(), reason = 'INTERRUPTED') {
    return this.#change(data => {
      const project = this.#project(data, projectId);
      const operation = project.operations[id(taskId)];
      if (!operation || operation.executionId !== executionId) error('EXECUTION_ID_MISMATCH');
      if (operation.status !== 'reserved') return {cancelled: false, operation};
      operation.status = 'cancelled';
      operation.reason = typeof reason === 'string' && /^[A-Z_]{1,64}$/.test(reason) ? reason : 'API_WORKSPACE_FAILED';
      operation.completedAt = new Date(now).toISOString();
      return {cancelled: true, operation};
    });
  }

  recordOutcome(result) {
    return this.#change(data => {
      const project = this.#project(data, result.projectId);
      const operation = project.operations[id(result.taskId)];
      if (!operation || operation.executionId !== result.executionId) error('EXECUTION_ID_MISMATCH');
      if (operation.kind === realtimeKind) error('EXECUTION_KIND_MISMATCH');
      if (terminals.has(operation.status)) {
        if (result.outcome !== operation.status || (operation.route === 'api' && moneyMicros(result.actualCostUsd, 'ceil') !== operation.costMicros)) error('OUTCOME_CONFLICT');
        return { replayed: true, operation };
      }
      if (!terminals.has(result.outcome)) error('INVALID_OUTCOME');
      if (result.confirmedTerminal !== true || result.effectsReconciled !== true) {
        operation.status = 'uncertain';
        operation.settlementObservedAt ??= new Date().toISOString();
        return { replayed: false, operation };
      }
      if (operation.route === 'api' && (typeof result.actualCostUsd !== 'number' || !Number.isFinite(result.actualCostUsd) || result.actualCostUsd < 0)) {
        operation.status = 'awaiting_settlement';
        operation.settlementObservedAt ??= new Date().toISOString();
        return { replayed: false, operation };
      }
      if (!verifyHandover(result.checkpoint, result.checkpoint).ok || (project.checkpoint && (result.checkpoint.version <= project.checkpoint.version || result.checkpoint.goalId !== project.checkpoint.goalId))) error('INVALID_CHECKPOINT');
      operation.costMicros = operation.route === 'api' ? moneyMicros(result.actualCostUsd, 'ceil') : 0;
      if (operation.costMicros > operation.reservedMicros) data.organizations[operation.organizationId] = { hold: true, reason: 'RESERVATION_EXCEEDED' };
      project.spentMicros += operation.costMicros;
      project.lastRoute = operation.route;
      project.lastExecution = { route: operation.route, model: operation.model, reasoningEffort: operation.reasoningEffort, executorId: operation.executorId };
      project.checkpoint = clone(result.checkpoint);
      operation.status = result.outcome;
      operation.completedAt = new Date().toISOString();
      operation.checkpointVersion = result.checkpoint.version;
      operation.artifactsHash = result.checkpoint.artifactsHash;
      return { replayed: false, operation };
    });
  }

  recordRealtimeOutcome(result) {
    return this.#change(data => {
      const project = this.#project(data, result.projectId);
      const operation = project.operations[id(result.taskId)];
      if (!operation || operation.executionId !== result.executionId) error('EXECUTION_ID_MISMATCH');
      if (operation.kind !== realtimeKind) error('EXECUTION_KIND_MISMATCH');
      const settlement = realtimeSettlement(operation.realtimeVoice.config, result);
      if (operation.voiceSettlement) {
        if (digest(operation.voiceSettlement) !== digest(settlement)) error('OUTCOME_CONFLICT');
        return {replayed: true, operation};
      }
      if (operation.status !== 'running') error('EXECUTION_HELD');
      const {phase, outcome, responseRequested, response, transcription, reason} = settlement;
      const total = (response?.accountedMicros ?? 0) + (transcription?.accountedMicros ?? 0);
      const priceUnknown = (response && response.accountedMicros === null) || (transcription && transcription.accountedMicros === null) ||
        !Number.isSafeInteger(total) || !Number.isSafeInteger(project.spentMicros + total);
      const hold = priceUnknown ? 'REALTIME_TARIFF_UNVERIFIED' : total > operation.reservedMicros ? 'RESERVATION_EXCEEDED' : null;
      if (hold) data.organizations[operation.organizationId] = {hold: true, reason: hold};
      const confirmed = phase === 'not_committed' || (phase === 'terminal' && transcription &&
        (!responseRequested || response) && !priceUnknown);
      operation.voiceSettlement = settlement;
      if (reason) operation.reason = reason;
      if (confirmed) {
        operation.costMicros = total;
        project.spentMicros += total;
        operation.status = outcome;
        operation.completedAt = new Date().toISOString();
      } else {
        operation.status = phase === 'uncertain' ? 'uncertain' : 'awaiting_settlement';
        operation.settlementObservedAt = new Date().toISOString();
      }
      return {replayed: false, operation};
    });
  }
}
