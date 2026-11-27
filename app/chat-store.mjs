import {randomUUID} from 'node:crypto';
import {chmodSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chatInputLimit, chatMessageLimit, chatModelPattern, chatOutputLimit} from './chatgpt-responses.mjs';
import {apiAdviceMaxLength} from './api-response.mjs';

const date = value => Number.isFinite(value) && value >= 0 && value < 253402300800 ? new Date(value * 1000).toISOString() : null;
const title = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : '無題の会話';
const idPattern = /^[a-z0-9_.:-]{1,160}$/i;

function officialConversation(value) {
  const id = value?.id ?? value?.conversation_id;
  if (typeof id !== 'string' || !idPattern.test(id) || typeof value.current_node !== 'string' ||
      !value.mapping || typeof value.mapping !== 'object' || Array.isArray(value.mapping)) return null;
  const visited = new Set();
  const messages = [];
  let key = value.current_node;
  while (key !== null) {
    const node = Object.hasOwn(value.mapping, key) ? value.mapping[key] : null;
    if (!node || visited.has(key) || visited.size >= 5000) return null;
    visited.add(key);
    const message = node.message;
    const role = message?.author?.role;
    if (role === 'user' || role === 'assistant') {
      const parts = message.content?.parts;
      const string = Array.isArray(parts) ? parts.filter(part => typeof part === 'string').join('\n').trim() : '';
      if (string) messages.push({role, text: string.slice(0, 30000), createdAt: date(message.create_time)});
    }
    key = typeof node.parent === 'string' ? node.parent : null;
  }
  const modified = Number.isFinite(value.update_time) && value.update_time >= 0 ? value.update_time : 0;
  return messages.length ? {id, title: title(value.title), modified, messages: messages.reverse()} : null;
}

const liveIdPattern = /^live\/[a-f0-9-]{36}$/;
const liveLease = 10 * 60 * 1000;
const liveStatuses = new Set(['completed', 'failed', 'incomplete', 'aborted', 'interrupted']);
const storeError = (status, code, message) => Object.assign(new Error(message), {status, code});
const developmentSource = 'api-development';
const developmentStatuses = new Set(['completed', 'failed', 'interrupted', 'unconfirmed']);

function developmentId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw storeError(400, 'INVALID_DEVELOPMENT_RECEIPT', 'API作業の受付番号を確認できません。');
  }
  return `api/${id}`;
}

function isoTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || !/^\d{4}-/.test(value) || new Date(time).toISOString() !== value) {
    throw storeError(400, 'INVALID_DEVELOPMENT_TIME', 'API作業の記録時刻を確認できません。');
  }
  return time;
}

function archiveView(row, offset = 0) {
  const {messages: saved, ...details} = row;
  const parsed = JSON.parse(saved);
  const {model, outcome, messages} = row.source === developmentSource ? parsed : {messages: parsed};
  return {conversation: {...details, ...(row.source === developmentSource ? {model, outcome} : {}), messages: messages.slice(offset, offset + 40)},
    nextOffset: offset + 40 < messages.length ? offset + 40 : null};
}

const documentText = ({name, text}) => '添付資料（' + name + '）\n' + text;

function providerMessage({role, text, document}) {
  return {role, content: document ? [
    {type: 'input_text', text}, {type: 'input_text', text: documentText(document)},
  ] : text};
}

function boundedHistory(messages, budget = chatInputLimit) {
  const result = [];
  for (let at = messages.length - 1; at >= 0 && result.length < chatMessageLimit - 1 && budget > 0; at--) {
    const {document, ...message} = messages[at];
    const text = message.text.slice(0, Math.min(budget, 6000));
    if (!text.trim()) continue;
    budget -= text.length;
    const attachmentLength = document ? documentText(document).length : 0;
    const includeDocument = attachmentLength > 0 && attachmentLength <= budget;
    if (includeDocument) budget -= attachmentLength;
    result.push({...message, text, ...(includeDocument ? {document} : {})});
  }
  return result.reverse();
}

export function createChatStore(directory, {now = Date.now} = {}) {
  const file = join(directory, 'conversations.sqlite');
  try {
    if (!lstatSync(file).isFile()) throw new Error('Invalid conversation store');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout = 3000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS conversations (
      project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
      imported_at TEXT NOT NULL, modified REAL NOT NULL, messages TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'chatgpt-export',
      PRIMARY KEY(project,id)
    );
    CREATE TABLE IF NOT EXISTS live_conversations (
      project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
      updated_at TEXT NOT NULL, source_id TEXT, history TEXT NOT NULL,
      PRIMARY KEY(project,id)
    );
    CREATE TABLE IF NOT EXISTS live_turns (
      project TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      requested_conversation_id TEXT, model TEXT NOT NULL, prompt TEXT NOT NULL, text TEXT NOT NULL, document TEXT,
      status TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed','incomplete','aborted','interrupted')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_until INTEGER NOT NULL,
      PRIMARY KEY(project,id),
      FOREIGN KEY(project,conversation_id) REFERENCES live_conversations(project,id)
    );
    CREATE INDEX IF NOT EXISTS live_timeline ON live_turns(project,conversation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS live_in_progress ON live_turns(project,conversation_id) WHERE status='in_progress'`);
  try {
    inTransaction(() => {
      if (!db.prepare('PRAGMA table_info(conversations)').all().some(({name}) => name === 'source')) {
        db.exec("ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'chatgpt-export'");
      }
      if (!db.prepare('PRAGMA table_info(live_turns)').all().some(({name}) => name === 'document')) {
        db.exec('ALTER TABLE live_turns ADD COLUMN document TEXT');
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const add = db.prepare(`INSERT INTO conversations (project,id,title,imported_at,modified,messages)
    VALUES (?,?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET title=excluded.title,
      imported_at=excluded.imported_at, modified=excluded.modified, messages=excluded.messages
    WHERE conversations.source='chatgpt-export' AND excluded.modified > conversations.modified`);
  const insertDevelopment = db.prepare(`INSERT INTO conversations (project,id,title,imported_at,modified,messages,source)
    VALUES (?,?,?,?,?,?,'api-development')`);
  const finalizeDevelopment = db.prepare(`UPDATE conversations SET imported_at=?,modified=?,messages=?
    WHERE project=? AND id=? AND source='api-development'`);
  const list = db.prepare(`SELECT id,title,importedAt,source FROM (
    SELECT id,title,imported_at AS importedAt,source FROM conversations
      WHERE project=?1 AND (?2='' OR instr(lower(title),lower(?2))>0 OR instr(lower(messages),lower(?2))>0)
    UNION ALL
    SELECT c.id,c.title,c.updated_at,'chatgpt-live' FROM live_conversations c
      WHERE c.project=?1 AND (?2='' OR instr(lower(c.title),lower(?2))>0 OR instr(lower(c.history),lower(?2))>0 OR
        EXISTS(SELECT 1 FROM live_turns t WHERE t.project=c.project AND t.conversation_id=c.id AND
          (instr(lower(t.prompt),lower(?2))>0 OR instr(lower(t.text),lower(?2))>0 OR
            CASE WHEN json_valid(t.document) THEN
              instr(lower(json_extract(t.document,'$.name')),lower(?2))>0 OR
              instr(lower(json_extract(t.document,'$.text')),lower(?2))>0
            ELSE 0 END)))
    ) ORDER BY importedAt DESC,id LIMIT 250`);
  const get = db.prepare(`SELECT id,title,imported_at AS importedAt,messages,source FROM conversations WHERE project=? AND id=?`);
  const getLive = db.prepare(`SELECT id,title,updated_at AS importedAt,source_id AS sourceConversationId,history
    FROM live_conversations WHERE project=? AND id=?`);
  const insertLive = db.prepare(`INSERT INTO live_conversations(project,id,title,updated_at,source_id,history) VALUES(?,?,?,?,?,?)`);
  const touchLive = db.prepare(`UPDATE live_conversations SET updated_at=? WHERE project=? AND id=?`);
  const getTurn = db.prepare(`SELECT id,conversation_id AS conversationId,requested_conversation_id AS requestedConversationId,
    model,prompt,text,document,status,created_at AS createdAt,updated_at AS updatedAt FROM live_turns WHERE project=? AND id=?`);
  const addTurn = db.prepare(`INSERT INTO live_turns(project,id,conversation_id,requested_conversation_id,model,prompt,document,text,status,created_at,updated_at,lease_until)
    VALUES(?,?,?,?,?,?,?,'','in_progress',?,?,?)`);
  const activeTurn = db.prepare(`SELECT 1 FROM live_turns WHERE project=? AND conversation_id=? AND status='in_progress'`);
  const activeProject = db.prepare(`SELECT 1 FROM live_turns WHERE project=? AND status='in_progress' AND lease_until>? LIMIT 1`);
  const hasStaleTurns = db.prepare(`SELECT 1 FROM live_turns WHERE project=? AND status='in_progress' AND lease_until<=? LIMIT 1`);
  const staleTurns = db.prepare(`UPDATE live_turns SET status='interrupted',updated_at=?
    WHERE project=? AND status='in_progress' AND lease_until<=?`);
  const saveTurn = db.prepare(`UPDATE live_turns SET status=?,text=?,updated_at=? WHERE project=? AND id=? AND status='in_progress'`);
  const recentTurns = db.prepare(`SELECT prompt,text,document FROM live_turns WHERE project=? AND conversation_id=? AND status='completed'
    ORDER BY rowid DESC LIMIT 8`);
  const page = db.prepare(`SELECT role,text,document,createdAt,status,turnId FROM (
    SELECT rowid AS sequence,0 AS part,'user' AS role,prompt AS text,document,created_at AS createdAt,status,id AS turnId FROM live_turns
      WHERE project=?1 AND conversation_id=?2
    UNION ALL
    SELECT rowid,1,'assistant',text,NULL,updated_at,status,id FROM live_turns
      WHERE project=?1 AND conversation_id=?2 AND (text<>'' OR status<>'in_progress')
    ) ORDER BY sequence,part LIMIT ?3 OFFSET ?4`);

  const projectHistory = db.prepare(
    'SELECT 1 FROM conversations WHERE project=?1 COLLATE NOCASE UNION ALL ' +
    'SELECT 1 FROM live_conversations WHERE project=?1 COLLATE NOCASE UNION ALL ' +
    'SELECT 1 FROM live_turns WHERE project=?1 COLLATE NOCASE LIMIT 1');

  function inTransaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function turnView(row) {
    if (!row) return null;
    const {requestedConversationId, document, ...turn} = row;
    return document ? {...turn, document: {name: JSON.parse(document).name}} : turn;
  }

  function expireTurnLeases(project, time) {
    if (hasStaleTurns.get(project, time)) staleTurns.run(new Date(time).toISOString(), project, time);
  }

  function updateTurn(project, id, status, text) {
    if (typeof text !== 'string' || text.length > chatOutputLimit) {
      throw storeError(400, 'INVALID_CHAT_TEXT', '回答の形式が正しくありません。');
    }
    return inTransaction(() => {
      const time = now();
      expireTurnLeases(project, time);
      const row = getTurn.get(project, id);
      if (!row) throw storeError(404, 'CHAT_TURN_NOT_FOUND', 'チャットの応答を見つけられませんでした。');
      if (row.status !== 'in_progress') return turnView(row);
      if (!text.startsWith(row.text)) throw storeError(409, 'CHAT_TEXT_CONFLICT', '保存済みの応答を上書きできません。');
      if (row.status === status && row.text === text) return turnView(row);
      const updatedAt = new Date(time).toISOString();
      saveTurn.run(status, text, updatedAt, project, id);
      touchLive.run(updatedAt, project, row.conversationId);
      return turnView(getTurn.get(project, id));
    });
  }

  return {
    list: (project, query = '') => ({conversations: list.all({1: project, 2: query})}),
    read(project, id, offset) {
      const row = get.get(project, id);
      if (row) return archiveView(row, offset);
      const live = getLive.get(project, id);
      if (!live) return null;
      expireTurnLeases(project, now());
      const {history, ...details} = live;
      const snapshot = JSON.parse(history);
      const messages = snapshot.slice(offset, offset + 41);
      const current = page.all({1: project, 2: id, 3: 41 - messages.length, 4: Math.max(0, offset - snapshot.length)});
      messages.push(...current.map(({document, ...message}) => document ? {...message, document: JSON.parse(document)} : message));
      return {conversation: {...details, source: 'chatgpt-live', messages: messages.slice(0, 40)},
        nextOffset: messages.length > 40 ? offset + 40 : null};
    },
    beginDevelopment(project, {id, prompt, model, createdAt}) {
      const archive = developmentId(id);
      const time = isoTime(createdAt);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 ||
          typeof model !== 'string' || !chatModelPattern.test(model)) {
        throw storeError(400, 'INVALID_DEVELOPMENT_REQUEST', 'API作業の指示またはモデルを確認できません。');
      }
      return inTransaction(() => {
        const previous = get.get(project, archive);
        if (previous) {
          const view = archiveView(previous);
          const [original] = view.conversation.messages;
          if (previous.source !== developmentSource || view.conversation.model !== model ||
              original.text !== prompt || original.createdAt !== createdAt) {
            throw storeError(409, 'DEVELOPMENT_REQUEST_CONFLICT', 'API作業の受付番号が別の指示に使われています。');
          }
          return view;
        }
        const messages = [{role: 'user', text: prompt, createdAt}];
        insertDevelopment.run(project, archive, title(prompt), createdAt, time,
          JSON.stringify({model, outcome: 'in_progress', messages}));
        return archiveView(get.get(project, archive));
      });
    },
    finishDevelopment(project, {id, outcome, summary = '', preserveSummary = false, updatedAt}) {
      const archive = developmentId(id);
      const time = isoTime(updatedAt);
      if (!developmentStatuses.has(outcome) || typeof summary !== 'string' || summary.length > (preserveSummary ? apiAdviceMaxLength : 2000) ||
          (outcome === 'unconfirmed' && summary.trim())) {
        throw storeError(400, 'INVALID_DEVELOPMENT_RESULT', 'API作業の記録内容を確認できません。');
      }
      const text = preserveSummary ? summary : summary.trim();
      return inTransaction(() => {
        const row = get.get(project, archive);
        if (row?.source !== developmentSource) throw storeError(404, 'DEVELOPMENT_NOT_FOUND', 'この案件のAPI作業を確認できません。');
        const {model, outcome: previous, messages} = JSON.parse(row.messages);
        const settledAfterUncertainty = previous === 'unconfirmed' && outcome !== 'unconfirmed' && updatedAt > row.importedAt;
        if (previous !== 'in_progress' && !settledAfterUncertainty) {
          if (previous !== outcome || (messages[1]?.text ?? '') !== text || row.importedAt !== updatedAt) {
            throw storeError(409, 'DEVELOPMENT_RESULT_CONFLICT', '保存済みのAPI作業結果を上書きできません。');
          }
          return archiveView(row);
        }
        if (updatedAt < row.importedAt) throw storeError(409, 'DEVELOPMENT_TIME_CONFLICT', 'API作業の終了時刻が受付より前です。');
        if (text) messages.push({role: 'assistant', text, createdAt: updatedAt});
        finalizeDevelopment.run(updatedAt, time, JSON.stringify({model, outcome, messages}), project, archive);
        return archiveView(get.get(project, archive));
      });
    },
    hasActiveLive: project => Boolean(activeProject.get(project, now())),
    beginLive(project, {id, conversationId = null, model, prompt, document}, beforeReserve) {
      if (typeof id !== 'string' || !idPattern.test(id) || typeof model !== 'string' ||
          !chatModelPattern.test(model) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 ||
          (conversationId !== null && (typeof conversationId !== 'string' ||
            (!idPattern.test(conversationId) && !liveIdPattern.test(conversationId)))) ||
          (document !== undefined && (!document || typeof document.name !== 'string' || typeof document.text !== 'string' ||
            prompt.length + documentText(document).length > chatInputLimit))) {
        throw storeError(400, 'INVALID_CHAT_REQUEST', 'チャットの入力が正しくありません。');
      }
      const savedDocument = document ? JSON.stringify({name: document.name, text: document.text}) : null;
      return inTransaction(() => {
        const time = now();
        expireTurnLeases(project, time);
        const previous = getTurn.get(project, id);
        if (previous) {
          if (previous.requestedConversationId !== conversationId || previous.model !== model || previous.prompt !== prompt ||
              previous.document !== savedDocument) {
            throw storeError(409, 'CHAT_REQUEST_CONFLICT', 'この送信IDは別の入力に使用されています。');
          }
          return {turn: turnView(previous), duplicate: true};
        }

        const createdAt = new Date(time).toISOString();
        const live = conversationId && getLive.get(project, conversationId);
        const archive = !live && conversationId && get.get(project, conversationId);
        const source = archive?.source === 'chatgpt-export' ? archive : null;
        if (conversationId && !live && !source) throw storeError(404, 'CHAT_NOT_FOUND', '会話を見つけられませんでした。');
        if (live && activeTurn.get(project, live.id)) {
          throw storeError(409, 'CHAT_IN_PROGRESS', 'この会話では応答の生成中です。');
        }

        const liveId = live ? live.id : `live/${randomUUID()}`;
        const snapshot = live ? JSON.parse(live.history) : source ? boundedHistory(JSON.parse(source.messages)) : [];
        beforeReserve?.();
        if (!live) {
          insertLive.run(project, liveId, source?.title ?? title(prompt), createdAt, source?.id ?? null, JSON.stringify(snapshot));
        }
        const recent = recentTurns.all(project, liveId).reverse().flatMap(row => [
          {role: 'user', text: row.prompt, ...(row.document ? {document: JSON.parse(row.document)} : {})},
          {role: 'assistant', text: row.text},
        ]);
        const history = boundedHistory([...snapshot, ...recent],
          chatInputLimit - prompt.length - (document ? documentText(document).length : 0));
        const messages = history.map(providerMessage);
        messages.push(providerMessage({role: 'user', text: prompt, document}));
        addTurn.run(project, id, liveId, conversationId, model, prompt, savedDocument, createdAt, createdAt, time + liveLease);
        touchLive.run(createdAt, project, liveId);
        return {turn: turnView(getTurn.get(project, id)), duplicate: false, messages};
      });
    },
    readLive(project, id) {
      expireTurnLeases(project, now());
      return turnView(getTurn.get(project, id));
    },
    persistLiveText: (project, id, text) => updateTurn(project, id, 'in_progress', text),
    finishLive(project, id, {status, text}) {
      if (!liveStatuses.has(status)) throw storeError(400, 'INVALID_CHAT_STATUS', '応答の状態が正しくありません。');
      return updateTurn(project, id, status, text);
    },
    import(project, json) {
      const rows = Array.isArray(json) ? json : json?.conversations;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 3000) return null;
      const conversations = rows.map(officialConversation).filter(Boolean);
      if (!conversations.length) return null;
      inTransaction(() => {
        const importedAt = new Date(now()).toISOString();
        for (const row of conversations) add.run(project, row.id, row.title, importedAt, row.modified, JSON.stringify(row.messages));
      });
      return {imported: conversations.length, skipped: rows.length - conversations.length};
    },
    hasProjectHistory: id => Boolean(projectHistory.get(id)),
    withWriteLock: inTransaction,
    close: () => db.close(),
  };
}
