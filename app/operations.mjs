import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const active = new Set(['reserved', 'sending', 'running', 'interrupting', 'unconfirmed']);
const terminal = new Set(['completed', 'interrupted', 'failed']);
const allowedId = /^[a-z0-9_-]{8,80}$/i;
const timestamp = () => new Date().toISOString();
const problem = (status, message) => Object.assign(new Error(message), {status});
const phase = value => terminal.has(value) ? value : value === 'inProgress' ? 'running' : null;

export function createOperations(directory, native) {
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  db.exec(`PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS codex_operations (
      id TEXT NOT NULL, project TEXT NOT NULL, workspace TEXT NOT NULL, fingerprint TEXT NOT NULL,
      phase TEXT NOT NULL, threadId TEXT, turnId TEXT, createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL, startedAt TEXT, output TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(project,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON codex_operations(project)
    WHERE phase IN ('reserved','sending','running','interrupting','unconfirmed');`);
  const byId = db.prepare('SELECT * FROM codex_operations WHERE project=? AND id=?');
  const latest = db.prepare('SELECT * FROM codex_operations WHERE project=? ORDER BY createdAt DESC LIMIT 1');
  const byClientId = db.prepare(`SELECT * FROM codex_operations WHERE threadId=? AND id=? AND turnId IS NULL
    AND phase IN ('sending','unconfirmed') LIMIT 1`);
  const byTurn = db.prepare('SELECT * FROM codex_operations WHERE threadId=? AND turnId=? LIMIT 1');
  const insert = db.prepare(`INSERT INTO codex_operations(project,id,workspace,fingerprint,phase,createdAt,updatedAt)
    VALUES (?,?,?,?,'reserved',?,?)`);
  const setThread = db.prepare(`UPDATE codex_operations SET threadId=?,phase='sending',updatedAt=? WHERE project=? AND id=? AND phase='reserved'`);
  const expireReservation = db.prepare(`UPDATE codex_operations SET phase='failed',updatedAt=?
    WHERE project=? AND id=? AND phase='reserved' AND threadId IS NULL AND updatedAt<=?`);
  const markUnconfirmed = db.prepare(`UPDATE codex_operations SET phase='unconfirmed',updatedAt=?
    WHERE project=? AND id=? AND phase='sending' AND turnId IS NULL`);
  const change = db.prepare(`UPDATE codex_operations SET phase=?, turnId=coalesce(turnId,?), updatedAt=?,
    startedAt=coalesce(startedAt,?) WHERE project=? AND id=? AND phase NOT IN ('completed','interrupted','failed')
    AND (turnId IS NULL OR ? IS NULL OR turnId=?)`);
  const append = db.prepare(`UPDATE codex_operations SET output=substr(output||?,1,48000), updatedAt=?
    WHERE project=? AND id=? AND phase NOT IN ('completed','interrupted','failed')`);
  const reconciled = new Map();
  const interruptRequests = new Set();
  let closed = false;

  function advance(row, state, turnId, startedAt = null) {
    if (closed || !row) return;
    if (state === 'running' && byId.get(row.project, row.id)?.phase === 'interrupting') return;
    change.run(state, turnId ?? null, timestamp(), startedAt, row.project, row.id, turnId ?? null, turnId ?? null);
  }
  function response(row) {
    if (!row) return null;
    const {fingerprint, workspace, ...view} = row;
    return view;
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
      if (row && active.has(row.phase)) append.run(value.delta.slice(0, 4000), timestamp(), row.project, row.id);
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

  async function configureModel(model, effort) {
    if (model === undefined && effort === undefined) return;
    const {data} = await native.models();
    const selected = model === undefined ? data.find(row => row.isDefault) : data.find(row => row.id === model);
    if (!selected || (effort !== undefined && !selected.reasoningEfforts.some(row => row.reasoningEffort === effort))) {
      throw problem(400, 'このCodex接続で利用できるモデルまたは推論レベルを選択してください。');
    }
  }

  async function runtimeResult(row) {
    if (!row || !active.has(row.phase)) return row;
    const age = Date.now() - Date.parse(row.updatedAt);
    if (row.phase === 'reserved' && age >= 30000) {
      expireReservation.run(timestamp(), row.project, row.id, new Date(Date.now() - 30000).toISOString());
      return byId.get(row.project, row.id);
    }
    if (!row.threadId || (age < 15000 && row.phase !== 'unconfirmed')) return row;
    const prior = reconciled.get(row.project);
    if (prior?.id === row.id && Date.now() - prior.at < 15000) return row;
    reconciled.set(row.project, {id: row.id, at: Date.now()});
    try {
      const exact = await native.findSubmission(row.workspace, row.threadId, row.id, row.turnId);
      const observed = phase(exact?.status);
      if (observed) advance(row, observed, exact.id, exact.startedAt ?? null);
      else if (row.phase === 'sending' && age >= 30000) markUnconfirmed.run(timestamp(), row.project, row.id);
      return byId.get(row.project, row.id);
    } catch { return row; }
  }

  return {
    async read(project, id) {
      const row = id ? byId.get(project.id, id) : latest.get(project.id);
      if (row && !project.cwd.includes(row.workspace)) return {operation: null};
      return {operation: response(await runtimeResult(row))};
    },
    async start(project, input) {
      if (!input || typeof input.id !== 'string' || !allowedId.test(input.id) ||
          typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 ||
          (input.model !== undefined && typeof input.model !== 'string') ||
          (input.effort !== undefined && typeof input.effort !== 'string') ||
          (input.resume !== undefined && typeof input.resume !== 'string')) {
        throw problem(400, '有効な指示を入力してください。');
      }
      const previous = input.resume ? byId.get(project.id, input.resume) : null;
      const expected = await confirmedWorkspace(project);
      if (input.resume && (!previous?.threadId || !previous.turnId || !terminal.has(previous.phase) || previous.workspace !== expected)) {
        throw problem(409, 'この作業を同じCodexスレッドで続けられません。');
      }
      const digest = createHash('sha256').update(JSON.stringify([input.prompt, input.model, input.effort, input.resume])).digest('hex');
      const duplicate = () => {
        const row = byId.get(project.id, input.id);
        if (row && (row.fingerprint !== digest || row.workspace !== expected)) throw problem(409, '送信IDが別の指示に使われています。');
        return row;
      };
      let row = duplicate();
      if (row) return {operation: response(row)};
      if (!await native.subscriptionReady?.()) throw problem(403, 'ChatGPTプランの認証を確認できないため、実行していません。');
      await configureModel(input.model, input.effort);
      try { insert.run(project.id, input.id, expected, digest, timestamp(), timestamp()); }
      catch (error) {
        row = duplicate();
        if (row) return {operation: response(row)};
        if (String(error.code).startsWith('ERR_SQLITE')) throw problem(409, 'この案件には処理中のCodex作業があります。');
        throw error;
      }
      row = byId.get(project.id, input.id);
      void native.submit({workspace: expected, prompt: input.prompt, knownId: previous?.threadId,
        model: input.model, effort: input.effort, requestId: input.id,
        onThread: id => !closed && setThread.run(id, timestamp(), project.id, input.id).changes === 1,
      }).then(result => {
        advance(row, phase(result.turn.status) ?? 'running', result.turn.id, timestamp());
      }).catch(() => {
        if (!closed) {
          const current = byId.get(project.id, input.id);
          if (current?.phase === 'reserved') advance(current, 'failed');
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
      const current = byId.get(project.id, id);
      if (!active.has(current.phase) || interruptRequests.has(row.turnId)) return {operation: response(current)};
      interruptRequests.add(row.turnId);
      advance(current, 'interrupting', row.turnId);
      try { await native.interrupt(workspace, row.threadId, row.turnId); }
      catch { advance(current, 'unconfirmed', row.turnId); }
      finally { interruptRequests.delete(row.turnId); }
      return {operation: response(closed ? current : byId.get(project.id, id))};
    },
    close() { closed = true; unsubscribe?.(); db.close(); },
  };
}
