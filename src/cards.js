// Rule cards: one per vendor, hand-written from the vendor's SLA text. Plain code reads them; nothing here is guessed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CARD_DIR = path.join(ROOT, 'cards');

export function loadCard(vendor) {
  const f = path.join(CARD_DIR, `${vendor}.json`);
  if (!fs.existsSync(f)) throw Object.assign(new Error(`no rule card for ${vendor}`), { code: 'VENDOR_NOT_COVERED' });
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function listCards() {
  return fs.readdirSync(CARD_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => loadCard(f.replace(/\.json$/, '')));
}

export function getPlan(card, planId) {
  const p = card.plans.find((x) => x.plan === planId);
  if (!p) throw Object.assign(new Error(`${card.name} has no SLA for plan "${planId}". Plans with an SLA: ${card.plans.map((x) => x.plan).join(', ')}`), { code: 'PLAN_NOT_COVERED' });
  return p;
}

function hasNumber(quote, n) {
  if (!quote) return false;
  const [int, frac = ''] = String(n).split('.');
  const f = frac.replace(/0+$/, '');
  const body = f ? `${int}\\.${f}0*` : `${int}(?:\\.0+)?`;
  if (new RegExp(`(^|[^0-9.])${body}\\s?%`).test(quote)) return true;
  if (new RegExp(`(^|[^0-9.])${body}(?![0-9.])`).test(quote) && !Number.isInteger(n)) return true;
  const words = { 2: ['two', 'second'], 5: ['five'], 15: ['fifteen'], 30: ['thirty', '30'], 60: ['sixty', '60'] };
  return (words[n] || []).some((w) => new RegExp(`\\b${w}\\b`, 'i').test(quote));
}

// Second-pass check: every number on a card must appear in the quote given for it, every quote must appear in the
// SLA text it came from, and the SLA text must still have the hash recorded on the card.
export function checkCard(card, slaDir, { withWarnings = false } = {}) {
  const problems = [];
  const warnings = [];
  const texts = {};
  for (const t of card.sla_texts) {
    const f = path.join(slaDir, t.file);
    if (!fs.existsSync(f)) { problems.push(`SLA text missing: ${t.file}`); continue; }
    const buf = fs.readFileSync(f);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== t.sha256) warnings.push(`${t.file}: page text changed since the card was checked (hash ${sha.slice(0, 12)}, card ${t.sha256.slice(0, 12)}); every quoted term is re-checked below`);
    texts[t.file] = buf.toString('utf8');
  }
  const all = Object.values(texts).join('\n');
  const inText = (q) => q && all.includes(q);
  for (const p of card.plans) {
    const c = p.claim || {};
    if (!c.deadline_unstated) {
      if (!inText(c.quote)) problems.push(`${p.plan}: claim quote not found in SLA text`);
      const n = c.days_after_period_end ?? c.days_after_eligible ?? c.days_after_breach ?? c.days_after_incident ?? c.billing_cycles_after_period;
      if (n === undefined) problems.push(`${p.plan}: no claim deadline rule`);
      else if (!hasNumber(c.quote, n)) problems.push(`${p.plan}: claim deadline ${n} not in its quote`);
    }
    if (p.cap && !(inText(p.cap.quote) && hasNumber(p.cap.quote, p.cap.pct_of_fee))) problems.push(`${p.plan}: cap ${p.cap.pct_of_fee}% not backed by its quote`);
    for (const s of p.services) {
      const tag = `${p.plan}/${s.service}`;
      if (!inText(s.threshold_quote)) problems.push(`${tag}: threshold quote not in SLA text`);
      else if (!hasNumber(s.threshold_quote, s.threshold_pct)) problems.push(`${tag}: threshold ${s.threshold_pct}% not in its quote`);
      if (s.tiers) {
        if (!inText(s.tiers_quote)) problems.push(`${tag}: tiers quote not in SLA text`);
        else {
          for (const t of s.tiers) {
            if (!hasNumber(s.tiers_quote, t.credit_pct)) problems.push(`${tag}: credit ${t.credit_pct}% not in tiers quote`);
            if (t.from_pct > 0 && !hasNumber(s.tiers_quote, t.from_pct) && !(s.tiers_note || '').includes(String(t.from_pct))) problems.push(`${tag}: tier boundary ${t.from_pct}% not in tiers quote`);
          }
        }
        const sorted = [...s.tiers].sort((a, b) => b.below_pct - a.below_pct);
        if (sorted[0].below_pct !== s.threshold_pct) problems.push(`${tag}: top tier ends at ${sorted[0].below_pct}, threshold is ${s.threshold_pct}`);
        for (let i = 1; i < sorted.length; i++) if (sorted[i].below_pct !== sorted[i - 1].from_pct) problems.push(`${tag}: tiers leave a gap at ${sorted[i].below_pct}-${sorted[i - 1].from_pct}`);
        if (sorted[sorted.length - 1].from_pct !== 0) problems.push(`${tag}: lowest tier does not reach 0%`);
      } else if (s.credit_formula) {
        if (!inText(s.credit_quote)) problems.push(`${tag}: credit formula quote not in SLA text`);
      } else problems.push(`${tag}: no tiers and no credit formula`);
      if (!s.match || !Object.keys(s.match).length) problems.push(`${tag}: no scope match`);
      if (s.scope_quote !== undefined && s.scope_quote !== null && !inText(s.scope_quote)) problems.push(`${tag}: scope quote not in SLA text`);
    }
  }
  return withWarnings ? { problems, warnings } : problems;
}
