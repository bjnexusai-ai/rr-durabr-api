// Test helper: behaves like a Cloudflare D1 binding (async prepare/bind/run/first/all/batch) on top of node:sqlite,
// with the real migrations applied. Needs Node 22.5 or newer. On older Node the tests skip themselves.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function makeD1(migDir = new URL('../migrations/', import.meta.url)) {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) raw.exec(readFileSync(new URL(f, migDir), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    _run() { const r = raw.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    async run() { return this._run(); },
    async first() { const r = raw.prepare(sql).get(...args); return r ? { ...r } : null; },
    async all() { return { success: true, results: raw.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
  });
  return {
    raw,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      raw.exec('BEGIN');
      try { const out = list.map((s) => s._run()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}
export const hasSqlite = true;
