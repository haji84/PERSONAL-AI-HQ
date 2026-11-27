import {chmodSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

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

export function createChatStore(directory) {
  const file = join(directory, 'conversations.sqlite');
  try {
    if (!lstatSync(file).isFile()) throw new Error('Invalid conversation store');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS conversations (
      project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
      imported_at TEXT NOT NULL, modified REAL NOT NULL, messages TEXT NOT NULL,
      PRIMARY KEY(project,id)
    )`);
  const add = db.prepare(`INSERT INTO conversations (project,id,title,imported_at,modified,messages)
    VALUES (?,?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET title=excluded.title,
      imported_at=excluded.imported_at, modified=excluded.modified, messages=excluded.messages
    WHERE excluded.modified > conversations.modified`);
  const list = db.prepare(`SELECT id,title,imported_at AS importedAt FROM conversations
    WHERE project=? AND (?='' OR instr(lower(title),lower(?))>0 OR instr(lower(messages),lower(?))>0)
    ORDER BY imported_at DESC, id LIMIT 250`);
  const get = db.prepare(`SELECT id,title,imported_at AS importedAt,messages FROM conversations WHERE project=? AND id=?`);
  return {
    list: (project, query) => ({conversations: list.all(project, query, query, query).map(row => ({...row,
      source: 'chatgpt-export'}))}),
    read(project, id, offset) {
      const row = get.get(project, id);
      if (!row) return null;
      const messages = JSON.parse(row.messages);
      return {conversation: {...row, source: 'chatgpt-export', messages: messages.slice(offset, offset + 40)},
        nextOffset: offset + 40 < messages.length ? offset + 40 : null};
    },
    import(project, json) {
      const rows = Array.isArray(json) ? json : json?.conversations;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 3000) return null;
      const conversations = rows.map(officialConversation).filter(Boolean);
      if (!conversations.length) return null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const now = new Date().toISOString();
        for (const row of conversations) add.run(project, row.id, row.title, now, row.modified, JSON.stringify(row.messages));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return {imported: conversations.length, skipped: rows.length - conversations.length};
    },
    close: () => db.close(),
  };
}
