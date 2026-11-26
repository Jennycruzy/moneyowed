// Local database (node:sqlite). Checks, purchases, claims and their outcomes.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const questionHash = (q) => crypto.createHash('sha256').update(JSON.stringify(q)).digest('hex');

export function openDb(file = path.resolve(process.env.MONEYOWED_DATA || 'data', 'moneyowed.sqlite')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // The web app and the bot open the same file; wait for a lock instead of failing when both start at once.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, created_at TEXT, vendor TEXT, plan TEXT, period TEXT, regions TEXT, code TEXT, credit_usd REAL, result TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, check_id TEXT, bucket TEXT, intent TEXT, route TEXT, miner_id TEXT, miner_name TEXT, status INTEGER, paid INTEGER, cost_usd REAL, latency_ms INTEGER, answer_sha256 TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS claims (check_id TEXT PRIMARY KEY, created_at TEXT, status TEXT, sent_at TEXT, outcome_at TEXT, outcome_note TEXT, credited_usd REAL);
    CREATE INDEX IF NOT EXISTS purchases_day ON purchases (at);
    CREATE TABLE IF NOT EXISTS miner_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, service TEXT, period TEXT, status INTEGER, code TEXT, uptime_pct REAL, from_telegraph INTEGER, ms INTEGER);
  `);
  return {
    db,
    newId: () => crypto.randomBytes(6).toString('base64url'),
    saveCheck(id, input, result, source = 'web') {
      db.prepare('INSERT INTO checks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, new Date().toISOString(), result.vendor, result.plan, result.period, JSON.stringify(result.regions || []), result.code, result.credit_usd_total, JSON.stringify(result), source);
    },
    getCheck(id) {
      const r = db.prepare('SELECT * FROM checks WHERE id = ?').get(id);
      return r ? { ...r, result: JSON.parse(r.result) } : null;
    },
    record(p) {
      db.prepare('INSERT INTO purchases (at, check_id, bucket, intent, route, miner_id, miner_name, status, paid, cost_usd, latency_ms, answer_sha256, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(p.at, p.check_id, p.bucket, p.intent, p.route, String(p.miner_id ?? ''), p.miner_name, p.status, p.paid ? 1 : 0, p.cost_usd, p.latency_ms, p.answer_sha256, JSON.stringify(p));
    },
    spentToday(bucket) {
      const day = new Date().toISOString().slice(0, 10);
      const r = bucket ? db.prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM purchases WHERE at >= ? AND bucket = ?').get(day, bucket) : db.prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM purchases WHERE at >= ?').get(day);
      return r.s;
    },
    purchasesFor(checkId) { return db.prepare('SELECT data FROM purchases WHERE check_id = ? ORDER BY id').all(checkId).map((r) => JSON.parse(r.data)); },
    // A paid answer to the identical question from the same route/miner within maxAgeMs, if any.
    recentAnswer(question, minerId, maxAgeMs = 3600000) {
      const since = new Date(Date.now() - maxAgeMs).toISOString();
      for (const r of db.prepare("SELECT data FROM purchases WHERE at >= ? AND paid = 1 ORDER BY id DESC").all(since)) {
        const p = JSON.parse(r.data);
        if (p.question_sha256 === questionHash(question) && String(p.requested_miner ?? '') === String(minerId ?? '')) return p;
      }
      return null;
    },
    allPurchases(limit = 500) { return db.prepare('SELECT data FROM purchases ORDER BY id DESC LIMIT ?').all(limit).map((r) => JSON.parse(r.data)); },
    setClaim(checkId, status, fields = {}) {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO claims (check_id, created_at, status) VALUES (?,?,?) ON CONFLICT(check_id) DO UPDATE SET status = excluded.status`).run(checkId, now, status);
      if (status === 'sent') db.prepare('UPDATE claims SET sent_at = ? WHERE check_id = ?').run(now, checkId);
      if (status === 'credited' || status === 'refused') db.prepare('UPDATE claims SET outcome_at = ?, outcome_note = ?, credited_usd = ? WHERE check_id = ?').run(now, fields.note || null, fields.credited_usd ?? null, checkId);
    },
    minerCall(c) { db.prepare('INSERT INTO miner_calls (at, service, period, status, code, uptime_pct, from_telegraph, ms) VALUES (?,?,?,?,?,?,?,?)').run(new Date().toISOString(), String(c.service ?? '').slice(0, 200), String(c.period ?? '').slice(0, 100), c.status, c.code || null, c.uptime_pct ?? null, c.from_telegraph ? 1 : 0, c.ms); },
    minerStats() { return db.prepare('SELECT COUNT(*) n, SUM(status = 200) ok, SUM(from_telegraph) via_telegraph, MAX(at) last FROM miner_calls').get(); },
    getClaim(checkId) { return db.prepare('SELECT * FROM claims WHERE check_id = ?').get(checkId) || null; },
  };
}
