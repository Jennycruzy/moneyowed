// MONEY OWED watch: a monthly check of the vendors you pay, made to run inside an agent's scheduler (OpenClaw, Hermes, cron).
// It says something only when money is owed, when a promise is already missed in the period still running,
// or when the terms a vendor's SLA gives you have changed. Otherwise it prints the scheduler's silent token.
// Telegraph answers are bought only with your own key, and never past the budget you set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_API = 'https://moneyowed.38-49-216-59.sslip.io';
export const DEFAULTS = { budget_usd_per_run: 0.05, budget_usd_per_month: 0.2, own_miner_id: '2611217', remind_days: 5 };

export function home() { return process.env.MONEYOWED_HOME || path.join(os.homedir(), '.moneyowed'); }
const files = (dir = home()) => ({ dir, config: path.join(dir, 'watch.json'), state: path.join(dir, 'watch-state.json') });

// The Telegraph key can live in <home>/.env (chmod 600) so it never sits in a scheduler's job definition.
export function keyFromHome(dir = home()) {
  const f = path.join(dir, '.env');
  if (!fs.existsSync(f)) return null;
  const m = /^\s*TELEGRAPH_PRIVATE_KEY\s*=\s*"?([^"\s]+)"?\s*$/m.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1] : null;
}

export function loadConfig(dir) {
  const f = files(dir);
  if (!fs.existsSync(f.config)) return { vendors: [], ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f.config, 'utf8')) };
}
export function saveConfig(cfg, dir) { const f = files(dir); fs.mkdirSync(f.dir, { recursive: true }); fs.writeFileSync(f.config, JSON.stringify(cfg, null, 2) + '\n'); }
export function loadState(dir) {
  const f = files(dir);
  const empty = { baseline: {}, notified: {}, spend: {}, runs: [] };
  if (!fs.existsSync(f.state)) return empty;
  return { ...empty, ...JSON.parse(fs.readFileSync(f.state, 'utf8')) };
}
export function saveState(st, dir) { const f = files(dir); fs.mkdirSync(f.dir, { recursive: true }); fs.writeFileSync(f.state, JSON.stringify(st, null, 2) + '\n'); }

export const entryKey = (e) => `${e.vendor}|${e.plan || ''}|${(e.regions || []).join(',')}`;
export const entryLabel = (e) => [e.vendor, e.plan, (e.regions || []).join(',')].filter(Boolean).join(' ');

// ---------- periods (UTC): the running one and the two before it
export function periods(kind, now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (kind === 'quarter') {
    const q = Math.floor(m / 3);
    const at = (k) => { const t = y * 4 + q - k; return `${Math.floor(t / 4)}-Q${(t % 4) + 1}`; };
    return { open: at(0), closed: [at(1), at(2)] };
  }
  const at = (k) => { const d = new Date(Date.UTC(y, m - k, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  return { open: at(0), closed: [at(1), at(2)] };
}

// ---------- terms: what the SLA gives you (numbers, tiers, claim rules), without the quoted wording
function flatten(v, pre = '', out = {}) {
  if (Array.isArray(v)) v.forEach((x, i) => flatten(x, `${pre}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!/quote|label|note/i.test(k)) flatten(x, pre ? `${pre}.${k}` : k, out); }
  else out[pre] = v;
  return out;
}
export function termsOf(card, plan) {
  const plans = (card.plans || []).filter((p) => !plan || p.plan === plan);
  return flatten(Object.fromEntries(plans.map((p) => [p.plan, p])));
}
export const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
export function diffTerms(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => ({ field: k, before: before[k] ?? null, after: after[k] ?? null }));
}

// ---------- Telegraph spending, capped per run and per calendar month
export class Budget {
  constructor({ perRun, perMonth, spentThisMonth = 0 }) { this.perRun = perRun; this.perMonth = perMonth; this.month = spentThisMonth; this.run = 0; this.purchases = []; }
  spentToday(bucket) { return bucket ? this.run : this.month + this.run; } // Telegraph class: bucket limit = per run, global = per month
  record(p) { this.purchases.push(p); this.run += p.cost_usd || 0; }
}

const fmtDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

function owedLines(r, api) {
  const s = r.services.filter((x) => x.credit_pct > 0);
  const amount = r.credit_usd_total != null ? `${money(r.credit_usd_total)}` : `a ${s.map((x) => x.credit_pct).join('/')}% credit (add your bill with --spend to see dollars)`;
  const out = [`${r.vendor_name} owes you ${amount} for ${r.period} (${r.plan_label}).`];
  for (const x of s) out.push(`  ${x.service}: ${x.uptime_pct}% uptime against ${x.threshold_pct}% promised, ${x.covered_minutes} min of counted outage.`);
  if (r.last_day_later && r.last_day && r.last_day !== r.last_day_later) out.push(`  Last day to claim: ${fmtDay(r.last_day)} counting from the outage, ${fmtDay(r.last_day_later)} counting from the end of the period${r.days_left != null ? ` (${r.days_left} days left)` : ''}.`);
  else if (r.last_day) out.push(`  Last day to claim: ${fmtDay(r.last_day)}${r.days_left != null ? ` (${r.days_left} days left)` : ''}.`);
  out.push(`  Claim email: moneyowed claim ${r.id}   Proof: ${api}/check/${r.id}/proof.json`);
  return out;
}

function telegraphLine(ev) {
  if (!ev) return null;
  const all = [...(ev.sla?.opinions || []), ...(ev.terms?.opinions || [])];
  const bought = all.filter((o) => o.cost_usd > 0);
  const cost = bought.reduce((t, o) => t + o.cost_usd, 0);
  const sla = (ev.sla?.opinions || []).filter((o) => o.agrees !== undefined && o.cost_usd > 0);
  const agree = sla.filter((o) => o.agrees === true).length, disagree = sla.filter((o) => o.agrees === false).length;
  const terms = (ev.terms?.opinions || []).filter((o) => o.cost_usd > 0);
  const termsOk = terms.filter((o) => o.agrees === true).length;
  const limit = all.some((o) => o.code === 'LIMIT_REACHED');
  if (!bought.length) return `  Telegraph: nothing bought${limit ? ' (budget reached)' : ''}.`;
  const parts = [`${bought.length} answers bought for ${money(cost)}`];
  const own = bought.some((o) => /^our /.test(o.label || ''));
  if (sla.length) parts.push(`${agree} of ${sla.length} SLA answers agree it was missed${disagree ? `, ${disagree} disagree (see the page)` : ''}`);
  if (terms.length) parts.push(`${termsOk} of ${terms.length} contract answers give the same claim window and address`);
  return `  Telegraph: ${parts.join('; ')}${own ? ' (one seller is MONEY OWED\'s own miner)' : ''}${limit ? '; budget reached, stopped buying' : ''}.`;
}

// One run. io = { getJson(path), postJson(path, body), telegraph (optional, a Telegraph instance), buy (optional) }
export async function runWatch(cfg, state, io, { now = new Date(), api = DEFAULT_API } = {}) {
  const messages = []; const notes = []; const failed = [];
  const first = Object.keys(state.baseline).length === 0;
  const monthKey = now.toISOString().slice(0, 7);
  const budget = new Budget({ perRun: cfg.budget_usd_per_run, perMonth: cfg.budget_usd_per_month, spentThisMonth: state.spend[monthKey] || 0 });
  const cardCache = {};
  for (const e of cfg.vendors) {
    const key = entryKey(e);
    let card;
    try { card = cardCache[e.vendor] ||= await io.getJson(`/api/cards/${encodeURIComponent(e.vendor)}`); }
    catch (err) { failed.push(`${e.vendor} (${err.message})`); continue; }
    const plan = (card.plans || []).find((p) => !e.plan || p.plan === e.plan) || card.plans[0];
    const label = plan?.label || card.name;
    // 1. terms
    const terms = termsOf(card, plan?.plan);
    const textShas = (card.sla_texts || []).map((t) => t.sha256);
    const base = state.baseline[key];
    if (!base) state.baseline[key] = { terms, terms_sha: sha(terms), text_shas: textShas, since: now.toISOString() };
    else {
      const d = diffTerms(base.terms || {}, terms);
      if (d.length) {
        messages.push([`${label}: the terms of the SLA changed (${card.sla_url}).`, ...d.slice(0, 6).map((x) => `  ${x.field}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`), ...(d.length > 6 ? [`  and ${d.length - 6} more`] : [])].join('\n'));
      } else if (JSON.stringify(base.text_shas) !== JSON.stringify(textShas)) {
        notes.push(`${label}: SLA wording changed, the terms you get are the same`);
      }
      state.baseline[key] = { terms, terms_sha: sha(terms), text_shas: textShas, since: d.length ? now.toISOString() : base.since };
    }
    // 2. credits: the two closed periods (claim windows can still be open), and the one still running
    const per = periods(plan?.period === 'quarter' ? 'quarter' : 'month', now);
    for (const period of [...per.closed, per.open]) {
      let r;
      try { r = await io.postJson('/api/check', { vendor: e.vendor, plan: plan?.plan, period, spend: e.spend, regions: (e.regions || []).join(',') || undefined, evidence: 'none' }); }
      catch (err) { failed.push(`${label} ${period} (${err.message})`); continue; }
      const nk = `${key}|${period}`;
      const seen = state.notified[nk];
      if (r.code === 'OWED') {
        const remind = seen && !seen.reminded && r.days_left != null && r.days_left <= cfg.remind_days;
        if (seen && seen.code === 'OWED' && !remind) continue;
        const lines = owedLines(r, api);
        if (remind) lines[0] = `Reminder: ${lines[0]}`;
        if (!seen && io.buy) {
          const ev = await io.buy(r, budget);
          const t = telegraphLine(ev);
          if (t) lines.push(t);
        }
        messages.push(lines.join('\n'));
        // a first message that already falls inside the reminder window counts as the reminder
        const closeNow = r.days_left != null && r.days_left <= cfg.remind_days;
        state.notified[nk] = { code: 'OWED', id: r.id, at: seen?.at || now.toISOString(), reminded: Boolean(remind || seen?.reminded || closeNow), credit_usd: r.credit_usd_total };
      } else if (r.code === 'PERIOD_OPEN' && r.owed_services?.length) {
        if (seen) continue;
        const s = r.services.filter((x) => x.credit_pct > 0);
        messages.push([`${label}: the promise for ${period} is already missed, and the period is still running.`, ...s.map((x) => `  ${x.service}: ${x.covered_minutes} min of counted outage so far, ${x.allowed_minutes} allowed for the whole period${x.credit_usd != null ? `; ${money(x.credit_usd)} owed at today's count` : ''}.`), `  I will tell you the final amount and the last day to claim once ${period} ends.`].join('\n'));
        state.notified[nk] = { code: 'PERIOD_OPEN', id: r.id, at: now.toISOString() };
      }
    }
  }
  state.spend[monthKey] = Math.round(((state.spend[monthKey] || 0) + budget.run) * 1e6) / 1e6;
  // a check that failed is never silent: the user hears which ones, and they are tried again next run
  if (failed.length) messages.push(`Could not check ${failed.length === 1 ? 'this one' : `these ${failed.length}`} today, will try again next run:\n${failed.map((f) => `  ${f}`).join('\n')}`);
  state.runs = [...(state.runs || []), { at: now.toISOString(), messages: messages.length, notes, failed, spent_usd: budget.run, purchases: budget.purchases.map((p) => ({ intent: p.intent, miner_id: p.miner_id, cost_usd: p.cost_usd, status: p.status, answer_sha256: p.answer_sha256 })) }].slice(-24);
  let text = messages.join('\n\n');
  if (first) {
    const names = cfg.vendors.map((e) => e.vendor).join(', ');
    text = [`MONEY OWED is now watching: ${names}. I will message you only when a credit is owed, a promise is already missed this period, or your SLA terms change.`, text].filter(Boolean).join('\n\n');
  }
  return { text, messages, notes, spent_usd: budget.run, first };
}

// Telegraph evidence for a newly owed credit: SLA second opinions + the claim terms, with the user's key and budget.
export async function makeBuyer({ privateKey, ownMinerId }) {
  if (!privateKey) return null;
  const { Telegraph } = await import('./telegraph.js');
  const { buySecondOpinions, buyContractTerms } = await import('./evidence.js');
  return async (result, budget) => {
    const tg = new Telegraph({ privateKey, ledger: budget, limits: { perBucketUsd: budget.perRun, globalUsd: budget.perMonth } });
    const sla = await buySecondOpinions(tg, result, { bucket: 'run', checkId: result.id, ownMinerId });
    const stop = sla.opinions.some((o) => o.code === 'LIMIT_REACHED');
    const terms = stop ? null : await buyContractTerms(tg, result, { bucket: 'run', checkId: result.id, ownMinerId });
    return { sla, terms };
  };
}
