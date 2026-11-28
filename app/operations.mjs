import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ROUTES, STAGES} from './execution-policy.mjs';
import {validatedDocument} from './text-attachment.mjs';
import {validatedImage} from './image-attachment.mjs';
import {readCurrentProject} from './portfolio.mjs';
import {observedWorkTime, workOutcomeLimit} from './work-outcomes.mjs';

const active = new Set(['reserved', 'sending', 'running', 'interrupting', 'unconfirmed']);
const nativeTerminal = new Set(['completed', 'interrupted', 'failed']);
const terminal = new Set([...nativeTerminal, 'cancelled']);
const observationWindowMs = 15000;
const subscriptionUsageMessages = {
  CODEX_SUBSCRIPTION_LIMIT_REACHED: 'Codexの契約内利用が許可されていないため、指示を送信しませんでした。',
  CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED: 'Codexの契約内利用枠を確認できず、指示を送信しませんでした。',
};
const allowedId = /^[a-z0-9_-]{8,80}$/i;
const nativeThreadId = /^[a-z0-9_-]{1,160}$/i;
const receiptId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const reviewHash = /^[a-f0-9]{64}$/;
const steerClientId = id => `hq:steer:${id}`;
const timestamp = () => new Date().toISOString();
const problem = (status, message, code) => Object.assign(new Error(message), {status, code});
const usageProblem = code => problem(409, subscriptionUsageMessages[code], code);
const freshUsage = observedAt => {
  const age = Date.now() - observedAt;
  return age >= 0 && age <= observationWindowMs;
};
const resumeUnavailable = () => problem(409, 'このスレッドの最新の作業を照合できません。', 'CODEX_RESUME_TARGET_UNAVAILABLE');
const phase = value => nativeTerminal.has(value) ? value : value === 'inProgress' ? 'running' : null;
const visiblePhase = row => row.cancellationRequestedAt && active.has(row.phase) ? 'cancelling' : row.phase;

export function createOperations(directory, native, execution, {prepareHandover, chatConversationForHandoff} = {}) {
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  db.exec(`PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS codex_operations (
      id TEXT NOT NULL, project TEXT NOT NULL, workspace TEXT NOT NULL, fingerprint TEXT NOT NULL,
      phase TEXT NOT NULL, threadId TEXT, turnId TEXT, createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL, startedAt TEXT, output TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT 'implementation', explicitRoute TEXT,
      PRIMARY KEY(project,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON codex_operations(project)
    WHERE phase IN ('reserved','sending','running','interrupting','unconfirmed');
    CREATE TABLE IF NOT EXISTS codex_steering (
      project TEXT NOT NULL, id TEXT NOT NULL, operationId TEXT NOT NULL, turnId TEXT NOT NULL,
      fingerprint TEXT NOT NULL, phase TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY(project,id)
    );`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(codex_operations)').all().map(column => column.name);
    if (!columns.includes('stage')) db.exec("ALTER TABLE codex_operations ADD COLUMN stage TEXT NOT NULL DEFAULT 'implementation'");
    if (!columns.includes('explicitRoute')) db.exec('ALTER TABLE codex_operations ADD COLUMN explicitRoute TEXT');
    if (!columns.includes('handoverReceipt')) db.exec('ALTER TABLE codex_operations ADD COLUMN handoverReceipt TEXT');
    if (!columns.includes('handoverReview')) db.exec('ALTER TABLE codex_operations ADD COLUMN handoverReview TEXT');
    if (!columns.includes('chatConversationId')) db.exec('ALTER TABLE codex_operations ADD COLUMN chatConversationId TEXT');
    if (!columns.includes('cancellationRequestedAt')) db.exec('ALTER TABLE codex_operations ADD COLUMN cancellationRequestedAt TEXT');
    if (!columns.includes('cancellationDispatchedAt')) db.exec('ALTER TABLE codex_operations ADD COLUMN cancellationDispatchedAt TEXT');
    if (!columns.includes('expectedThreadId')) db.exec('ALTER TABLE codex_operations ADD COLUMN expectedThreadId TEXT');
    if (!columns.includes('interruptionDispatchedAt')) {
      db.exec('ALTER TABLE codex_operations ADD COLUMN interruptionDispatchedAt TEXT');
      // Old active pauses did not distinguish preflight from a possibly sent interrupt.
      db.exec(`UPDATE codex_operations SET interruptionDispatchedAt=updatedAt
        WHERE phase IN ('interrupting','unconfirmed') AND turnId IS NOT NULL AND cancellationRequestedAt IS NULL`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_launched_handover ON codex_operations(project,handoverReceipt)
      WHERE handoverReview IS NOT NULL AND threadId IS NOT NULL`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const projectHistory = db.prepare(
    'SELECT 1 FROM codex_operations WHERE project=?1 COLLATE NOCASE UNION ALL ' +
    'SELECT 1 FROM codex_steering WHERE project=?1 COLLATE NOCASE LIMIT 1');
  const byId = db.prepare('SELECT * FROM codex_operations WHERE project=? AND id=?');
  const targetsThread = param => `(threadId=${param} OR (threadId IS NULL AND expectedThreadId=${param}
    AND phase IN ('reserved','sending','running','interrupting','unconfirmed','cancelled')))`;
  const latestRowId = (project, filter = '') => `SELECT rowid FROM codex_operations WHERE project=${project}
    ${filter} ORDER BY createdAt DESC, rowid DESC LIMIT 1`;
  const latest = db.prepare(`SELECT * FROM codex_operations WHERE rowid=(${latestRowId('?')})`);
  const latestThread = db.prepare(`SELECT * FROM codex_operations WHERE project=? AND threadId=?
    ORDER BY createdAt DESC, rowid DESC LIMIT 1`);
  const managedActivityThread = db.prepare(`SELECT 1 FROM codex_operations WHERE threadId=?
    AND workspace IN (SELECT value FROM json_each(?)) LIMIT 1`);
  const latestTarget = db.prepare(`SELECT * FROM codex_operations WHERE rowid=(
    ${latestRowId('?1', `AND ${targetsThread('?2')} AND (?3 IS NULL OR id<>?3)`)})`);
  const latestHandover = db.prepare(`SELECT * FROM codex_operations WHERE project=? AND handoverReceipt=?
    ORDER BY threadId IS NOT NULL DESC, createdAt DESC, rowid DESC LIMIT 1`);
  const latestScoped = db.prepare(`SELECT id, project, workspace, phase, threadId, turnId, createdAt, updatedAt, startedAt,
      cancellationRequestedAt,cancellationDispatchedAt
    FROM codex_operations WHERE project=?
    AND workspace IN (SELECT value FROM json_each(?)) ORDER BY createdAt DESC, rowid DESC LIMIT 1`);
  const savedOutcomes = db.prepare(`SELECT id,phase,threadId,turnId,createdAt,updatedAt,startedAt,fingerprint
    FROM codex_operations WHERE project=? AND workspace IN (SELECT value FROM json_each(?))
      AND phase IN ('completed','failed') ORDER BY updatedAt DESC, id`);
  const activeRun = db.prepare(`SELECT 1 FROM codex_operations WHERE project=? AND id IS NOT ?
    AND phase IN ('reserved','sending','running','interrupting','unconfirmed') LIMIT 1`);
  const knownNativeWork = db.prepare(`SELECT 1 FROM codex_operations WHERE project=? AND threadId IS NOT NULL AND turnId IS NOT NULL
    AND workspace IN (SELECT value FROM json_each(?)) LIMIT 1`);
  const latestAccepted = db.prepare(`SELECT id, workspace, threadId, turnId, updatedAt, phase, handoverReceipt FROM codex_operations
    WHERE project=? AND workspace=? AND threadId IS NOT NULL AND turnId IS NOT NULL
    ORDER BY createdAt DESC, rowid DESC LIMIT 1`);
  const launchedHandover = db.prepare(`SELECT 1 FROM codex_operations WHERE project=? AND handoverReceipt=?
    AND handoverReview IS NOT NULL AND threadId IS NOT NULL LIMIT 1`);
  // A user item on an existing thread could have been added to another client's active turn.
  const byClientId = db.prepare(`SELECT * FROM codex_operations WHERE threadId=? AND id=? AND turnId IS NULL AND expectedThreadId IS NULL
    AND phase IN ('sending','unconfirmed') LIMIT 1`);
  const byTurn = db.prepare('SELECT * FROM codex_operations WHERE threadId=? AND turnId=? LIMIT 1');
  const chatForTurn = db.prepare(`SELECT phase, chatConversationId FROM codex_operations
    WHERE project=? AND threadId=? AND turnId=? AND chatConversationId IS NOT NULL
    AND workspace IN (SELECT value FROM json_each(?)) LIMIT 2`);
  const linkedChatScope = `saved.project=?1 AND saved.chatConversationId=?2 AND saved.workspace IN (SELECT value FROM json_each(?3))
      AND NOT EXISTS (SELECT 1 FROM codex_operations AS conflict
        WHERE conflict.project=saved.project AND conflict.rowid<>saved.rowid
          AND conflict.threadId=saved.threadId AND conflict.turnId=saved.turnId
          AND conflict.workspace IN (SELECT value FROM json_each(?3)))`;
  const linkedChatRows = db.prepare(`SELECT saved.id,saved.phase,saved.threadId,saved.turnId,saved.createdAt,saved.updatedAt,
      saved.cancellationRequestedAt,saved.fingerprint FROM codex_operations AS saved WHERE ${linkedChatScope}
    ORDER BY saved.createdAt DESC, saved.rowid DESC LIMIT ?4`);
  const linkedChatReceipt = db.prepare(`SELECT saved.workspace,saved.fingerprint,saved.phase,saved.threadId,saved.turnId,
      saved.createdAt,saved.updatedAt,saved.startedAt,saved.cancellationRequestedAt
    FROM codex_operations AS saved WHERE ${linkedChatScope} AND saved.id=?4`);
  const insert = db.prepare(`INSERT INTO codex_operations(project,id,workspace,fingerprint,phase,createdAt,updatedAt,stage,explicitRoute,handoverReceipt,handoverReview,expectedThreadId,chatConversationId)
    SELECT ?1,?2,?3,?4,'reserved',?5,?6,?7,?8,?9,?10,?12,?13 WHERE ?11 IS NULL OR EXISTS (
      SELECT 1 FROM codex_operations WHERE project=?1 AND id=?11 AND workspace=?3 AND threadId IS NOT NULL AND turnId IS NOT NULL
        AND phase IN ('completed','interrupted','failed'))`);
  const setThread = db.prepare(`UPDATE codex_operations SET threadId=?,phase='sending',updatedAt=? WHERE project=? AND id=? AND phase='reserved'`);
  const expireReservation = db.prepare(`UPDATE codex_operations SET phase='failed',updatedAt=?
    WHERE project=? AND id=? AND phase='reserved' AND threadId IS NULL AND updatedAt<=?`);
  const markUnconfirmed = db.prepare(`UPDATE codex_operations SET phase='unconfirmed',updatedAt=?
    WHERE project=? AND id=? AND phase='sending' AND turnId IS NULL`);
  const change = db.prepare(`UPDATE codex_operations SET phase=CASE
      WHEN ?1='interrupted' AND cancellationRequestedAt IS NOT NULL THEN 'cancelled'
      WHEN ?1='running' AND phase='interrupting' THEN 'interrupting' ELSE ?1 END,
    turnId=coalesce(turnId,?2), updatedAt=?3, startedAt=coalesce(startedAt,?4)
    WHERE project=?5 AND id=?6 AND phase NOT IN ('completed','interrupted','failed','cancelled')
    AND (turnId IS NULL OR ?2 IS NULL OR turnId=?2)`);
  const append = db.prepare(`UPDATE codex_operations SET output=substr(output||?,1,48000), updatedAt=?
    WHERE project=? AND id=? AND phase NOT IN ('completed','interrupted','failed','cancelled')`);
  const beginInterrupt = db.prepare(`UPDATE codex_operations SET phase='interrupting',updatedAt=?
    WHERE project=? AND id=? AND threadId=? AND turnId=? AND cancellationRequestedAt IS NULL
      AND phase IN ('running','interrupting','unconfirmed')`);
  const claimInterrupt = db.prepare(`UPDATE codex_operations SET interruptionDispatchedAt=coalesce(interruptionDispatchedAt,?1),updatedAt=?1
    WHERE project=?2 AND id=?3 AND threadId=?4 AND turnId=?5 AND cancellationRequestedAt IS NULL
      AND phase IN ('interrupting','unconfirmed')`);
  const loseInterrupt = db.prepare(`UPDATE codex_operations SET phase='unconfirmed',updatedAt=?
    WHERE project=? AND id=? AND threadId=? AND turnId=? AND cancellationRequestedAt IS NULL AND phase='interrupting'`);
  const requestCancellation = db.prepare(`UPDATE codex_operations SET phase=CASE
      WHEN (phase='reserved' AND threadId IS NULL) OR phase='interrupted' THEN 'cancelled' ELSE phase END,
    cancellationDispatchedAt=coalesce(cancellationDispatchedAt,interruptionDispatchedAt),
    cancellationRequestedAt=?1, updatedAt=?1
    WHERE id=?2 AND workspace=?3 AND rowid=(${latestRowId('?4', `AND (?5 IS NULL OR ${targetsThread('?5')})`)})
      AND cancellationRequestedAt IS NULL AND phase NOT IN ('completed','failed','cancelled')`);
  const claimCancellation = db.prepare(`UPDATE codex_operations SET phase='interrupting',cancellationDispatchedAt=?1,updatedAt=?1
    WHERE id=?2 AND workspace=?3 AND rowid=(${latestRowId('?4', `AND ${targetsThread('?5')}`)}) AND threadId=?5 AND turnId=?6
      AND cancellationRequestedAt IS NOT NULL AND cancellationDispatchedAt IS NULL
      AND phase IN ('sending','running','interrupting','unconfirmed')`);
  const steeringById = db.prepare('SELECT * FROM codex_steering WHERE project=? AND id=?');
  const reserveSteering = db.prepare(`INSERT INTO codex_steering(project,id,operationId,turnId,fingerprint,phase,updatedAt)
    VALUES (?,?,?,?,?,'sending',?) ON CONFLICT(project,id) DO NOTHING`);
  const resolveSteering = db.prepare(`UPDATE codex_steering SET phase=?,updatedAt=? WHERE project=? AND id=? AND phase<>'accepted'`);
  const reconciled = new Map();
  const verifiedRunning = new Map();
  const interruptRequests = new Set();
  const cancellationChecks = new Set();
  let closed = false;

  function advance(row, state, turnId, startedAt = null, observedRunning = true) {
    if (closed || !row) return;
    const observedAt = timestamp();
    const changed = change.run(state, turnId ?? null, observedAt, startedAt, row.project, row.id).changes;
    if (state === 'running') {
      const current = byId.get(row.project, row.id);
      if (observedRunning && changed && current?.phase === 'running' && current.turnId && !current.cancellationRequestedAt) {
        verifiedRunning.set(row.project, {operationId:row.id, turnId:current.turnId, observedAt});
      }
      void dispatchCancellation(current);
    } else if (changed && verifiedRunning.get(row.project)?.operationId === row.id) {
      verifiedRunning.delete(row.project);
    }
  }
  function response(row) {
    if (!row) return null;
    const {fingerprint, workspace, handoverReview, handoverReceipt, interruptionDispatchedAt, cancellationDispatchedAt,
      cancellationRequestedAt, expectedThreadId, chatConversationId, ...view} = row;
    return {...view, phase: visiblePhase(row), ...(handoverReceipt ? {handoverReceipt} : {}),
      ...(cancellationRequestedAt ? {cancellationRequestedAt} : {}), ...(expectedThreadId ? {expectedThreadId} : {})};
  }

  function steeringResponse(row) {
    if (!row) return {steering: null};
    const {fingerprint, ...steering} = row;
    return {steering};
  }

  const unsubscribe = native.onEvent?.((method, value) => {
    if (closed || !value || typeof value.threadId !== 'string') return;
    if ((method === 'item/started' || method === 'item/completed') && value.item?.type === 'userMessage' &&
        typeof value.item.clientId === 'string' && typeof value.turnId === 'string') {
      advance(byClientId.get(value.threadId, value.item.clientId), 'running', value.turnId, timestamp());
      return;
    }
    if (method === 'item/agentMessage/delta' && typeof value.delta === 'string') {
      const row = byTurn.get(value.threadId, value.turnId);
      if (row && active.has(row.phase)) {
        const observedAt = timestamp();
        append.run(value.delta.slice(0, 4000), observedAt, row.project, row.id);
        if (row.phase === 'running' && !row.cancellationRequestedAt) {
          verifiedRunning.set(row.project, {operationId:row.id, turnId:row.turnId, observedAt});
        }
      }
      return;
    }
    if (method !== 'turn/started' && method !== 'turn/completed') return;
    const incoming = value.turn;
    if (typeof incoming?.id !== 'string') return;
    const row = byTurn.get(value.threadId, incoming.id);
    if (!row || terminal.has(row.phase)) return;
    const next = phase(incoming.status);
    if (next) advance(row, next, incoming.id, timestamp());
  });

  async function confirmedWorkspace(project) {
    if (!project.codexWrite) throw problem(403, 'この案件は履歴の参照のみです。');
    if (native.canWrite !== true) throw problem(503, '独立して稼働するCodex接続が必要です。');
    const expected = join(directory, 'workspaces', project.id);
    const marker = join(expected, '.hq-owned-workspace');
    try {
      const [actual, folder, proof] = await Promise.all([realpath(expected), lstat(expected), lstat(marker)]);
      if (actual === expected && project.cwd.includes(expected) && folder.isDirectory() && proof.isFile() && proof.size <= 100 &&
          (await readFile(marker, 'utf8')).trim() === project.id) return actual;
    } catch {}
    throw problem(409, 'この案件の分離作業先を確認できません。');
  }

  async function dispatchCancellation(row) {
    if (closed || !row?.cancellationRequestedAt || row.cancellationDispatchedAt || !active.has(row.phase) ||
        !row.threadId || !row.turnId || typeof native.interrupt !== 'function') return;
    const key = row.project + '/' + row.id;
    if (cancellationChecks.has(key)) return;
    cancellationChecks.add(key);
    try {
      const project = readCurrentProject(directory, row.project);
      if (!project || await confirmedWorkspace(project) !== row.workspace || closed) return;
      await native.interrupt(row.workspace, row.threadId, row.turnId, () => {
        const current = !closed && readCurrentProject(directory, row.project);
        if (!current?.codexWrite || !current.cwd.includes(row.workspace) ||
            !claimCancellation.run(timestamp(), row.id, row.workspace, row.project, row.threadId, row.turnId).changes) {
          throw problem(409, '中止の送信権限または対象のターンを確認できません。');
        }
      });
    } catch {
      // Only failures before the wire gate leave the dispatch unclaimed.
    } finally { cancellationChecks.delete(key); }
  }

  async function configureModel(model, effort, requireModel) {
    if (model === undefined && effort === undefined && !requireModel) return;
    const {data} = await native.models();
    const selected = model === undefined ? data.find(row => row.isDefault) : data.find(row => row.id === model);
    if (!selected || (effort !== undefined && !selected.reasoningEfforts.some(row => row.reasoningEffort === effort))) {
      throw problem(400, 'このCodex接続で利用できるモデルまたは推論レベルを選択してください。');
    }
    return selected;
  }

  async function checkSubscriptionUsage() {
    let usage;
    try { usage = await native.usage?.(); } catch {}
    const observedAt = Date.parse(usage?.observedAt);
    if (!freshUsage(observedAt)) throw usageProblem('CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED');
    const windows = usage.windows;
    if (usage.ordinaryUsageAllowed === false || (Array.isArray(windows) && windows.some(window => window?.usedPercent === 100))) {
      throw usageProblem('CODEX_SUBSCRIPTION_LIMIT_REACHED');
    }
    if (usage.ordinaryUsageAllowed !== true || !Array.isArray(windows) || !windows.length ||
        windows.some(window => !Number.isInteger(window?.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100)) {
      throw usageProblem('CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED');
    }
    return observedAt;
  }

  async function runtimeResult(row) {
    if (!row || !active.has(row.phase)) return row;
    const age = Date.now() - Date.parse(row.updatedAt);
    if (row.phase === 'reserved' && age >= 30000) {
      expireReservation.run(timestamp(), row.project, row.id, new Date(Date.now() - 30000).toISOString());
      return byId.get(row.project, row.id);
    }
    if (!row.threadId || (!row.cancellationRequestedAt && age < observationWindowMs && row.phase !== 'unconfirmed') ||
        !native.findSubmission) {
      void dispatchCancellation(row);
      return row;
    }
    const prior = reconciled.get(row.project);
    if (prior?.id === row.id && Date.now() - prior.at < observationWindowMs) return row;
    reconciled.set(row.project, {id: row.id, at: Date.now()});
    try {
      const exact = await native.findSubmission(row.workspace, row.threadId, row.id, row.turnId,
        ...(row.expectedThreadId && !row.turnId ? [true] : []));
      const observed = typeof exact?.id === 'string' && exact.id && (!row.turnId || exact.id === row.turnId) ? phase(exact.status) : null;
      if (observed) advance(row, observed, exact.id, exact.startedAt ?? null);
      else if (row.phase === 'sending' && age >= 30000) markUnconfirmed.run(timestamp(), row.project, row.id);
      return byId.get(row.project, row.id);
    } catch { return closed ? row : byId.get(row.project, row.id); }
  }

  return {
    hasProjectHistory: id => Boolean(projectHistory.get(id)),
    hasActiveWork(project, exceptId = null) { return Boolean(activeRun.get(project.id, exceptId)); },
    hasNativeWork(project) {
      return Boolean(knownNativeWork.get(project.id, JSON.stringify(project.cwd)));
    },
    completedSource(project, checkout, threadId) {
      if (activeRun.get(project.id, null) || !project.cwd.includes(checkout)) return null;
      const row = latestAccepted.get(project.id, checkout);
      return row?.phase === 'completed' && row.threadId === threadId ? row : null;
    },
    chatConversationForTurn(project, threadId, turnId) {
      const rows = chatForTurn.all(project.id, threadId, turnId, JSON.stringify(project.cwd));
      if (rows.length > 1) return undefined;
      const row = rows[0];
      if (!row) return null;
      if (row.phase === 'completed' || (active.has(row.phase) && row.phase !== 'reserved')) return row.chatConversationId;
      return undefined;
    },
    completedChatReceipt(project, conversationId, id, threadId, turnId) {
      if (!allowedId.test(id)) return null;
      const row = linkedChatReceipt.get(project.id, conversationId, JSON.stringify(project.cwd), id);
      if (row?.phase !== 'completed' || row.threadId !== threadId || row.turnId !== turnId ||
          !nativeThreadId.test(row.threadId) || !nativeThreadId.test(row.turnId) ||
          !reviewHash.test(row.fingerprint) || !observedWorkTime(row.updatedAt, Date.now())) return null;
      const updated = Date.parse(row.updatedAt);
      if (!observedWorkTime(row.createdAt, updated) ||
          (row.startedAt !== null && !observedWorkTime(row.startedAt, updated)) ||
          (row.cancellationRequestedAt !== null && !observedWorkTime(row.cancellationRequestedAt, updated))) return null;
      return {workspace:row.workspace, snapshot:JSON.stringify(row)};
    },
    workForChat(project, conversationId) {
      const works = [];
      const now = Date.now();
      for (const row of linkedChatRows.all(project.id, conversationId, JSON.stringify(project.cwd), workOutcomeLimit)) {
        if (!allowedId.test(row.id) || !reviewHash.test(row.fingerprint) ||
            (!active.has(row.phase) && !terminal.has(row.phase)) || !observedWorkTime(row.updatedAt, now)) continue;
        const updated = Date.parse(row.updatedAt);
        if (!observedWorkTime(row.createdAt, updated) ||
            (row.cancellationRequestedAt !== null && !observedWorkTime(row.cancellationRequestedAt, updated))) continue;
        const hasThread = typeof row.threadId === 'string' && nativeThreadId.test(row.threadId);
        const hasTurn = typeof row.turnId === 'string' && nativeThreadId.test(row.turnId);
        if ((row.threadId !== null && !hasThread) || (row.turnId !== null && (!hasThread || !hasTurn))) continue;
        const confirmed = hasThread && hasTurn && row.phase !== 'reserved' && row.phase !== 'sending';
        if (!confirmed && (row.phase === 'completed' || row.phase === 'interrupted')) continue;
        works.push({id:row.id,phase:visiblePhase(row),observedAt:row.updatedAt,
          threadId:confirmed ? row.threadId : null,turnId:confirmed ? row.turnId : null});
      }
      return works;
    },
    completedArtifactSource(project, checkout, {operationId, threadId, turnId}) {
      if (typeof operationId !== 'string' || !allowedId.test(operationId) || typeof threadId !== 'string' ||
          !nativeThreadId.test(threadId) || typeof turnId !== 'string' || !turnId || !project.cwd.includes(checkout)) return null;
      const row = byId.get(project.id, operationId);
      return row?.phase === 'completed' && row.workspace === checkout && row.threadId === threadId && row.turnId === turnId
        ? {id: row.id, threadId: row.threadId, turnId: row.turnId, updatedAt: row.updatedAt} : null;
    },
    updateExecution(project, update) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (activeRun.get(project.id, null)) throw problem(409, 'Codexの実行または照合が終わるまで操作を開始できません。');
        const result = update();
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    managesThread(project, thread) {
      const row = project.codexWrite && native.canWrite && latestThread.get(project.id, thread);
      return Boolean(row && project.cwd.includes(row.workspace));
    },
    hasManagedActivityThread(project, thread) {
      return Boolean(managedActivityThread.get(thread, JSON.stringify(project.cwd)));
    },
    async read(project, id, receipt = null, thread = null) {
      if (receipt !== null && !receiptId.test(receipt)) throw problem(400, '引継ぎ元の受付番号を指定してください。');
      if (thread !== null && (!nativeThreadId.test(thread) || id !== null || receipt !== null)) {
        throw problem(400, '照合するスレッドを1件指定してください。');
      }
      const row = thread !== null ? latestTarget.get(project.id, thread, null) :
        id ? byId.get(project.id, id) : receipt ? latestHandover.get(project.id, receipt) : latest.get(project.id);
      if (row && (!project.cwd.includes(row.workspace) || (receipt && row.handoverReceipt !== receipt))) return {operation: null};
      return {operation: response(await runtimeResult(row))};
    },
    recentOutcomes(projects, now) {
      const results = [];
      for (const project of projects) {
        let count = 0;
        for (const row of savedOutcomes.iterate(project.id, JSON.stringify(project.cwd))) {
          if (!allowedId.test(row.id) || !reviewHash.test(row.fingerprint) ||
              !observedWorkTime(row.updatedAt, now) || !observedWorkTime(row.createdAt, Date.parse(row.updatedAt))) continue;
          const exact = typeof row.threadId === 'string' && nativeThreadId.test(row.threadId) &&
            typeof row.turnId === 'string' && nativeThreadId.test(row.turnId) &&
            (row.startedAt === null || observedWorkTime(row.startedAt, Date.parse(row.updatedAt)));
          const unsentFailure = row.phase === 'failed' && row.threadId === null && row.turnId === null && row.startedAt === null;
          if (!exact && !unsentFailure) continue;
          results.push({projectId:project.id, id:row.id, kind:'codex', phase:row.phase, observedAt:row.updatedAt,
            ...(exact ? {threadId:row.threadId} : {})});
          if (++count === workOutcomeLimit) break;
        }
      }
      return results;
    },
    portfolioActivity(project, now) {
      const row = latestScoped.get(project.id, JSON.stringify(project.cwd));
      if (!row) return null;
      const live = verifiedRunning.get(project.id);
      const age = now - Date.parse(live?.observedAt);
      const state = visiblePhase(row);
      const running = project.codexWrite && native.canWrite && state === 'running' &&
        live?.operationId === row.id && live.turnId === row.turnId && age >= 0 && age <= observationWindowMs;
      if (live && age > observationWindowMs) verifiedRunning.delete(project.id);
      const accepted = nativeThreadId.test(row.threadId ?? '') && nativeThreadId.test(row.turnId ?? '') && row.startedAt;
      const routeObservedAt = running ? live.observedAt : accepted && row.startedAt;
      const reason = ['failed','interrupted','cancelled'].includes(state) ? state :
        active.has(row.phase) && !running ? 'unconfirmed' : null;
      return {route:'subscription', createdAt:row.createdAt, observedAt:routeObservedAt || null,
        updatedAt:row.updatedAt, active:Boolean(running), liveAgeMs:observationWindowMs, reason};
    },
    async readActivity(project) {
      const row = await runtimeResult(latestScoped.get(project.id, JSON.stringify(project.cwd)));
      if (!row) return {activity: null};
      const isTerminal = terminal.has(row.phase);
      const isRecent = Date.now() - Date.parse(row.updatedAt) < observationWindowMs;
      const currentPhase = visiblePhase(row);
      return {activity: {id: row.id, kind: 'codex', phase: isTerminal || isRecent || currentPhase === 'cancelling' ? currentPhase : 'unconfirmed',
        observedAt: row.updatedAt, createdAt: row.createdAt, startedAt: row.startedAt, terminal: isTerminal}};
    },
    async start(project, input) {
      const handover = input?.handover;
      const beginsHandover = handover !== undefined;
      const threadTarget = input?.expectedThreadId;
      if (!input || typeof input.id !== 'string' || !allowedId.test(input.id) ||
          typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 ||
          (input.model !== undefined && typeof input.model !== 'string') ||
          (input.effort !== undefined && typeof input.effort !== 'string') ||
          (input.resume !== undefined && typeof input.resume !== 'string') ||
          (threadTarget !== undefined && (typeof threadTarget !== 'string' || !nativeThreadId.test(threadTarget) || !input.resume)) ||
          (input.route !== undefined && !ROUTES.includes(input.route)) ||
          (input.stage !== undefined && !STAGES.includes(input.stage)) ||
          (beginsHandover && (!handover || typeof handover.receipt !== 'string' || !receiptId.test(handover.receipt) ||
            typeof handover.review !== 'string' || !reviewHash.test(handover.review) || input.resume !== undefined || input.route !== 'subscription'))) {
        throw problem(400, '有効な指示を入力してください。');
      }
      if (input.image !== undefined && input.document !== undefined) throw problem(400, '画像か文書のどちらか1件だけを添付してください。');
      const attachment = validatedImage(input.image);
      const reference = validatedDocument(input.document);
      const previous = input.resume ? byId.get(project.id, input.resume) : null;
      const expected = await confirmedWorkspace(project);
      const resumeIsCurrent = () => {
        if (!input.resume) return true;
        if (!previous?.threadId || (threadTarget !== undefined && threadTarget !== previous.threadId)) return false;
        const row = latestTarget.get(project.id, previous.threadId, input.id);
        return row?.id === previous.id && row.workspace === expected && row.turnId === previous.turnId &&
          Boolean(row.turnId) && nativeTerminal.has(row.phase);
      };
      const choice = input.stage || input.route ? [input.stage, input.route] : [];
      const identity = [input.prompt, input.model, input.effort, input.resume, ...choice];
      if (threadTarget !== undefined) identity.push({expectedThreadId: threadTarget});
      if (beginsHandover) identity.push(handover.receipt, handover.review);
      if (attachment) identity.push({mime: attachment.image.mime, sha256: attachment.digest});
      if (reference) identity.push({name: reference.document.name, sha256: reference.digest});
      const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const duplicate = () => {
        const row = byId.get(project.id, input.id);
        if (row && (row.fingerprint !== digest || row.workspace !== expected)) throw problem(409, '送信IDが別の指示に使われています。');
        return row;
      };
      let row = duplicate();
      if (row) return {operation: response(row)};
      if (!resumeIsCurrent()) throw resumeUnavailable();
      const stage = input.stage ?? previous?.stage ?? 'implementation';
      const route = input.route ?? previous?.explicitRoute ?? null;
      const handoverReceipt = handover?.receipt ?? previous?.handoverReceipt ?? null;
      const alreadyLaunched = () => beginsHandover && Boolean(launchedHandover.get(project.id, handoverReceipt));
      let selection;
      let admissionObservedAt;
      let submittedPrompt = input.prompt;
      try {
        if (alreadyLaunched()) throw problem(409, 'この受付は引継ぎ済みです。元のCodexスレッドで続きを実行してください。');
        if (beginsHandover && (!prepareHandover || !execution)) throw problem(409, '引継ぎの照合を利用できません。');
        execution?.preflight(project, stage, expected, route, handoverReceipt);
        if (!await native.subscriptionReady?.()) throw problem(403, 'ChatGPTプランの認証を確認できないため、実行していません。');
        selection = execution ? await execution.authorize(project, {stage, route, model: input.model, effort: input.effort, handoverReceipt,
          ...(attachment ? {imageRequired: true} : {})})
          : {model: input.model, effort: input.effort};
        if (!execution) {
          const selected = await configureModel(selection.model, selection.effort, Boolean(attachment));
          if (attachment) {
            if (!Array.isArray(selected.inputModalities) || !selected.inputModalities.includes('image')) {
              throw problem(409, '選択したCodexモデルの画像入力対応を確認できません。', 'CODEX_IMAGE_MODEL_UNAVAILABLE');
            }
            selection = {...selection, model: selected.id};
          }
        }
        if (beginsHandover) {
          const checked = await prepareHandover(project, handover, expected);
          if (checked.revision !== selection.revision) throw problem(409, '実行設定が変わりました。');
          submittedPrompt = '次のJSONは同じ案件の確定済み作業記録です。要求正本と成果物を読み、現在の作業先と照合してください。相違があれば停止して報告してください。今回の依頼に沿って次の作業だけを進めてください。\n' +
            JSON.stringify(checked.context, null, 2) + '\n\n今回の依頼\n' + input.prompt;
          if (Buffer.byteLength(submittedPrompt, 'utf8') > 96000) throw problem(409, '引継ぎに必要な内容が送信上限を超えています。');
        }
        admissionObservedAt = await checkSubscriptionUsage();
      } catch (error) {
        row = duplicate();
        if (row) return {operation: response(row)};
        throw error;
      }
      try {
        if (!resumeIsCurrent()) throw resumeUnavailable();
        const chatConversationId = reference ? chatConversationForHandoff?.(project, reference) ?? null : null;
        if (!freshUsage(admissionObservedAt)) throw usageProblem('CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED');
        if (!insert.run(project.id, input.id, expected, digest, timestamp(), timestamp(), stage, route, handoverReceipt,
          handover?.review ?? null, input.resume ?? null, previous?.threadId ?? null, chatConversationId).changes) {
          throw resumeUnavailable();
        }
      }
      catch (error) {
        row = duplicate();
        if (row) return {operation: response(row)};
        if (String(error.code).startsWith('ERR_SQLITE')) throw problem(409, 'この案件には処理中のCodex作業があります。');
        throw error;
      }
      row = byId.get(project.id, input.id);
      const maySubmit = () => !closed && byId.get(project.id, input.id)?.phase === 'reserved' && resumeIsCurrent() && !alreadyLaunched() &&
        (!execution || execution.isCurrent(project, selection.revision, stage, expected, route, handoverReceipt));
      let usageObservedAt;
      let stillCurrent;
      const beforeTurn = async () => {
        if (beginsHandover) {
          const checked = await prepareHandover(project, handover, expected, input.id);
          if (checked.revision !== selection.revision) throw problem(409, '実行設定が変わりました。');
          stillCurrent = checked.stillCurrent;
        }
        usageObservedAt = await checkSubscriptionUsage();
      };
      void native.submit({workspace: expected, prompt: submittedPrompt, knownId: previous?.threadId, previousTurnId: previous?.turnId,
        model: selection.model, effort: selection.effort, requestId: input.id, ...(attachment ? {image: attachment.image} : {}),
        ...(reference ? {document: reference.document} : {}),
        beforeThread: () => {
          if (!maySubmit()) return false;
          if (!freshUsage(admissionObservedAt)) throw usageProblem('CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED');
          return true;
        }, beforeTurn,
        onThread: id => {
          if ((previous && id !== previous.threadId) || !maySubmit() || (beginsHandover && stillCurrent?.() !== true)) return false;
          if (!freshUsage(usageObservedAt)) throw usageProblem('CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED');
          return setThread.run(id, timestamp(), project.id, input.id).changes === 1;
        },
      }).then(result => {
        const observed = phase(result.turn.status);
        advance(row, observed ?? 'running', result.turn.id, timestamp(), observed === 'running');
      }).catch(error => {
        if (!closed) {
          const current = byId.get(project.id, input.id);
          if (current?.phase === 'reserved') {
            const failure = Object.hasOwn(subscriptionUsageMessages, error?.code) ? subscriptionUsageMessages[error.code] :
              error?.code === 'CODEX_RESUME_TARGET_UNAVAILABLE' ? resumeUnavailable().message :
                handoverReceipt ? '送信直前の引継ぎ条件またはCodex接続を確認できませんでした。' : '';
            if (failure) append.run(failure, timestamp(), project.id, input.id);
            advance(current, 'failed');
          }
          else markUnconfirmed.run(timestamp(), project.id, input.id);
        }
      });
      return {operation: response(row)};
    },
    async interrupt(project, id) {
      const row = byId.get(project.id, id);
      if (!row?.threadId || !row.turnId || !active.has(row.phase)) throw problem(409, '中断できるCodex作業を確認できません。');
      const workspace = await confirmedWorkspace(project);
      if (row.workspace !== workspace) throw problem(409, '作業先が変わっています。');
      if (closed) throw problem(503, 'Codexの接続を確認できません。');
      const current = byId.get(project.id, id);
      if (!active.has(current.phase) || current.cancellationRequestedAt || interruptRequests.has(row.turnId) ||
          !beginInterrupt.run(timestamp(), project.id, row.id, row.threadId, row.turnId).changes) {
        return {operation: response(byId.get(project.id, id))};
      }
      interruptRequests.add(row.turnId);
      try {
        await native.interrupt(workspace, row.threadId, row.turnId, () => {
          if (closed || !claimInterrupt.run(timestamp(), project.id, row.id, row.threadId, row.turnId).changes) {
            throw problem(409, '中断の送信権限または対象のターンを確認できません。');
          }
        });
      } catch {
        if (!closed) loseInterrupt.run(timestamp(), project.id, row.id, row.threadId, row.turnId);
      }
      finally { interruptRequests.delete(row.turnId); }
      return {operation: response(closed ? current : byId.get(project.id, id))};
    },
    async cancel(project, id) {
      if (typeof id !== 'string' || !allowedId.test(id)) throw problem(400, '中止する作業の受付番号を指定してください。');
      const row = byId.get(project.id, id);
      if (!row || !project.cwd.includes(row.workspace)) throw problem(404, '中止するCodex作業を確認できません。');
      const workspace = await confirmedWorkspace(project);
      if (closed) throw problem(503, 'Codexの接続を確認できません。');
      const authorized = readCurrentProject(directory, project.id);
      if (!authorized?.codexWrite) throw problem(403, 'この案件は履歴の参照のみです。');
      const thread = row.threadId ?? row.expectedThreadId;
      const newest = () => thread ? latestTarget.get(project.id, thread, null) : latest.get(project.id);
      if (!authorized.cwd.includes(workspace) || row.workspace !== workspace || newest()?.id !== id) {
        throw problem(409, '最新のCodex作業だけを中止できます。');
      }
      const requested = requestCancellation.run(timestamp(), id, workspace, project.id, thread).changes;
      if (newest()?.id !== id) throw problem(409, '最新のCodex作業だけを中止できます。');
      const current = byId.get(project.id, id);
      if (active.has(current.phase) && current.threadId) {
        if (requested && current.phase === 'running' && current.turnId) void dispatchCancellation(current);
        else void runtimeResult(current);
      }
      return {operation: response(current)};
    },
    async readSteering(project, id) {
      if (typeof id !== 'string' || !allowedId.test(id)) throw problem(400, '追加指示の受付番号を指定してください。');
      const steering = steeringById.get(project.id, id);
      const run = steering && byId.get(project.id, steering.operationId);
      if (!run || !project.cwd.includes(run.workspace)) return steeringResponse(null);
      if (['accepted', 'rejected'].includes(steering.phase) || Date.now() - Date.parse(steering.updatedAt) < 15000) return steeringResponse(steering);
      try {
        const exact = await native.hasTurnMessage(run.workspace, run.threadId, steering.turnId, steerClientId(id));
        if (!closed && exact) resolveSteering.run('accepted', timestamp(), project.id, id);
        else if (!closed) resolveSteering.run('unconfirmed', timestamp(), project.id, id);
      } catch { return steeringResponse(steering); }
      return steeringResponse(closed ? steering : steeringById.get(project.id, id));
    },
    async steer(project, input) {
      if (typeof input?.id !== 'string' || !allowedId.test(input.id) ||
          typeof input.operationId !== 'string' || !allowedId.test(input.operationId) ||
          typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 ||
          input.image !== undefined || input.document !== undefined) {
        throw problem(400, '追加指示と対象の作業を指定してください。');
      }
      const workspace = await confirmedWorkspace(project);
      const digest = createHash('sha256').update(JSON.stringify([input.operationId, input.prompt])).digest('hex');
      const previous = () => {
        const row = steeringById.get(project.id, input.id);
        if (row && row.fingerprint !== digest) throw problem(409, '受付番号が別の追加指示に使われています。');
        return row;
      };
      const existing = previous();
      if (existing) return steeringResponse(existing);
      const target = byId.get(project.id, input.operationId);
      if (!target?.threadId || !target.turnId || target.phase !== 'running' || target.cancellationRequestedAt || target.workspace !== workspace) {
        throw problem(409, '追加指示の対象のターンは実行中と確認できません。');
      }
      const maySteer = () => {
        const current = !closed && byId.get(project.id, input.operationId);
        if (current?.phase !== 'running' || current.cancellationRequestedAt || current.workspace !== workspace ||
            current.threadId !== target.threadId || current.turnId !== target.turnId) {
          throw problem(409, '元のCodexターンが中断されたか、実行状態が変わりました。');
        }
        execution?.preflight(project, target.stage, workspace, target.explicitRoute, target.handoverReceipt);
      };
      maySteer();
      let admissionObservedAt;
      try {
        if (!await native.subscriptionReady?.()) throw problem(403, 'ChatGPTプランの認証を確認できないため、実行していません。');
        admissionObservedAt = await checkSubscriptionUsage();
      } catch (error) {
        const concurrent = previous();
        if (concurrent) return steeringResponse(concurrent);
        throw error;
      }
      const concurrent = previous();
      if (concurrent) return steeringResponse(concurrent);
      const run = byId.get(project.id, input.operationId);
      if (!run?.threadId || !run.turnId || run.phase !== 'running' || run.cancellationRequestedAt || run.workspace !== workspace) {
        throw problem(409, '追加指示の対象のターンは実行中と確認できません。');
      }
      maySteer();
      if (!freshUsage(admissionObservedAt)) throw usageProblem('CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED');
      if (!reserveSteering.run(project.id, input.id, run.id, run.turnId, digest, timestamp()).changes) {
        return steeringResponse(previous());
      }
      let outcome = 'unconfirmed';
      let usageObservedAt;
      let usageFailure;
      const beforeSteer = async () => {
        try { usageObservedAt = await checkSubscriptionUsage(); }
        catch (error) {
          outcome = 'rejected';
          usageFailure = subscriptionUsageMessages[error.code];
          throw error;
        }
      };
      try {
        const sentTurn = await native.steer({workspace, threadId: run.threadId, turnId: run.turnId, requestId: steerClientId(input.id),
          prompt: input.prompt, beforeSteer, beforeSend: () => {
            try {
              if (!freshUsage(usageObservedAt)) throw usageProblem('CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED');
              maySteer();
            }
            catch (error) {
              outcome = 'rejected';
              if (Object.hasOwn(subscriptionUsageMessages, error?.code)) usageFailure = subscriptionUsageMessages[error.code];
              throw error;
            }
          }});
        if (sentTurn === run.turnId) outcome = 'accepted';
      } catch {}
      if (closed) return steeringResponse(null);
      resolveSteering.run(outcome, timestamp(), project.id, input.id);
      return {...steeringResponse(steeringById.get(project.id, input.id)), ...(usageFailure && {reason:usageFailure})};
    },
    close() { closed = true; unsubscribe?.(); db.close(); },
  };
}
