// Second opinions from Telegraph SLA miners, compared with our own scoped computation.
// Our verdict never silently follows a bought answer; every disagreement is shown with its reason.
import { slaQuestion, readSlaAnswer, SpendLimitError } from './telegraph.js';
import { VENDORS } from './vendors.js';

export const SECOND_OPINION_MINERS = (process.env.SLA_SECOND_OPINION_MINERS || '7410311,20260828').split(',').filter(Boolean);

export async function buySecondOpinions(tg, result, { bucket, checkId, ownMinerId = process.env.OWN_SLA_MINER_ID || null, reuse = null } = {}) {
  const s = result.services.find((x) => x.credit_pct > 0) || result.services[0];
  const v = VENDORS.find((x) => x.vendor === result.vendor);
  const q = slaQuestion({ vendorName: v?.telegraph_service || result.vendor_name, serviceName: s.service, threshold: s.threshold_pct, periodStart: new Date(result.period_start), periodEnd: new Date(result.period_end), periodKey: result.period, regions: result.regions || [] });
  const plan = [{ minerId: null, label: 'Telegraph routing (auto)' }];
  for (const m of SECOND_OPINION_MINERS) plan.push({ minerId: m, label: `direct pick ${m}` });
  if (ownMinerId) plan.push({ minerId: ownMinerId, label: 'our scoped SLA miner (disclosed: run by the same team)' });
  const out = [];
  const asked = new Set();
  for (const p of plan) {
    if (p.minerId && asked.has(String(p.minerId))) { out.push({ label: p.label, skipped: 'Telegraph routing already bought this miner\'s answer; not paying twice for the same fact' }); continue; }
    try {
      const cached = reuse?.(q, p.minerId);
      const purchase = cached || await tg.ask(q, { minerId: p.minerId, bucket, checkId });
      if (purchase.miner_id) asked.add(String(purchase.miner_id));
      out.push({ ...compare(purchase, result, s, q, { own: ownMinerId && String(purchase.miner_id) === String(ownMinerId) }), label: p.label, reused: Boolean(cached) });
    } catch (e) {
      if (e instanceof SpendLimitError) { out.push({ label: p.label, error: e.message, code: 'LIMIT_REACHED' }); break; }
      out.push({ label: p.label, error: e.message });
    }
  }
  return { question: q, opinions: out };
}

export function compare(purchase, result, service, question, { own = false } = {}) {
  const base = { miner_id: purchase.miner_id, miner_name: purchase.miner_name, route: purchase.route, cost_usd: purchase.cost_usd, latency_ms: purchase.latency_ms, answer_sha256: purchase.answer_sha256 };
  if (purchase.status !== 200) return { ...base, agrees: null, notes: [`not answered: ${String(purchase.error || `HTTP ${purchase.status}`).slice(0, 160)} (not charged)`], raw: null };
  const a = readSlaAnswer(purchase.answer);
  if (a.uptime_pct === null && a.compliant === null) return { ...base, agrees: null, period_label: a.period_label, notes: ['paid, but the answer carried no uptime figure and no verdict'], raw: purchase.answer };
  const notes = [];
  if (a.period_label && !String(a.period_label).includes(question.params.period.slice(0, 7)) && /last|rolling|90|30 days/i.test(String(a.period_label))) notes.push(`answered for "${a.period_label}", not the period asked`);
  if (own) notes.push('ours, same counting rules as this page; Telegraph passes on the five standard fields, the full incident list is at /miner/sla?detail=full');
  else if (!a.incidents_listed) notes.push('no incident list, so the SLA scope cannot be applied to it');
  const ourCompliant = service.uptime_pct >= service.threshold_pct;
  let agrees = null;
  if (a.compliant !== null) agrees = a.compliant === ourCompliant;
  else if (a.uptime_pct !== null) agrees = (a.uptime_pct >= service.threshold_pct) === ourCompliant;
  if (agrees === false) notes.push(`says ${a.compliant ?? (a.uptime_pct >= service.threshold_pct) ? 'met' : 'missed'}; our scoped count says ${ourCompliant ? 'met' : 'missed'}`);
  return {
    ...base, uptime_pct: a.uptime_pct, compliant: a.compliant, period_label: a.period_label, agrees, notes, raw: purchase.answer,
  };
}

// ---------- contract terms bought on Telegraph (CONTRACT_OBLIGATION_AUDIT), checked against the clause the claim rests on
// The vendor's own words go in; an answer agrees only if it names the same notice window and the same place to send the claim.
export function contractQuestion(result) {
  const s = result.services.find((x) => x.credit_pct > 0) || result.services[0];
  const parts = [result.claim.quote, s?.quotes?.threshold, s?.quotes?.tiers].filter(Boolean).map((x) => x.replace(/\s+/g, ' ').trim());
  const contract = `${result.vendor_name} SLA (${result.card.sla_url}). ${parts.join(' ')}`.slice(0, 3000);
  return { intent: 'CONTRACT_OBLIGATION_AUDIT_GENERAL', params: { contract }, query: `What must the customer do to receive a service credit under this SLA, by when, and where must the request go? ${contract}` };
}

export function claimTerms(result) {
  // only what the text we send actually says, so a seller is never marked down for leaving out something it was not shown
  const text = contractQuestion(result).params.contract.replace(/\b(fifteen|thirty|sixty|ten|two|five|seven)\s*\((\d+)\)/gi, '$2');
  const days = (/\bwithin\s+(\d+)\s+(?:business |calendar )?days\b/i.exec(text) || [])[1] || null;
  const where = (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text) || /\b(GitHub Support|support ticket|Prisma Platform Console|support portal|billing portal)\b/i.exec(text) || [])[0] || null;
  return { days: days ? Number(days) : null, where: where ? where.replace(/[.,;]+$/, '') : null };
}

export function compareTerms(purchase, terms, { own = false } = {}) {
  const base = { miner_id: purchase.miner_id, miner_name: purchase.miner_name, route: purchase.route, cost_usd: purchase.cost_usd, latency_ms: purchase.latency_ms, answer_sha256: purchase.answer_sha256 };
  if (purchase.status !== 200) return { ...base, agrees: null, notes: [`not answered: ${String(purchase.error || `HTTP ${purchase.status}`).slice(0, 160)} (not charged)`] };
  const a = purchase.answer || {};
  const said = JSON.stringify([a.obligations, a.clauses, a.summary]).toLowerCase();
  const notes = [];
  const gotDays = terms.days == null ? null : new RegExp(`\\b${terms.days}\\b`).test(said) || (terms.days === 30 && /thirty/.test(said));
  const gotWhere = terms.where == null ? null : said.includes(terms.where.toLowerCase());
  if (gotDays === false) notes.push(`does not give the ${terms.days}-day claim window`);
  if (gotWhere === false) notes.push(`does not say where the claim goes (${terms.where})`);
  if (own) notes.push('ours (disclosed: run by the same team); rule-based, every line quotes the contract');
  const checks = [gotDays, gotWhere].filter((x) => x !== null);
  return { ...base, verdict: a.verdict || null, first_obligation: Array.isArray(a.obligations) ? String(a.obligations[0] || '').slice(0, 200) : null, agrees: checks.length ? checks.every(Boolean) : null, notes };
}

export async function buyContractTerms(tg, result, { bucket, checkId, ownMinerId = process.env.OWN_SLA_MINER_ID || null, reuse = null } = {}) {
  const q = contractQuestion(result);
  const terms = claimTerms(result);
  const plan = [{ minerId: null, label: 'Telegraph routing (auto)' }];
  if (ownMinerId) plan.push({ minerId: ownMinerId, label: 'our contract reader (disclosed: same team)' });
  const out = []; const asked = new Set();
  for (const p of plan) {
    if (p.minerId && asked.has(String(p.minerId))) { out.push({ label: p.label, skipped: 'Telegraph routing already bought this answer; not paying twice' }); continue; }
    try {
      const cached = reuse?.(q, p.minerId);
      const purchase = cached || await tg.ask(q, { minerId: p.minerId, bucket, checkId });
      if (purchase.miner_id) asked.add(String(purchase.miner_id));
      out.push({ ...compareTerms(purchase, terms, { own: ownMinerId && String(purchase.miner_id) === String(ownMinerId) }), label: p.label, reused: Boolean(cached) });
    } catch (e) {
      if (e instanceof SpendLimitError) { out.push({ label: p.label, error: e.message, code: 'LIMIT_REACHED' }); break; }
      out.push({ label: p.label, error: e.message });
    }
  }
  return { question: { intent: q.intent, contract_chars: q.params.contract.length }, terms, opinions: out };
}
