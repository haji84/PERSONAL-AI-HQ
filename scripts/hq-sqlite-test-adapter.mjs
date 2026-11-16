// ISOLATED TEST ADAPTER ONLY. Not a remote authority or cross-Actions store.
// Reuses the production authority SQL, with SQLite transactions across OS processes.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

const schema = new URL('../workers/state-authority/schema.sql', import.meta.url);

export function openSqliteTestAuthority(file, {initialize = false} = {}) {
  if (typeof file !== 'string' || !file) throw new Error('SQLite test file required');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
    if (initialize) db.exec(readFileSync(schema, 'utf8'));
  } catch (error) {
    db.close();
    throw error;
  }
  const wrap = (sql, args = []) => ({
    sql, args,
    bind(...params) { return wrap(sql, params); },
    async first() { return db.prepare(sql).get(...args) ?? null; }
  });
  const authority = {
    prepare(sql) { return wrap(sql); },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({sql, args}) => {
          const stmt = db.prepare(sql);
          if (/^\s*SELECT\b/i.test(sql)) return {results: stmt.all(...args)};
          stmt.run(...args);
          return {results: []};
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return {authority, close: () => db.close()};
}
