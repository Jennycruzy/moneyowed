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
      out.push({ ...compare(purchase, result, s, q), label: p.label, reused: Boolean(cached) });
    } catch (e) {
      if (e instanceof SpendLimitError) { out.push({ label: p.label, error: e.message, code: 'LIMIT_REACHED' }); break; }
      out.push({ label: p.label, error: e.message });
    }
  }
  return { question: q, opinions: out };
}

export function compare(purchase, result, service, question) {
  const base = { miner_id: purchase.miner_id, miner_name: purchase.miner_name, route: purchase.route, cost_usd: purchase.cost_usd, latency_ms: purchase.latency_ms, answer_sha256: purchase.answer_sha256 };
  if (purchase.status !== 200) return { ...base, agrees: null, notes: [`not answered: ${String(purchase.error || `HTTP ${purchase.status}`).slice(0, 160)} (not charged)`], raw: null };
  const a = readSlaAnswer(purchase.answer);
  if (a.uptime_pct === null && a.compliant === null) return { ...base, agrees: null, period_label: a.period_label, notes: ['paid, but the answer carried no uptime figure and no verdict'], raw: purchase.answer };
  const notes = [];
  if (a.period_label && !String(a.period_label).includes(question.params.period.slice(0, 7)) && /last|rolling|90|30 days/i.test(String(a.period_label))) notes.push(`answered for "${a.period_label}", not the period asked`);
  if (!a.incidents_listed) notes.push('no incident list, so the SLA scope cannot be applied to it');
  const ourCompliant = service.uptime_pct >= service.threshold_pct;
  let agrees = null;
  if (a.compliant !== null) agrees = a.compliant === ourCompliant;
  else if (a.uptime_pct !== null) agrees = (a.uptime_pct >= service.threshold_pct) === ourCompliant;
  if (agrees === false) notes.push(`says ${a.compliant ?? (a.uptime_pct >= service.threshold_pct) ? 'met' : 'missed'}; our scoped count says ${ourCompliant ? 'met' : 'missed'}`);
  return {
    ...base, uptime_pct: a.uptime_pct, compliant: a.compliant, period_label: a.period_label, agrees, notes, raw: purchase.answer,
  };
}
