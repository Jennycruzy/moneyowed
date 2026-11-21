// Raw source archive. Every fetched file is stored as fetched, with its sha256 and fetch time,
// so any number the app shows can be recomputed from the same bytes later.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Archive {
  constructor(root = process.env.MONEYOWED_DATA || 'data') {
    this.root = path.resolve(root, 'archive');
    fs.mkdirSync(this.root, { recursive: true });
    this.indexFile = path.join(this.root, 'index.jsonl');
  }

  save(vendor, name, bytes, meta = {}) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const fetchedAt = new Date().toISOString();
    const day = fetchedAt.slice(0, 10);
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
    const dir = path.join(this.root, vendor, day);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe}.${sha256.slice(0, 12)}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    const rec = { vendor, name, sha256, fetched_at: fetchedAt, bytes: buf.length, path: path.relative(this.root, file), ...meta };
    fs.appendFileSync(this.indexFile, JSON.stringify(rec) + '\n');
    return rec;
  }

  read(rec) {
    const buf = fs.readFileSync(path.join(this.root, rec.path));
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== rec.sha256) throw new Error(`archive file changed on disk: ${rec.path}`);
    return buf;
  }

  // One line per file archived that UTC day: "<sha256>  <vendor>/<name>". The list's own hash is what gets published.
  dailyHashList(day) {
    if (!fs.existsSync(this.indexFile)) return { day, lines: [], sha256: null };
    const lines = fs.readFileSync(this.indexFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.fetched_at.startsWith(day))
      .map((r) => `${r.sha256}  ${r.vendor}/${r.name}`);
    const uniq = [...new Set(lines)].sort();
    const body = uniq.join('\n') + (uniq.length ? '\n' : '');
    return { day, lines: uniq, sha256: crypto.createHash('sha256').update(body).digest('hex'), body };
  }
}

export async function fetchRaw(url, { tries = 3, timeoutMs = 30000, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'moneyowed/0.1 (+status history reader)', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw lastErr;
}
