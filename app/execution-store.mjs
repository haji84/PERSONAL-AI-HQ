import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { moneyMicros, normalizeSettings, resolveExecution, verifyHandover } from './execution-policy.mjs';

const active = new Set(['reserved', 'running', 'uncertain', 'awaiting_settlement']);
const terminals = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const hashPattern = /^[a-f0-9]{64}$/;
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
const settingFields = Object.keys(normalizeSettings());
const emptyProject = () => ({ revision: 0, settings: normalizeSettings(), history: [], operations: {}, spentMicros: 0, lastRoute: null, lastExecution: null, checkpoint: null });

// One owner-controlled server is the writer for this store. Do not replicate the
// file to create another budget authority on a second device.
export class ExecutionStore {
  constructor(file, { authorityId } = {}) {
    this.file = path.resolve(file);
    this.authorityId = id(authorityId);
  }

  #read() {
    let text;
    try {
      const info = fs.lstatSync(this.file);
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

  #project(data, projectId, create = false) {
    id(projectId);
    if (!Object.hasOwn(data.projects, projectId)) {
      if (!create) return emptyProject();
      data.projects[projectId] = emptyProject();
    }
    const project = data.projects[projectId];
    if (!Number.isSafeInteger(project.revision) || project.revision < 0 || !Array.isArray(project.history) || !project.operations || typeof project.operations !== 'object' || Array.isArray(project.operations) || !Number.isSafeInteger(project.spentMicros) || project.spentMicros < 0) error('STATE_INVALID');
    if (!project.settings || typeof project.settings !== 'object' || Array.isArray(project.settings) || settingFields.some(key => !Object.hasOwn(project.settings, key))) error('STATE_INVALID');
    try { project.settings = normalizeSettings(project.settings); } catch { error('STATE_INVALID'); }
    if (project.lastRoute && (!project.lastExecution || project.lastExecution.route !== project.lastRoute || !project.lastExecution.model || !project.lastExecution.executorId || !verifyHandover(project.checkpoint, project.checkpoint).ok)) error('STATE_INVALID');
    for (const operation of Object.values(project.operations)) {
      if (!operation || !['api', 'subscription'].includes(operation.route) || (!active.has(operation.status) && !terminals.has(operation.status)) || !Number.isSafeInteger(operation.reservedMicros) || operation.reservedMicros < 0 || !Number.isSafeInteger(operation.costMicros) || operation.costMicros < 0) error('STATE_INVALID');
      if (typeof operation.model !== 'string' || !operation.model || typeof operation.executorId !== 'string' || !operation.executorId || typeof operation.executionId !== 'string' || !hashPattern.test(operation.fingerprint ?? '') || !hashPattern.test(operation.instructionDigest ?? '') || !Number.isSafeInteger(operation.settingsRevision) || operation.settingsRevision < 0) error('STATE_INVALID');
      if (operation.route === 'api') { try { id(operation.organizationId); } catch { error('STATE_INVALID'); } }
    }
    return project;
  }

  getSettings(projectId) {
    const project = this.#project(this.#read(), projectId);
    return clone({ revision: project.revision, settings: project.settings, updatedAt: project.updatedAt ?? null, history: project.history });
  }

  updateSettings(projectId, expectedRevision, input) {
    return this.#change(data => {
      const project = this.#project(data, projectId, true);
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
    if (decision.allowed && decision.route === 'api' && api.reservationAuthorityId !== this.authorityId) return denial('RESERVATION_AUTHORITY_MISMATCH');
    return decision;
  }

  prepareDispatch(request, context) {
    id(request.projectId); id(request.taskId);
    if (!hashPattern.test(request.instructionDigest ?? '')) error('INVALID_INSTRUCTION_DIGEST');
    const fingerprint = digest({ instructionDigest: request.instructionDigest, task: request.task ?? {} });
    return this.#change(data => {
      const project = this.#project(data, request.projectId, true);
      const prior = project.operations[request.taskId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) error('TASK_ID_CONFLICT');
        return { allowed: true, dispatchable: false, replayed: true, operation: prior };
      }
      if (project.revision !== request.expectedRevision) return denial('REVISION_CONFLICT');
      if (Object.values(project.operations).some(operation => active.has(operation.status))) return denial('PROJECT_BUSY');
      const decision = this.#resolve(data, project, request.task ?? {}, context);
      if (!decision.allowed) return { ...decision, dispatchable: false };
      const executorId = context.capabilities?.[decision.route]?.executorId;
      if (typeof executorId !== 'string' || !executorId || executorId.length > 200) return denial('EXECUTION_TARGET_UNKNOWN');
      if (decision.route === 'api') { try { id(context.safety.api.organizationId); } catch { return denial('CREDIT_ORGANIZATION_MISMATCH'); } }
      let handover = null;
      const identity = { route: decision.route, model: decision.model, reasoningEffort: decision.reasoningEffort, executorId };
      if (project.lastExecution && digest(project.lastExecution) !== digest(identity)) {
        const checked = verifyHandover(project.checkpoint, context.handoverReadback);
        if (!checked.ok) return denial('HANDOVER_REQUIRED');
        handover = { sourceRoute: project.lastRoute, checkpointVersion: project.checkpoint.version, checkedAt: new Date(context.now ?? Date.now()).toISOString() };
      }
      const operation = {
        executionId: randomUUID(), taskId: request.taskId, fingerprint, settingsRevision: project.revision,
        ...identity,
        task: clone(request.task ?? {}), instructionDigest: request.instructionDigest,
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
      if (project.revision !== operation.settingsRevision) return denial('REVISION_CONFLICT');
      if (operation.route === 'api' && operation.organizationId !== context.safety?.api?.organizationId) return denial('CREDIT_ORGANIZATION_MISMATCH');
      const decision = this.#resolve(data, project, operation.task, context, executionId);
      if (!decision.allowed) return { ...decision, dispatchable: false };
      if (decision.route !== operation.route || decision.model !== operation.model || decision.reasoningEffort !== operation.reasoningEffort || context.capabilities?.[decision.route]?.executorId !== operation.executorId || moneyMicros(decision.maxCostUsd, 'ceil') > operation.reservedMicros) return denial('DISPATCH_CONTEXT_CHANGED');
      operation.status = 'running';
      operation.dispatchedAt = new Date(context.now ?? Date.now()).toISOString();
      return { allowed: true, dispatchable: true, operation };
    });
  }

  recordOutcome(result) {
    return this.#change(data => {
      const project = this.#project(data, result.projectId);
      const operation = project.operations[id(result.taskId)];
      if (!operation || operation.executionId !== result.executionId) error('EXECUTION_ID_MISMATCH');
      if (terminals.has(operation.status)) {
        if (result.outcome !== operation.status || (operation.route === 'api' && moneyMicros(result.actualCostUsd, 'ceil') !== operation.costMicros)) error('OUTCOME_CONFLICT');
        return { replayed: true, operation };
      }
      if (!terminals.has(result.outcome)) error('INVALID_OUTCOME');
      if (result.confirmedTerminal !== true || result.effectsReconciled !== true) {
        operation.status = 'uncertain';
        return { replayed: false, operation };
      }
      if (operation.route === 'api' && (typeof result.actualCostUsd !== 'number' || !Number.isFinite(result.actualCostUsd) || result.actualCostUsd < 0)) {
        operation.status = 'awaiting_settlement';
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
      return { replayed: false, operation };
    });
  }
}
