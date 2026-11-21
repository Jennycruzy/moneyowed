// Proof files: everything needed to recompute a check offline, and the code that recomputes it.
// A proof holds the rule card, the SLA texts it quotes, and the vendor's own incident records exactly as archived
// (status-page vendors), so `moneyowed verify` needs no network and no trust in this server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Archive } from './archive.js';
import { VENDORS } from './vendors.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dataDir = () => path.resolve(process.env.MONEYOWED_DATA || 'data');
const cardDir = () => process.env.MONEYOWED_CARDS || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'cards');

function archiveBySha() {
  const a = new Archive();
  const m = new Map();
  if (!fs.existsSync(a.indexFile)) return { a, m };
  for (const l of fs.readFileSync(a.indexFile, 'utf8').split('\n')) { if (l) { const r = JSON.parse(l); m.set(r.sha256, r); } }
  return { a, m };
}

// The fields a verifier must get back exactly.
export function summary(r) {
  return {
    code: r.code, vendor: r.vendor, plan: r.plan, period: r.period, regions: r.regions || [], mode: r.mode,
    deadline: r.deadline ? new Date(r.deadline).toISOString() : null,
    services: r.services.map((s) => ({ service: s.service, uptime_pct: s.uptime_pct, covered_minutes: s.covered_minutes, credit_pct: s.credit_pct, counted: s.incidents.filter((i) => i.in_scope).map((i) => i.id).sort() })),
  };
}

export function buildProof(input, result) {
  const card = JSON.parse(fs.readFileSync(path.join(cardDir(), `${result.vendor}.json`), 'utf8'));
  const sla_texts = card.sla_texts.map((t) => ({ file: t.file, text: fs.readFileSync(path.join(dataDir(), 'sla', t.file), 'utf8') }));
  const v = VENDORS.find((x) => x.vendor === result.vendor);
  const { a, m } = archiveBySha();
  const ids = new Set(result.services.flatMap((s) => s.incidents.map((i) => i.sha256)).filter(Boolean));
  let raw = null, normalized = null;
  if (v.source === 'statuspage') {
    raw = [];
    for (const h of ids) { const rec = m.get(h); if (rec) raw.push({ name: rec.name, url: rec.url || null, sha256: h, fetched_at: rec.fetched_at, base64: a.read(rec).toString('base64') }); }
    const comp = [...m.values()].filter((r) => r.vendor === v.vendor && r.name === 'components.json').sort((x, y) => (x.fetched_at < y.fetched_at ? 1 : -1))[0];
    if (comp) raw.push({ name: 'components.json', url: comp.url || null, sha256: comp.sha256, fetched_at: comp.fetched_at, base64: a.read(comp).toString('base64') });
  } else {
    // Cloud history files are tens of MB; the proof carries the parsed incidents in the period plus the raw file's hash.
    const store = JSON.parse(fs.readFileSync(path.join(dataDir(), 'incidents', `${v.vendor}.json`), 'utf8'));
    const keep = new Set(result.services.flatMap((s) => s.incidents.map((i) => i.id)));
    normalized = { source: store.source, coverage_from: store.coverage_from || null, raw_sha256: [...new Set(store.incidents.map((i) => i.sha256).filter(Boolean))], incidents: store.incidents.filter((i) => keep.has(i.id)) };
  }
  const body = {
    kind: 'moneyowed-proof', version: 1, created_at: new Date().toISOString(),
    input: { vendor: result.vendor, plan: result.plan, period: result.period, regions: result.regions || [], mode: result.mode, spend: input.spend ?? null, now: new Date(result.computed_at).toISOString() },
    stated: summary(result), method_version: result.method_version,
    card, sla_texts, source: v.source, host: v.host || null, coverage_from: result.history?.coverage_from || null, raw, normalized,
  };
  return { ...body, proof_sha256: sha(JSON.stringify(body)) };
}

// Recompute a proof offline. Returns { ok, checks: [{ name, ok, detail }] }.
export async function verifyProof(proof) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const { proof_sha256, ...body } = proof;
  add('proof file unchanged since it was made', sha(JSON.stringify(body)) === proof_sha256, proof_sha256?.slice(0, 16));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyowed-verify-'));
  fs.mkdirSync(path.join(tmp, 'sla'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'incidents'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'cards'), { recursive: true });
  for (const t of proof.sla_texts) fs.writeFileSync(path.join(tmp, 'sla', t.file), t.text);
  for (const t of proof.card.sla_texts) {
    const got = proof.sla_texts.find((x) => x.file === t.file);
    add(`SLA text ${t.file} matches the hash on the rule card`, got && sha(got.text) === t.sha256, t.sha256.slice(0, 16));
  }
  fs.writeFileSync(path.join(tmp, 'cards', `${proof.card.vendor}.json`), JSON.stringify(proof.card));
  const prev = { data: process.env.MONEYOWED_DATA, cards: process.env.MONEYOWED_CARDS };
  process.env.MONEYOWED_DATA = tmp; process.env.MONEYOWED_CARDS = path.join(tmp, 'cards');
  try {
    let incidents, components = null;
    if (proof.source === 'statuspage') {
      const { normalizeStatuspageIncident } = await import('./sources/statuspage.js');
      let bad = 0;
      incidents = [];
      for (const r of proof.raw) {
        const buf = Buffer.from(r.base64, 'base64');
        if (sha(buf) !== r.sha256) bad++;
        const d = JSON.parse(buf.toString('utf8'));
        if (r.name === 'components.json') components = d.components.map((c) => ({ id: c.id, name: c.name, group: Boolean(c.group), group_id: c.group_id || null }));
        else incidents.push(normalizeStatuspageIncident(proof.card.vendor, d.incident || d, r.sha256, proof.host));
      }
      add(`${proof.raw.length} vendor records match their archived sha256`, bad === 0, bad ? `${bad} changed` : '');
    } else {
      incidents = proof.normalized.incidents;
      add('cloud incidents carried as parsed records (raw history file hash listed, not embedded)', true, proof.normalized.raw_sha256.map((h) => h.slice(0, 12)).join(', '));
    }
    const { writeIncidents } = await import('./store.js');
    writeIncidents(proof.card.vendor, { source: proof.source, coverage_from: proof.coverage_from, components, incidents });
    const { checkCredit } = await import('./engine.js');
    const { input } = proof;
    const r = checkCredit({ vendor: input.vendor, plan: input.plan, period: input.period, regions: input.regions.length ? input.regions : undefined, mode: input.mode, spend: input.spend ?? undefined, now: input.now }, { slaDir: path.join(tmp, 'sla') });
    const got = summary(r), want = proof.stated;
    add('verdict', got.code === want.code, `${got.code} (stated ${want.code})`);
    add('claim deadline', got.deadline === want.deadline, `${got.deadline || 'none'}`);
    for (const w of want.services) {
      const g = got.services.find((x) => x.service === w.service);
      add(`${w.service}: uptime`, g && g.uptime_pct === w.uptime_pct, g ? `${g.uptime_pct}% (stated ${w.uptime_pct}%)` : 'missing');
      add(`${w.service}: outage minutes counted`, g && g.covered_minutes === w.covered_minutes, g ? `${g.covered_minutes} (stated ${w.covered_minutes})` : '');
      add(`${w.service}: credit`, g && g.credit_pct === w.credit_pct, g ? `${g.credit_pct}% (stated ${w.credit_pct}%)` : '');
      add(`${w.service}: same incidents counted`, g && JSON.stringify(g.counted) === JSON.stringify(w.counted), g ? `${g.counted.length} incidents` : '');
    }
  } catch (e) {
    add('recompute', false, e.message);
  } finally {
    process.env.MONEYOWED_DATA = prev.data ?? ''; if (prev.data === undefined) delete process.env.MONEYOWED_DATA;
    process.env.MONEYOWED_CARDS = prev.cards ?? ''; if (prev.cards === undefined) delete process.env.MONEYOWED_CARDS;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
