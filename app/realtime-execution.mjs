import {createHash} from 'node:crypto';
import {readBoundApiAuthority, verifiedApiCredit} from './api-authority.mjs';
import {executionHeld} from './execution-access.mjs';
import {readCurrentProject} from './portfolio.mjs';
import {hasPublishedRealtimeCeilings} from './realtime-cost.mjs';
import {realtimeArchiveId, realtimeArchiveReview, realtimeTranscriptDigest, validRealtimeContinuation} from './realtime-history.mjs';
import {openRealtimeVoice, validateRealtimeHistory} from './realtime-voice.mjs';

const kind = 'realtime-voice';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const bytesPerSecond = 48000;
const maxAudioBytes = 60 * bytesPerSecond;
const noReceipts = {responseRequested: false, response: null, transcription: null};
export const realtimeBodyLimit = 4 * Math.ceil(maxAudioBytes / 3) + 512;
const taskId = value => typeof value === 'string' && idPattern.test(value);
const problem = (status, code) => Object.assign(new Error(code), {status, code});
const sha = value => createHash('sha256').update(value).digest('hex');
const safeReason = cause => typeof cause?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(cause.code)
  ? cause.code : 'REALTIME_VOICE_UNAVAILABLE';

function decodeInput(input) {
  const continuation = input?.continuation;
  if (continuation !== undefined && !validRealtimeContinuation(continuation)) throw problem(400, 'REALTIME_VOICE_TASK_INVALID');
  if (!taskId(input?.id) || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      typeof input.pcm !== 'string' || input.pcm.length > 4 * Math.ceil(maxAudioBytes / 3) ||
      Object.keys(input).length !== (continuation === undefined ? 3 : 4)) throw problem(400, 'REALTIME_VOICE_INVALID_AUDIO');
  const audio = Buffer.from(input.pcm, 'base64');
  if (audio.length > maxAudioBytes || audio.length < bytesPerSecond / 10 || audio.length % 2 ||
      audio.toString('base64') !== input.pcm) throw problem(400, 'REALTIME_VOICE_INVALID_AUDIO');
  return audio;
}

const transcriptMessages = result => [{role: 'user', text: result.inputTranscript},
  {role: 'assistant', text: result.outputTranscript}].filter(message => message.text.trim());

export function createRealtimeExecution({directory, store, conversations, withProjectWorkLock, hasNativeWork,
  getKey = () => process.env.OPENAI_API_KEY, readAuthority, connect}) {
  const jobs = new Map();
  let closing = false;

  function verifiedHistory(projectId, reference, scopeDigest, model) {
    const id = typeof reference === 'string' ? reference : reference.id;
    if (!realtimeArchiveId.test(id)) throw problem(400, 'REALTIME_VOICE_TASK_INVALID');
    const archived = conversations.readRealtime(projectId, id);
    if (!archived) throw problem(404, 'REALTIME_VOICE_HISTORY_NOT_FOUND');
    if (typeof reference !== 'string' && reference.review !== archived.review) throw problem(409, 'REALTIME_VOICE_HISTORY_CHANGED');
    const invalid = () => problem(409, 'REALTIME_VOICE_HISTORY_UNVERIFIED');
    const proof = store.getRealtimeArchive(projectId, id);
    if (proof.turns.length !== archived.groups.length || archived.model !== model) throw invalid();
    const byId = new Map(proof.turns.map(turn => [turn.id, turn]));
    const prefix = [];
    let previous;
    for (const group of archived.groups) {
      const turn = byId.get(group.id);
      if (!turn?.transcriptDigest || turn.scopeDigest !== scopeDigest || turn.model !== model || group.messages.length !== 2) throw invalid();
      if (group.messages.some(message => message.createdAt !== (message.role === 'user' ? turn.startedAt : turn.completedAt))) {
        throw invalid();
      }
      if (previous) {
        const expected = realtimeArchiveReview(id, previous.completedAt, prefix);
        if (turn.continuation?.review !== expected || previous.completedAt > turn.startedAt) throw invalid();
      } else if (turn.continuation) throw invalid();
      if (turn.transcriptDigest !== realtimeTranscriptDigest(group.messages)) throw invalid();
      prefix.push(...group.messages);
      previous = turn;
    }
    if (archived.importedAt !== previous?.completedAt) throw invalid();
    const history = validateRealtimeHistory(archived.messages.map(({role, text}) => ({role, text})));
    if (!history) throw problem(409, 'REALTIME_VOICE_HISTORY_LIMIT');
    return {continuation: {id, review: archived.review}, archiveLedgerReview: proof.review,
      contextCount: history.length, history};
  }

  function scope(project, signedIn, reference) {
    if (!signedIn()) throw problem(401, 'REALTIME_VOICE_SIGN_IN_REQUIRED');
    if (process.platform !== 'darwin') throw problem(409, 'API_RUNTIME_UNSUPPORTED');
    const current = readCurrentProject(directory, project.id);
    if (!current || executionHeld(current.state) || closing) throw problem(409, 'EXECUTION_HELD');
    if (hasNativeWork(current)) throw problem(409, 'HANDOVER_REQUIRED');
    const key = getKey();
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(key)) throw problem(409, 'API_AUTHORIZATION_REQUIRED');
    const now = Date.now();
    let authority;
    try { authority = readBoundApiAuthority(directory, store, now, {readAuthority}); }
    catch (cause) { throw problem(409, safeReason(cause)); }
    if (!authority.realtimeVoice?.projects?.includes(project.id)) throw problem(409, 'REALTIME_VOICE_AUTHORITY_REQUIRED');
    const {config} = authority.realtimeVoice;
    if (!hasPublishedRealtimeCeilings(config)) throw problem(409, 'REALTIME_VOICE_TARIFF_UNVERIFIED');
    const task = {route: 'api', stage: 'consultation', model: config.model, reasoningEffort: 'none'};
    const scopeDigest = sha(JSON.stringify([project.id, current.cwd, current.goal, current.handoverRequirements,
      authority.organization, authority.providerProject, authority.ledgerBinding]));
    const archived = reference === undefined ? null : verifiedHistory(project.id, reference, scopeDigest, config.model);
    const context = {now, realtimeVoice: {config, scopeDigest,
      ...(archived ? {continuation: archived.continuation, archiveLedgerReview: archived.archiveLedgerReview} : {})}, capabilities: {api: {available: true,
      executorId: 'owner-mac-realtime-voice', defaultModel: config.model, models: [{id: config.model, reasoningEfforts: ['none']}]}},
    safety: {authorized: true, status: 'ready', allowedRoutes: ['api'], api: verifiedApiCredit(authority)}};
    return {key, authority, config, task, context, archived};
  }

  function view(operation, projectId) {
    if (operation?.kind !== kind) return null;
    const job = jobs.get(operation.executionId);
    const phase = ['reserved', 'running'].includes(operation.status) ?
      (job ? job.stopping ? 'interrupting' : operation.status : 'unconfirmed') :
      ['uncertain', 'awaiting_settlement'].includes(operation.status) ? 'unconfirmed' : operation.status;
    const billing = operation.voiceSettlement;
    let conversationId = null;
    if (operation.status === 'completed') {
      const archive = operation.realtimeVoice.continuation?.id ?? `realtime/${operation.executionId}`;
      try {
        const group = conversations.readRealtime(projectId, archive)?.groups.find(group => group.id === operation.executionId);
        if (group && (!billing?.transcriptDigest || billing.transcriptDigest === realtimeTranscriptDigest(group.messages))) conversationId = archive;
      } catch { /* The usage receipt remains usable when the transcript store is unavailable. */ }
    }
    return {id: operation.taskId, route: 'api', model: operation.model, phase, startedAt: operation.dispatchedAt ?? null,
      updatedAt: operation.completedAt ?? operation.settlementObservedAt ?? operation.createdAt,
      reason: operation.reason ?? (phase === 'unconfirmed' ? 'REALTIME_VOICE_SETTLEMENT_UNKNOWN' : null),
      accountedMicros: operation.completedAt ? operation.costMicros : null,
      response: billing?.response ?? null, transcription: billing?.transcription ?? null, conversationId,
      continuationAvailable: Boolean(conversationId && billing?.transcriptDigest)};
  }

  async function run(project, job, operation, initial, audio, signedIn, emit) {
    const identifiers = {projectId: project.id, taskId: operation.taskId, executionId: operation.executionId};
    const signal = job.controller.signal;
    let marked = false;
    let inputAdmitted = false;
    let timer;
    let result;
    let outcome;
    let confirmedTranscript = false;
    function fresh() {
      const current = scope(project, signedIn, initial.archived?.continuation);
      if (current.key !== initial.key) throw problem(409, 'DISPATCH_CONTEXT_CHANGED');
      return current.context;
    }
    function check() {
      if (job.stopping || signal.aborted) return false;
      try {
        const decision = store.recheckDispatched(project.id, operation.taskId, operation.executionId, fresh());
        if (!decision.allowed) throw problem(409, decision.code);
        return true;
      } catch (cause) {
        job.reason = safeReason(cause);
        return false;
      }
    }
    job.stop = (heardMs = 0) => {
      if (job.stopping) return;
      if (job.voice && inputAdmitted && !job.voice.interrupt(heardMs) && (!heardMs || !job.voice.interrupt(0))) return;
      job.stopping = true;
      if (!inputAdmitted) job.controller.abort();
    };
    try {
      signal.throwIfAborted();
      const dispatch = store.markDispatched(project.id, operation.taskId, operation.executionId, fresh());
      if (!dispatch.allowed) throw problem(409, dispatch.code);
      marked = true;
      const {organization, providerProject} = initial.authority;
      const {model, voice, transcriptionModel, maxOutputTokens, maxInputSeconds} = initial.config;
      job.voice = await openRealtimeVoice({key: initial.key, organization, project: providerProject, model, voice,
        transcriptionModel, maxOutputTokens, maxInputSeconds, signal, connect, history: initial.archived?.history,
        authorize(stage) {
          if (!check()) return false;
          if (stage === 'input') inputAdmitted = true;
          return true;
        }});
      timer = setInterval(() => { if (!check()) job.stop(); }, 1000);
      timer.unref();
      result = await job.voice.turn(audio, {
        onAudio(bytes) {
          if (!job.stopping && signedIn()) emit({type: 'audio', pcm: bytes.toString('base64')});
        },
        onTranscript(text) {
          if (!job.stopping && signedIn()) emit({type: 'transcript', text});
        },
      });
      const messages = transcriptMessages(result);
      const completed = result.status === 'completed' && !result.interrupted && !job.stopping;
      confirmedTranscript = completed && result.outputTranscriptConfirmed === true && messages.length === 2;
      outcome = {phase: 'terminal', outcome: result.interrupted || job.stopping || result.status === 'cancelled'
        ? 'interrupted' : completed ? 'completed' : 'failed',
      ...(confirmedTranscript ? {transcriptDigest: realtimeTranscriptDigest(messages)} : {}),
      reason: job.reason ?? (completed && !confirmedTranscript ? 'REALTIME_VOICE_TRANSCRIPT_UNAVAILABLE' : undefined), receipts: {
        responseRequested: result.responseRequested,
        response: result.responseRequested ? {id: result.responseId, status: result.status, usage: result.usage} : null,
        transcription: {itemId: result.inputItemId, usage: result.transcriptionUsage},
      }};
    } catch (cause) {
      const atRisk = inputAdmitted && cause?.inputCommitted !== false;
      outcome = {phase: atRisk ? 'uncertain' : 'not_committed', outcome: job.stopping || signal.aborted ? 'interrupted' : 'failed',
        receipts: cause?.receipts ?? noReceipts, reason: job.reason ?? safeReason(cause)};
    } finally {
      clearInterval(timer);
      job.voice?.close();
    }
    if (!marked) {
      const {operation: cancelled} = store.cancelReserved(project.id, operation.taskId, operation.executionId,
        Date.now(), outcome.reason);
      return {turn: view(cancelled, project.id)};
    }
    const settled = store.recordRealtimeOutcome({...identifiers, ...outcome}).operation;
    const completed = confirmedTranscript && settled.status === 'completed';
    if (completed) {
      try {
        conversations.saveRealtime(project.id, {id: settled.executionId, model: settled.model, inputTranscript: result.inputTranscript,
          outputTranscript: result.outputTranscript, startedAt: settled.dispatchedAt, completedAt: settled.completedAt,
          continuation: settled.realtimeVoice.continuation});
      } catch { /* A transcript failure does not settle or dispatch the usage a second time. */ }
    }
    return {turn: view(settled, project.id), ...(completed ?
      {inputTranscript: result.inputTranscript, outputTranscript: result.outputTranscript} : {})};
  }

  function read(project, id) {
    if (!taskId(id)) throw problem(400, 'REALTIME_VOICE_TASK_INVALID');
    const operation = store.getWork(project.id, id).operation;
    if (operation?.kind !== kind) throw problem(404, 'REALTIME_VOICE_TASK_NOT_FOUND');
    return operation;
  }

  return {
    available(project, signedIn, continuationId) {
      try {
        const {config, task, context, archived} = scope(project, signedIn, continuationId);
        const result = store.previewRealtime(project.id, task, context);
        if (!result.allowed) throw problem(409, result.code);
        return {available: true, route: 'api', model: config.model, maxInputSeconds: config.maxInputSeconds,
          reservedMicros: result.reservedMicros,
          revision: store.getSettings(project.id).revision,
          ...(archived ? {continuation: archived.continuation, contextCount: archived.contextCount} : {})};
      } catch (cause) { return {available: false, reason: safeReason(cause)}; }
    },
    read(project, id) { return {turn: view(read(project, id), project.id)}; },
    start(project, input, {signedIn, emit}) {
      if (!signedIn()) throw problem(401, 'REALTIME_VOICE_SIGN_IN_REQUIRED');
      const audio = decodeInput(input);
      const instructionDigest = sha(audio);
      const admission = withProjectWorkLock(project, () => {
        const previous = store.getWork(project.id, input.id).operation;
        if (previous) {
          if (previous.kind !== kind || previous.instructionDigest !== instructionDigest || previous.settingsRevision !== input.revision ||
              previous.realtimeVoice.continuation?.id !== input.continuation?.id ||
              previous.realtimeVoice.continuation?.review !== input.continuation?.review) {
            throw problem(409, 'TASK_ID_CONFLICT');
          }
          return {replayed: true, turn: view(previous, project.id)};
        }
        const current = scope(project, signedIn, input.continuation);
        if (audio.length > current.config.maxInputSeconds * bytesPerSecond) throw problem(400, 'REALTIME_VOICE_INVALID_AUDIO');
        const {task, context} = current;
        const prepared = store.prepareDispatch({projectId: project.id, taskId: input.id, expectedRevision: input.revision,
          instructionDigest, kind, task}, context);
        if (!prepared.dispatchable) throw problem(409, prepared.code);
        return {operation: prepared.operation, current};
      });
      if (admission.replayed) return admission;
      const {operation, current} = admission;
      const controller = new AbortController();
      const job = {controller, stopping: false, stop() { job.stopping = true; controller.abort(); }};
      jobs.set(operation.executionId, job);
      job.done = Promise.resolve().then(() => run(project, job, operation, current, audio, signedIn, emit))
        .finally(() => jobs.delete(operation.executionId));
      return {replayed: false, turn: view(operation, project.id), done: job.done, disconnect: () => job.stop()};
    },
    interrupt(project, input) {
      if (!Number.isSafeInteger(input?.heardMs) || input.heardMs < 0 || input.heardMs > 120000 ||
          Object.keys(input).length !== 2) throw problem(400, 'REALTIME_VOICE_TASK_INVALID');
      const operation = read(project, input.id);
      jobs.get(operation.executionId)?.stop(input.heardMs);
      return {turn: view(operation, project.id)};
    },
    async close() {
      closing = true;
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map(job => job.done));
    },
  };
}
