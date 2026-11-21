// SLA texts. Two modes:
//   node scripts/sla-sync.js --from-raw   rebuild data/sla/*.txt from the saved raw pages (data/sla/raw)
//   node scripts/sla-sync.js --check      fetch every page now; if its text differs, the new text replaces the old one
//                                         (old kept in data/sla/history/) so that card's checks stop with TERMS_CHANGED
//                                         until the card is re-checked by hand.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toText } from '../src/slatext.js';
import { fetchRaw } from '../src/archive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.MONEYOWED_DATA || path.join(ROOT, 'data'), 'sla');
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'cards', '_sources.json'), 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mode = process.argv[2];

async function latestArchive(url) {
  const r = JSON.parse(await fetchRaw(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`));
  const c = r.archived_snapshots && r.archived_snapshots.closest;
  if (!c) throw new Error('no archive copy');
  return `http://web.archive.org/web/${c.timestamp}id_/${url}`;
}

let changed = 0, failed = 0;
for (const [file, src] of Object.entries(sources)) {
  if (file.startsWith('_')) continue;
  const out = path.join(DATA, file);
  try {
    let raw;
    if (mode === '--from-raw') {
      const base = file.replace(/\.txt$/, '');
      const rp = path.join(DATA, 'raw', `${base}.${src.kind === 'docx' ? 'docx' : 'html'}`);
      raw = fs.readFileSync(rp);
    } else if (mode === '--check') {
      const headers = { 'user-agent': 'Mozilla/5.0 (compatible; moneyowed SLA watch)' };
      if (src.via === 'archive') raw = await fetchRaw(await latestArchive(src.url), { headers });
      else {
        try { raw = await fetchRaw(src.url, { headers }); }
        catch (e) { console.log(`note     ${file}: live page failed (${e.message}); reading the archive copy`); raw = await fetchRaw(await latestArchive(src.url), { headers }); }
      }
    } else { console.error('usage: --from-raw | --check'); process.exit(2); }
    const text = toText(raw, src.kind);
    if (text.length < 2000) throw new Error(`extracted text too short (${text.length} chars): page may have changed format`);
    const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (prev === text) { console.log(`same     ${file} ${sha(text).slice(0, 12)}`); continue; }
    if (prev !== null && mode === '--check') {
      fs.mkdirSync(path.join(DATA, 'history'), { recursive: true });
      fs.writeFileSync(path.join(DATA, 'history', `${file}.${new Date().toISOString().slice(0, 10)}.${sha(prev).slice(0, 8)}`), prev);
    }
    fs.writeFileSync(out, text);
    changed++;
    console.log(`${prev === null ? 'new     ' : 'CHANGED '} ${file} ${sha(text).slice(0, 12)} (${text.length} chars)`);
  } catch (e) { failed++; console.log(`FAILED   ${file}: ${e.message}`); }
}
console.log(`${changed} changed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
