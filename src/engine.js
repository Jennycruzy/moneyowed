// The credit decision. Plain code only: card rules + archived incident history -> verdict, amount, deadline, reasons.
import path from 'node:path';
import { loadCard, getPlan, checkCard } from './cards.js';
import { readIncidents } from './store.js';
import { periodBounds } from './lib/time.js';
import { mergeClip } from './lib/intervals.js';

export const METHOD_VERSION = 'scoped-minutes-1';
const DAY = 86400000;

export class CheckError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- scope matching per source
const OUTAGE = new Set(['partial_outage', 'major_outage']);

function statuspageSelector(service, groupsById, mode) {
  const m = service.match;
  const names = new Set(m.components || []);
  const groups = new Set(m.groups || []);
  const pats = (m.name_patterns || []).map((p) => toRe(p));
  const excl = (m.exclude_name_patterns || []).map((p) => toRe(p));
  const covered = (c) => {
    const g = c.group_id ? groupsById.get(c.group_id) : null;
    if (excl.some((r) => r.test(c.name))) return false;
    return names.has(c.name) || (g && groups.has(g)) || pats.some((r) => r.test(c.name));
  };
  return (inc) => {
    if (inc.scheduled) return { in_scope: false, reason: 'scheduled maintenance (excluded by the SLA)' };
    const comps = (inc.components || []).filter(covered);
    if (!comps.length) {
      const listed = (inc.components || []).map((c) => c.name).slice(0, 4).join(', ') || 'no component named';
      return { in_scope: false, reason: `not a covered service (${listed})` };
    }
    // Update streams name a grouped part "Group - Part"; match on the part's id, falling back to its bare name.
    const compIds = new Set(comps.map((c) => c.id));
    const compNames = new Set(comps.map((c) => c.name));
    const isCovered = (w) => (w.component_id && compIds.has(w.component_id)) || compNames.has(w.component) || compNames.has(String(w.component).split(' - ').slice(1).join(' - '));
    const wins = (inc.component_windows || []).filter((w) => isCovered(w) && (mode === 'upper' ? OUTAGE.has(w.status) : w.status === 'major_outage'));
    if (wins.length) {
      return { in_scope: true, reason: `${[...new Set(wins.map((w) => w.component))].join(', ')} marked ${[...new Set(wins.map((w) => w.status.replace('_', ' ')))].join(' / ')}`, windows: wins };
    }
    if (inc.component_statuses_published || (inc.component_windows || []).length) {
      return { in_scope: false, reason: `${comps.map((c) => c.name).join(', ')} listed, but the vendor's own status updates mark them ${(inc.component_windows || []).length ? `no outage (outage only on ${[...new Set(inc.component_windows.map((w) => w.component))].slice(0, 3).join(', ')})` : 'degraded or operational, never down'}` };
    }
    const strong = mode === 'upper' ? ['major', 'critical'] : ['critical'];
    if (strong.includes(inc.impact) && inc.end) {
      return { in_scope: true, reason: `${comps.map((c) => c.name).join(', ')}; incident impact "${inc.impact}" (no per-component timing published, whole incident counted)` };
    }
    return { in_scope: false, reason: `${comps.map((c) => c.name).join(', ')} affected but only "${inc.impact}" impact / degraded, not an outage` };
  };
}

const UNAVAILABLE = /\b(unavailab\w*|outages?|unable to|could not|couldn't|failed to|loss of|lost (network )?connectivity|inaccessible|not (be )?(reachable|accessible))/i;
// The customer-impact statement of an Azure PIR: the first two sentences after "What happened?".
function impactStatement(t) {
  const i = t.indexOf('What happened');
  const body = i >= 0 ? t.slice(i + 14) : t;
  return body.split(/(?<=\.)\s+/).slice(0, 2).join(' ');
}
const toRe = (p) => { const m = /^\(\?i\)(.*)$/.exec(p); return m ? new RegExp(m[1], 'i') : new RegExp(p); };

function regionMatches(loc, wanted) {
  if (loc === 'global') return true;
  if (wanted.includes(loc)) return true;
  // Google multi-regions
  if (/^(nam\d+|us)$/.test(loc) && wanted.some((r) => r.startsWith('us-'))) return true;
  if (/^(eur\d+|eu)$/.test(loc) && wanted.some((r) => r.startsWith('europe-'))) return true;
  return false;
}

function cloudSelector(source, service, regions, mode) {
  const m = service.match;
  return (inc) => {
    if (source === 'aws') {
      if (!m.cloud_service_keys.includes(inc.service_key)) return { in_scope: false, reason: `other service (${inc.service_name})` };
      const loc = inc.locations[0];
      if (loc === 'global' && !['global', '', ...regions].includes(inc.event_region)) return { in_scope: false, reason: `event in ${inc.event_region}, not one of your regions` };
      if (loc !== 'global' && !regions.includes(loc)) return { in_scope: false, reason: `region ${loc} is not one of yours` };
      if (!inc.disruption) return { in_scope: false, reason: `AWS status ${inc.max_status === 1 ? '1 (informational)' : inc.max_status === 2 ? '2 (degradation)' : inc.max_status}, not a service disruption` };
      return { in_scope: true, reason: `${inc.service_name} in ${loc}, marked service disruption`, windows: inc.windows };
    }
    if (source === 'gcp') {
      if (!(inc.services || []).some((s) => m.cloud_products.includes(s))) return { in_scope: false, reason: 'product not named in the incident' };
      const hit = (inc.locations || []).filter((l) => regionMatches(l, regions));
      if (!hit.length) return { in_scope: false, reason: `locations ${(inc.locations || []).join(', ') || 'none listed'} are not yours` };
      const outage = inc.status_impact ? inc.status_impact === 'SERVICE_OUTAGE' : inc.impact === 'high';
      if (!outage) return { in_scope: false, reason: `Google labels it ${inc.status_impact || `severity ${inc.impact}`} (degradation), not SERVICE_OUTAGE` };
      return { in_scope: true, reason: `${m.cloud_products[0]} in ${hit.join(', ')}, labelled SERVICE_OUTAGE by Google` };
    }
    if (source === 'azure') {
      if (!inc.start || !inc.end) return { in_scope: false, reason: inc.parse_error || 'no impact window' };
      const t = inc.text || '';
      if (!m.text_patterns.some((p) => new RegExp(p).test(t))) return { in_scope: false, reason: 'service not named in the incident review' };
      const hit = regions.filter((r) => (r === 'East US' ? /East US(?! 2)/.test(t) : t.includes(r)));
      if (!hit.length && !service.global) return { in_scope: false, reason: 'none of your regions named in the incident review' };
      const impact = impactStatement(t);
      if (!UNAVAILABLE.test(impact)) return { in_scope: false, reason: 'the review\'s impact statement describes degradation, not unavailability' };
      return { in_scope: true, reason: `named in review ${inc.id}${hit.length ? ` (${hit.join(', ')})` : ''}` };
    }
    return { in_scope: false, reason: 'unknown source' };
  };
}

// ---------- credit maths
export function tierFor(tiers, uptime) {
  for (const t of tiers) if (uptime >= t.from_pct && uptime < t.below_pct) return t.credit_pct;
  return 0;
}

function creditPct(service, ev) {
  if (ev.uptime_pct >= service.threshold_pct) return 0;
  if (service.tiers) return tierFor(service.tiers, ev.uptime_pct);
  if (service.credit_formula === 'pro_rata') return Math.round((ev.covered_minutes / ev.period_minutes) * 100 * 1000) / 1000;
  if (service.credit_formula === 'per_block') {
    const free = (service.free_pct / 100) * ev.period_minutes;
    const blocks = Math.floor(Math.max(0, ev.covered_minutes - free) / service.block_minutes);
    return blocks * service.credit_pct_per_block;
  }
  throw new CheckError('TERMS_CHANGED', `card for ${service.service} has no credit rule`);
}

// When the uptime first fell below the threshold (the moment a credit became owed).
function breachMoment(spans, periodMinutes, thresholdPct) {
  const allowance = ((100 - thresholdPct) / 100) * periodMinutes;
  let acc = 0;
  for (const s of spans) {
    const len = (s.end - s.start) / 60000;
    if (acc + len > allowance) return new Date(+s.start + (allowance - acc) * 60000 + 1000);
    acc += len;
  }
  return null;
}

function addMonths(d, n) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes())); }

export function claimDeadline(claim, { periodEnd, breachAt, firstIncidentStart }) {
  if (claim.deadline_unstated) return { date: null, rule: 'The SLA does not state a claim window; claim as soon as possible.' };
  if (claim.days_after_period_end !== undefined) return { date: new Date(+periodEnd + claim.days_after_period_end * DAY), rule: `${claim.days_after_period_end} days after the period ends` };
  if (claim.billing_cycles_after_period !== undefined) return { date: addMonths(periodEnd, claim.billing_cycles_after_period), rule: `end of the ${claim.billing_cycles_after_period === 2 ? 'second' : claim.billing_cycles_after_period} billing cycle after the incident (calendar months assumed)` };
  if (claim.days_after_eligible !== undefined) return { date: breachAt ? new Date(+breachAt + claim.days_after_eligible * DAY) : null, rule: `${claim.days_after_eligible} days from the moment the credit became owed` };
  if (claim.days_after_breach !== undefined) return { date: breachAt ? new Date(+breachAt + claim.days_after_breach * DAY) : null, rule: `${claim.days_after_breach} days from the missed commitment` };
  if (claim.days_after_incident !== undefined) return { date: firstIncidentStart ? new Date(+firstIncidentStart + claim.days_after_incident * DAY) : null, rule: `${claim.days_after_incident} days from the incident (earliest counted incident used)` };
  return { date: null, rule: 'no deadline rule on the card' };
}

// ---------- main entry
// input: { vendor, plan, period, spend (number or {service: amount}), regions (clouds), mode: 'upper'|'lower', now }
export function checkCredit(input, { slaDir = path.resolve(process.env.MONEYOWED_DATA || 'data', 'sla') } = {}) {
  const now = input.now ? new Date(input.now) : new Date();
  const card = loadCard(input.vendor);
  const { problems, warnings } = checkCard(card, slaDir, { withWarnings: true });
  if (problems.length) throw new CheckError('TERMS_CHANGED', `${card.name}: rule card failed its check (${problems[0]}). Checks are paused until the card is re-checked.`);
  const plan = getPlan(card, input.plan || card.plans[0].plan);
  const kind = plan.period;
  let pb;
  try { pb = periodBounds(input.period); } catch (e) { throw new CheckError('BAD_INPUT', e.message); }
  if (pb.kind !== kind) throw new CheckError('BAD_INPUT', `${card.name} ${plan.label} is measured per ${kind}; give the period as ${kind === 'quarter' ? 'YYYY-Qn (e.g. 2026-Q3)' : 'YYYY-MM (e.g. 2026-10)'}`);
  const off = (plan.period_utc_offset_hours || 0) * 3600000;
  const periodStart = new Date(+pb.start - off), periodEnd = new Date(+pb.end - off);
  const periodMinutes = (periodEnd - periodStart) / 60000;

  const store = readIncidents(input.vendor);
  if (store.coverage_from && new Date(store.coverage_from) > periodStart) throw new CheckError('NO_HISTORY', `${card.name} history we hold starts ${store.coverage_from.slice(0, 10)}; ${input.period} is earlier.`);
  const regions = input.regions || [];
  if (plan.per_region && !regions.length) throw new CheckError('BAD_INPUT', `${card.name} credits are per region; say which regions you use (e.g. us-east-1).`);
  const groupsById = new Map((store.components || []).filter((c) => c.group).map((c) => [c.id, c.name]));
  const mode = input.mode === 'lower' ? 'lower' : 'upper';

  const services = [];
  for (const s of plan.services) {
    const sel = store.source === 'statuspage' ? statuspageSelector(s, groupsById, mode) : cloudSelector(store.source, s, regions, mode);
    const rows = [];
    const counted = [];
    for (const inc of store.incidents) {
      if (!inc.start) continue;
      const incEnd = inc.end || (now < periodEnd ? now : null);
      if (!incEnd || incEnd <= periodStart || inc.start >= periodEnd) continue;
      const r = sel(inc);
      const wins = (r.windows || [{ start: inc.start, end: incEnd }]).map((w) => ({ start: w.start, end: w.end || incEnd }));
      const mins = mergeClip(wins, periodStart, periodEnd).minutes;
      rows.push({ id: inc.id, name: inc.name, url: inc.url, start: inc.start, end: inc.end, in_scope: r.in_scope, reason: r.reason, minutes: Math.round(mins * 10) / 10, sha256: inc.sha256 || null });
      if (r.in_scope) counted.push(...wins);
    }
    const merged = mergeClip(counted, periodStart, periodEnd);
    const ev = { covered_minutes: Math.round(merged.minutes * 10) / 10, period_minutes: periodMinutes, uptime_pct: Math.floor((1 - merged.minutes / periodMinutes) * 1e6) / 1e4 };
    let pct = creditPct(s, ev);
    if (plan.cap) pct = Math.min(pct, plan.cap.pct_of_fee);
    const breachAt = pct > 0 ? breachMoment(merged.spans, periodMinutes, s.threshold_pct) : null;
    const allowance = ((100 - s.threshold_pct) / 100) * periodMinutes;
    const fee = typeof input.spend === 'object' && input.spend ? input.spend[s.service] : (plan.services.length === 1 ? input.spend : undefined);
    services.push({
      service: s.service, threshold_pct: s.threshold_pct, ...ev,
      allowed_minutes: Math.round(allowance * 10) / 10,
      minutes_to_next_tier: pct === 0 ? Math.max(0, Math.round((allowance - ev.covered_minutes) * 10) / 10) : null,
      credit_pct: pct, fee: fee ?? null, credit_usd: fee != null ? Math.round(fee * pct) / 100 : null,
      breach_at: breachAt, config_note: s.config_note || null, measure_note: s.measure_note || null,
      quotes: { threshold: s.threshold_quote, tiers: s.tiers_quote || s.credit_quote, scope: s.scope_quote || null },
      incidents: rows.sort((a, b) => a.start - b.start),
    });
  }
  const owed = services.filter((s) => s.credit_pct > 0);
  const firstIncidentStart = owed.flatMap((s) => s.incidents.filter((i) => i.in_scope)).map((i) => i.start).sort((a, b) => a - b)[0];
  const breachAt = owed.map((s) => s.breach_at).filter(Boolean).sort((a, b) => a - b)[0] || null;
  const deadline = claimDeadline(plan.claim, { periodEnd, breachAt, firstIncidentStart });
  let code;
  if (now < periodEnd) code = 'PERIOD_OPEN';
  else if (!owed.length) code = 'NOT_OWED';
  else if (deadline.date && now > deadline.date) code = 'WINDOW_CLOSED';
  else code = 'OWED';
  const total = owed.every((s) => s.credit_usd != null) ? Math.round(owed.reduce((t, s) => t + s.credit_usd, 0) * 100) / 100 : null;
  return {
    code, vendor: card.vendor, vendor_name: card.name, plan: plan.plan, plan_label: plan.label, period: input.period,
    period_start: periodStart, period_end: periodEnd, mode, regions,
    owed_services: owed.map((s) => s.service), credit_usd_total: total,
    deadline: deadline.date, deadline_rule: deadline.rule, days_left: deadline.date ? Math.ceil((deadline.date - now) / DAY) : null,
    claim: { channel: plan.claim.channel, quote: plan.claim.quote || null, note: plan.claim.note || null },
    cap: plan.cap || null, services, card: { sla_url: card.sla_url, texts: card.sla_texts, checked_at: card.checked_at, notes: card.notes || [], page_changed: warnings },
    history: { collected_at: store.collected_at, coverage_from: store.coverage_from || null },
    method_version: METHOD_VERSION, computed_at: now,
  };
}
