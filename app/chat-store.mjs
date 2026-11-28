import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chatInputLimit, chatMessageLimit, chatModelPattern, chatOutputLimit} from './chatgpt-responses.mjs';
import {validatedImage} from './image-attachment.mjs';
import {codexResultDocumentName, codexResultStaleCode} from './text-attachment.mjs';
import {apiAdviceMaxLength} from './api-response.mjs';
import {realtimeArchiveId, realtimeArchiveReview, realtimeReceiptId, validRealtimeContinuation} from './realtime-history.mjs';

const date = value => Number.isFinite(value) && value >= 0 && value < 253402300800 ? new Date(value * 1000).toISOString() : null;
const title = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : '無題の会話';
const idPattern = /^[a-z0-9_.:-]{1,160}$/i;
export const isLivePreSendFailure = code => code === codexResultStaleCode || code === 'EXECUTION_HELD';
export const chatHistoryPageSize = 40;
export const chatHistoryLastOffset = 5000;
const exportedTextPartSize = 30000;
const exportedTextDigest = text => createHash('sha256').update(JSON.stringify(text)).digest('hex');
const unshownExportTypes = new Set(['thoughts','reasoning','reasoning_recap','model_editable_context',
  'user_editable_context','tool_result']);

function splitsCharacter(text, offset) {
  return offset > 0 && offset < text.length &&
    (text.charCodeAt(offset - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(offset) & 0xfc00) === 0xdc00;
}

function exportedTextPart(text, offset) {
  const boundary = Math.min(offset + exportedTextPartSize, text.length);
  const end = splitsCharacter(text, boundary) ? boundary - 1 : boundary;
  return {text: text.slice(offset, end), nextOffset: end < text.length ? end : null};
}

function officialConversation(value) {
  const id = value?.id ?? value?.conversation_id;
  if (typeof id !== 'string' || !idPattern.test(id) || typeof value.current_node !== 'string' ||
      !value.mapping || typeof value.mapping !== 'object' || Array.isArray(value.mapping)) return null;
  const visited = new Set();
  const messages = [];
  const legacy = [];
  let differsFromLegacy = false;
  let key = value.current_node;
  while (key !== null) {
    const node = Object.hasOwn(value.mapping, key) ? value.mapping[key] : null;
    if (!node || visited.has(key) || visited.size >= 5000) return null;
    visited.add(key);
    const message = node.message;
    const role = message?.author?.role;
    if (role === 'user' || role === 'assistant') {
      const parts = message.content?.parts;
      const text = Array.isArray(parts) ? parts.filter(part => typeof part === 'string').join('\n') : '';
      const oldText = text.trim().slice(0, 30000);
      if (oldText) {
        const createdAt = date(message.create_time);
        const hidden = message.metadata?.is_visually_hidden_from_conversation === true ||
          message.metadata?.is_user_system_message === true || message.channel === 'analysis' ||
          (message.recipient != null && message.recipient !== 'all') ||
          unshownExportTypes.has(message.content?.content_type);
        legacy.push({role, text: oldText, createdAt});
        if (!hidden) messages.push({role, text, createdAt});
        differsFromLegacy ||= hidden || text !== oldText;
      }
    }
    key = typeof node.parent === 'string' ? node.parent : null;
  }
  const modified = Number.isFinite(value.update_time) && value.update_time >= 0 ? value.update_time : 0;
  return legacy.length ? {id, title: title(value.title), modified, messages: messages.reverse(),
    legacy: differsFromLegacy ? legacy.reverse() : null} : null;
}

const liveIdPattern = /^live\/[a-f0-9-]{36}$/;
const liveLease = 10 * 60 * 1000;
const liveStatuses = new Set(['completed', 'failed', 'incomplete', 'aborted', 'interrupted']);
const storeError = (status, code, message) => Object.assign(new Error(message), {status, code});
const developmentSource = 'api-development';
const voiceSource = 'openai-realtime';
const receiptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const developmentStatuses = new Set(['completed', 'failed', 'interrupted', 'unconfirmed']);

function developmentId(id) {
  if (typeof id !== 'string' || !receiptIdPattern.test(id)) {
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
  const structured = row.source === developmentSource || row.source === voiceSource;
  const {model, outcome, messages} = structured ? parsed : {messages: parsed};
  const through = offset + chatHistoryPageSize;
  const page = messages.slice(offset, through);
  const display = row.source === 'chatgpt-export' ? page.map(({exportedTextVersion, ...message}, index) => {
    if (message.text.length <= exportedTextPartSize) return message;
    const preview = exportedTextPart(message.text, 0);
    return {...message, text: preview.text, original: {
      index: offset + index, sha256: exportedTextDigest(message.text), nextOffset: preview.nextOffset,
    }};
  }) : page;
  return {conversation: {...details, ...(structured ? {model, outcome} : {}), messages: display},
    nextOffset: through < messages.length ? through : null};
}

function readRealtimeArchive(row) {
  if (row?.source !== voiceSource) return null;
  const invalid = () => storeError(409, 'REALTIME_VOICE_HISTORY_UNVERIFIED', '保存済みの音声会話を照合できません。');
  try {
    const {id, importedAt, title} = row;
    const {model, outcome, messages: stored} = JSON.parse(row.messages);
    if (!realtimeArchiveId.test(id) || typeof model !== 'string' || !chatModelPattern.test(model) || outcome !== 'completed' ||
        !Array.isArray(stored) || !stored.length || stored.length > 42) throw invalid();
    isoTime(importedAt);
    const first = id.slice('realtime/'.length);
    const legacy = stored.every(message => !Object.hasOwn(message, 'turnId'));
    const groups = [];
    const verifiedIds = new Set();
    const messages = stored.map(({role, text, createdAt, turnId = legacy ? first : undefined}) => {
      if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text.trim() || !text.isWellFormed() ||
          text.length > 12000 || !realtimeReceiptId.test(turnId) || isoTime(createdAt) > isoTime(importedAt)) throw invalid();
      const message = {role, text, createdAt, turnId};
      let group = groups.at(-1);
      if (group?.id !== turnId) {
        if (verifiedIds.has(turnId) || (!groups.length && turnId !== first)) throw invalid();
        group = {id: turnId, messages: []};
        verifiedIds.add(turnId);
        groups.push(group);
      }
      if (group.messages.length && (group.messages.length !== 1 || group.messages[0].role !== 'user' || role !== 'assistant')) {
        throw invalid();
      }
      group.messages.push(message);
      return message;
    });
    return {id, title, model, importedAt, messages, groups, review: realtimeArchiveReview(id, importedAt, messages)};
  } catch { throw invalid(); }
}

const documentText = ({name, text}) => '添付資料（' + name + '）\n' + text;

function providerMessage({role, text, document, image}) {
  const attachment = image ? {type: 'input_image', image_url: 'data:' + image.mime + ';base64,' + image.data, detail: 'auto'} :
    document ? {type: 'input_text', text: documentText(document)} : null;
  return {role, content: attachment ? [{type: 'input_text', text}, attachment] : text};
}

function storedAttachment(value) {
  if (!value) return {};
  const attachment = JSON.parse(value);
  return attachment.image ? {image: attachment.image} : {document: attachment};
}

function imageMetadata({mime, size, sha256}) {
  return {mime, size, sha256};
}

function boundedHistory(messages, budget = chatInputLimit) {
  const result = [];
  for (let at = messages.length - 1; at >= 0 && result.length < chatMessageLimit - 1 && budget > 0; at--) {
    const {document, ...message} = messages[at];
    const text = message.text.slice(0, Math.min(budget, 6000));
    if (!text.trim()) continue;
    budget -= text.length;
    // A reviewed Codex result is shared only on its explicitly confirmed turn.
    const attachmentLength = document && document.name !== codexResultDocumentName ? documentText(document).length : 0;
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
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_until INTEGER NOT NULL, failure_code TEXT,
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
      const liveColumns = new Set(db.prepare('PRAGMA table_info(live_turns)').all().map(({name}) => name));
      if (!liveColumns.has('document')) {
        db.exec('ALTER TABLE live_turns ADD COLUMN document TEXT');
      }
      if (!liveColumns.has('failure_code')) {
        db.exec('ALTER TABLE live_turns ADD COLUMN failure_code TEXT');
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
  const recoverExport = db.prepare(`UPDATE conversations SET imported_at=?, messages=?
    WHERE project=? AND id=? AND source='chatgpt-export' AND modified=? AND title=? AND messages=?`);
  const insertDevelopment = db.prepare(`INSERT INTO conversations (project,id,title,imported_at,modified,messages,source)
    VALUES (?,?,?,?,?,?,'api-development')`);
  const insertVoice = db.prepare(`INSERT INTO conversations (project,id,title,imported_at,modified,messages,source)
    VALUES (?,?,?,?,?,?,'openai-realtime')`);
  const appendVoice = db.prepare(`UPDATE conversations SET imported_at=?,modified=?,messages=?
    WHERE project=? AND id=? AND source='openai-realtime'`);
  const finalizeDevelopment = db.prepare(`UPDATE conversations SET imported_at=?,modified=?,messages=?
    WHERE project=? AND id=? AND source='api-development'`);
  const list = db.prepare(`SELECT id,title,importedAt,source FROM (
    SELECT id,title,imported_at AS importedAt,source FROM conversations
      WHERE project=?1 AND (source<>'chatgpt-export' OR CASE WHEN json_valid(messages) THEN json_array_length(messages)>0 ELSE 0 END)
        AND (?2='' OR instr(lower(title),lower(?2))>0 OR
        CASE WHEN source='chatgpt-export' THEN EXISTS(
          SELECT 1 FROM json_each(CASE WHEN json_valid(messages) THEN messages ELSE '[]' END) AS item
          WHERE CASE WHEN item.type='object' THEN instr(lower(json_extract(item.value,'$.text')),lower(?2))>0 ELSE 0 END
        ) ELSE instr(lower(messages),lower(?2))>0 END)
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
    model,prompt,text,document,status,failure_code AS failureCode,created_at AS createdAt,updated_at AS updatedAt
    FROM live_turns WHERE project=? AND id=?`);
  const addTurn = db.prepare(`INSERT INTO live_turns(project,id,conversation_id,requested_conversation_id,model,prompt,document,text,status,created_at,updated_at,lease_until)
    VALUES(?,?,?,?,?,?,?,'','in_progress',?,?,?)`);
  const activeTurn = db.prepare(`SELECT 1 FROM live_turns WHERE project=? AND conversation_id=? AND status='in_progress'`);
  const activeProject = db.prepare(`SELECT 1 FROM live_turns WHERE project=? AND status='in_progress' AND lease_until>? LIMIT 1`);
  const hasStaleTurns = db.prepare(`SELECT 1 FROM live_turns WHERE project=? AND status='in_progress' AND lease_until<=? LIMIT 1`);
  const staleTurns = db.prepare(`UPDATE live_turns SET status='interrupted',updated_at=?
    WHERE project=? AND status='in_progress' AND lease_until<=?`);
  const saveTurn = db.prepare(`UPDATE live_turns SET status=?,text=?,updated_at=?,failure_code=?
    WHERE project=? AND id=? AND status='in_progress'`);
  const recentTurns = db.prepare(`SELECT prompt,text,
    CASE WHEN json_type(document,'$.image')='object' THEN NULL ELSE document END AS document
    FROM live_turns WHERE project=? AND conversation_id=? AND status='completed' ORDER BY rowid DESC LIMIT 8`);
  const page = db.prepare(`SELECT role,text,
    CASE WHEN json_type(document,'$.image')='object' THEN json_remove(document,'$.image.data') ELSE document END AS document,
    createdAt,status,turnId FROM (
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
    const {requestedConversationId, document: saved, failureCode, ...turn} = row;
    if (turn.status === 'failed' && isLivePreSendFailure(failureCode)) turn.code = failureCode;
    const {document, image} = storedAttachment(saved);
    if (image) return {...turn, image: imageMetadata(image)};
    return document ? {...turn, document: {name: document.name}} : turn;
  }

  function expireTurnLeases(project, time) {
    if (hasStaleTurns.get(project, time)) staleTurns.run(new Date(time).toISOString(), project, time);
  }

  function updateTurn(project, id, status, text, failureCode = null) {
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
      saveTurn.run(status, text, updatedAt, failureCode, project, id);
      touchLive.run(updatedAt, project, row.conversationId);
      return turnView(getTurn.get(project, id));
    });
  }

  return {
    list: (project, query = '') => ({conversations: list.all({1: project, 2: query})}),
    readExportText(project, id, index, sha256, offset) {
      const row = get.get(project,id);
      const text = row?.source === 'chatgpt-export' ? JSON.parse(row.messages)[index]?.text : null;
      if (typeof text !== 'string' || text.length <= exportedTextPartSize) return null;
      if (exportedTextDigest(text) !== sha256) {
        throw storeError(409,'CHAT_EXPORT_CHANGED','会話が更新されました。履歴を読み直してください。');
      }
      if (offset >= text.length || splitsCharacter(text,offset)) {
        throw storeError(400,'CHAT_EXPORT_POSITION_INVALID','原文の位置を確認してください。');
      }
      return exportedTextPart(text,offset);
    },
    read(project, id, offset, {reconcile = true} = {}) {
      const row = get.get(project, id);
      if (row) return archiveView(row, offset);
      const live = getLive.get(project, id);
      if (!live) return null;
      if (reconcile) expireTurnLeases(project, now());
      const {history, ...details} = live;
      const snapshot = JSON.parse(history);
      const messages = snapshot.slice(offset, offset + 41);
      const current = page.all({1: project, 2: id, 3: 41 - messages.length, 4: Math.max(0, offset - snapshot.length)});
      messages.push(...current.map(({document, ...message}) => ({...message, ...storedAttachment(document)})));
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
    readRealtime(project, id) {
      if (typeof id !== 'string' || !realtimeArchiveId.test(id)) return null;
      return readRealtimeArchive(get.get(project, id));
    },
    saveRealtime(project, {id, model, inputTranscript, outputTranscript, startedAt, completedAt, continuation}) {
      const time = isoTime(completedAt);
      if (typeof id !== 'string' || !realtimeReceiptId.test(id) || typeof model !== 'string' || !chatModelPattern.test(model) ||
          ![inputTranscript, outputTranscript].every(value => typeof value === 'string' && value.isWellFormed() && value.length <= 12000) ||
          isoTime(startedAt) > time || (continuation !== undefined && !validRealtimeContinuation(continuation))) {
        throw storeError(400, 'INVALID_REALTIME_VOICE_ARCHIVE', '音声の文字起こしを確認できません。');
      }
      const messages = [{role: 'user', text: inputTranscript, createdAt: startedAt, turnId: id},
        {role: 'assistant', text: outputTranscript, createdAt: completedAt, turnId: id}].filter(message => message.text.trim());
      if (messages.length !== 2) return null;
      const archive = continuation?.id ?? `realtime/${id}`;
      const encoded = entries => JSON.stringify({model, outcome: 'completed', messages: entries});
      return inTransaction(() => {
        const previous = get.get(project, archive);
        if (!previous && !continuation) {
          insertVoice.run(project, archive, title(messages[0].text), completedAt, time, encoded(messages));
          return archive;
        }
        const history = readRealtimeArchive(previous);
        const existing = history?.groups.find(group => group.id === id);
        if (existing && JSON.stringify(existing.messages) === JSON.stringify(messages)) return archive;
        if (!continuation || history?.review !== continuation.review || history.model !== model ||
            isoTime(history.importedAt) > isoTime(startedAt) || history.messages.length + messages.length > 42 || existing) {
          throw storeError(409, 'REALTIME_VOICE_ARCHIVE_CONFLICT', '保存済みの音声履歴を照合できません。');
        }
        appendVoice.run(completedAt, time, encoded([...history.messages, ...messages]), project, archive);
        return archive;
      });
    },
    hasActiveLive: project => Boolean(activeProject.get(project, now())),
    beginLive(project, {id, conversationId = null, model, prompt, document, image}, beforeReserve) {
      if (typeof id !== 'string' || !idPattern.test(id) || typeof model !== 'string' ||
          !chatModelPattern.test(model) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 ||
          (conversationId !== null && (typeof conversationId !== 'string' ||
            (!idPattern.test(conversationId) && !liveIdPattern.test(conversationId)))) ||
          (document !== undefined && (!document || typeof document.name !== 'string' || typeof document.text !== 'string' ||
            prompt.length + documentText(document).length > chatInputLimit))) {
        throw storeError(400, 'INVALID_CHAT_REQUEST', 'チャットの入力が正しくありません。');
      }
      if (document && image !== undefined) throw storeError(400, 'INVALID_CHAT_REQUEST', '添付を1件だけ選んでください。');
      const validated = validatedImage(image);
      const imageRecord = validated && {...validated.image, size: validated.size, sha256: validated.digest};
      // Keep legacy text documents in the existing attachment column and reserve images atomically with their turn.
      const savedAttachment = imageRecord ? JSON.stringify({image: imageRecord}) :
        document ? JSON.stringify({name: document.name, text: document.text}) : null;
      return inTransaction(() => {
        const time = now();
        expireTurnLeases(project, time);
        const previous = getTurn.get(project, id);
        if (previous) {
          if (previous.requestedConversationId !== conversationId || previous.model !== model || previous.prompt !== prompt ||
              previous.document !== savedAttachment) {
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
          {role: 'user', text: row.prompt, document: storedAttachment(row.document).document},
          {role: 'assistant', text: row.text},
        ]);
        const history = boundedHistory([...snapshot, ...recent],
          chatInputLimit - prompt.length - (document ? documentText(document).length : 0));
        const messages = history.map(providerMessage);
        messages.push(providerMessage({role: 'user', text: prompt, document, image: imageRecord}));
        addTurn.run(project, id, liveId, conversationId, model, prompt, savedAttachment, createdAt, createdAt, time + liveLease);
        touchLive.run(createdAt, project, liveId);
        return {turn: turnView(getTurn.get(project, id)), duplicate: false, messages};
      });
    },
    readLive(project, id) {
      expireTurnLeases(project, now());
      return turnView(getTurn.get(project, id));
    },
    readLiveImage(project, conversationId, id) {
      const row = getTurn.get(project, id);
      if (!row || row.conversationId !== conversationId) return null;
      const {image} = storedAttachment(row.document);
      if (!image) return null;
      const {mime, data, sha256, size} = image;
      try {
        const found = validatedImage({mime, data});
        return found.digest === sha256 && found.size === size ? found.image : null;
      } catch {
        return null;
      }
    },
    persistLiveText: (project, id, text) => updateTurn(project, id, 'in_progress', text),
    finishLive(project, id, {status, text, code}) {
      if (!liveStatuses.has(status)) throw storeError(400, 'INVALID_CHAT_STATUS', '応答の状態が正しくありません。');
      if (code !== undefined && (status !== 'failed' || !isLivePreSendFailure(code))) {
        throw storeError(400, 'INVALID_CHAT_STATUS', '応答の状態が正しくありません。');
      }
      return updateTurn(project, id, status, text, code);
    },
    import(project, json) {
      const rows = Array.isArray(json) ? json : json?.conversations;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 3000) return null;
      const conversations = rows.map(officialConversation).filter(Boolean);
      if (!conversations.length) return null;
      return inTransaction(() => {
        const importedAt = new Date(now()).toISOString();
        let imported = 0;
        let unchanged = 0;
        let skipped = rows.length - conversations.length;
        for (const row of conversations) {
          const recover = saved => row.legacy && recoverExport.run(importedAt,saved,project,row.id,
            row.modified,row.title,JSON.stringify(row.legacy)).changes;
          if (!row.messages.length) {
            if (recover('[]')) imported++;
            else skipped++;
            continue;
          }
          // Keep the existing archive array format and distinguish exact text from the
          // pre-upgrade representation when a file with the same version is imported.
          const [first, ...remainder] = row.messages;
          const saved = JSON.stringify([{...first, exportedTextVersion:1}, ...remainder]);
          const result = add.run(project,row.id,row.title,importedAt,row.modified,saved);
          if (result.changes || recover(saved)) imported++;
          else unchanged++;
        }
        return {imported, unchanged, skipped};
      });
    },
    hasProjectHistory: id => Boolean(projectHistory.get(id)),
    withWriteLock: inTransaction,
    close: () => db.close(),
  };
}
