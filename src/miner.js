// SLA_COMPLIANCE miner: turns a free-text service + period into a contract-scoped uptime answer.
// Same cards, same incident history and same counting rules as the app, so every answer can be re-checked.
import { listCards } from './cards.js';
import { checkCredit, measureWindow, CheckError, METHOD_VERSION } from './engine.js';
import { periodBounds } from './lib/time.js';
import { VENDORS } from './vendors.js';

const HISTORY_URL = { aws: 'https://health.aws.amazon.com/health/status', gcp: 'https://status.cloud.google.com/incidents.json', azure: 'https://azure.status.microsoft/en-us/status/history/' };

const DAY = 86400000;

// ---------- service text -> vendor / plan / covered service / regions
const VENDOR_WORDS = [
  ['jira-service-management', /\bjira service ?management\b|\bjsm\b/],
  ['jira', /\bjira\b/],
  ['confluence', /\bconfluence\b/],
  ['bitbucket', /\bbitbucket\b/],
  ['github', /\bgithub\b/],
  ['vercel', /\bvercel\b/],
  ['digitalocean', /\bdigital ?ocean\b/],
  ['twilio', /\btwilio\b/],
  ['linode', /\blinode\b|\bakamai\b/],
  ['mailgun', /\bmailgun\b/],
  ['sanity', /\bsanity\b/],
  ['prisma', /\bprisma\b/],
  ['mapbox', /\bmapbox\b/],
  ['buildkite', /\bbuildkite\b/],
  ['aws', /\baws\b|\bamazon\b|\bec2\b|\bs3\b|\blambda\b|\bdynamodb\b|\bcloudfront\b|\beks\b|\bsqs\b/],
  ['gcp', /\bgoogle cloud\b|\bgcp\b|\bcompute engine\b|\bbigquery\b|\bcloud run\b|\bgke\b|\bfirestore\b/],
  ['azure', /\bazure\b/],
];

// Extra words for a covered service inside a plan (lower case). The service's own name always matches too.
const SERVICE_WORDS = {
  'GitHub Actions': [/\bactions\b/], 'GitHub Packages': [/\bpackages\b/],
  'Hosted Agents': [/\bhosted agents?\b/],
  'Compute instances': [/\bcompute\b|\binstances?\b/],
  'Amazon EC2': [/\bec2\b/], 'Amazon S3': [/\bs3\b/], 'Amazon RDS': [/\brds\b/], 'AWS Lambda': [/\blambda\b/],
  'Amazon DynamoDB': [/\bdynamo ?db\b/], 'Elastic Load Balancing': [/\belb\b|\bload balanc/], 'Amazon CloudFront': [/\bcloudfront\b/],
  'Amazon EKS': [/\beks\b/], 'Amazon SQS': [/\bsqs\b/], 'Amazon API Gateway': [/\bapi gateway\b/],
  'Compute Engine': [/\bgce\b|\bcompute engine\b/], 'Cloud Storage': [/\bgcs\b|\bcloud storage\b/], 'Cloud SQL': [/\bcloud sql\b/],
  'Google Kubernetes Engine': [/\bgke\b|\bkubernetes\b/], 'Pub/Sub': [/\bpub ?\/? ?sub\b/], 'Cloud Load Balancing': [/\bload balanc/],
  'Azure Virtual Machines': [/\bvirtual machines?\b|\bvms?\b/], 'Azure Storage': [/\bstorage\b/], 'Azure SQL Database': [/\bsql\b/],
  'Azure App Service': [/\bapp service\b/], 'Azure Kubernetes Service': [/\baks\b|\bkubernetes\b/], 'Azure Functions': [/\bfunctions?\b/],
  'Azure Cosmos DB': [/\bcosmos\b/], 'Azure Load Balancer': [/\bload balancer\b/], 'Azure Service Bus': [/\bservice bus\b/], 'Azure Front Door': [/\bfront door\b/],
};

const AZURE_REGIONS = ['East US 2', 'East US', 'West US 2', 'West US 3', 'West US', 'Central US', 'North Central US', 'South Central US', 'West Central US',
  'Canada Central', 'Canada East', 'Brazil South', 'West Europe', 'North Europe', 'UK South', 'UK West', 'France Central', 'Germany West Central',
  'Sweden Central', 'Switzerland North', 'Norway East', 'Italy North', 'Poland Central', 'Spain Central', 'Southeast Asia', 'East Asia',
  'Japan East', 'Japan West', 'Korea Central', 'Central India', 'South India', 'Australia East', 'Australia Southeast', 'UAE North', 'South Africa North'];

function regionsIn(vendor, text) {
  if (vendor === 'aws') return [...new Set(text.match(/\b[a-z]{2}(?:-gov)?-[a-z]+-\d\b/g) || [])];
  if (vendor === 'gcp') return [...new Set((text.match(/\b[a-z]+-[a-z]+\d+\b/g) || []).filter((r) => !/^[a-z]{2}-[a-z]+-\d$/.test(r)))];
  if (vendor === 'azure') {
    const flat = text.replace(/\s+/g, '');
    const out = [];
    for (const r of AZURE_REGIONS) {
      const k = r.toLowerCase().replace(/\s+/g, '');
      if (flat.includes(k) && !out.some((o) => o.toLowerCase().replace(/\s+/g, '').includes(k))) out.push(r);
    }
    return out;
  }
  return [];
}

export function parseService(raw, planHint) {
  const text = String(raw || '').toLowerCase();
  if (!text.trim()) throw new CheckError('BAD_INPUT', 'service is required, e.g. "GitHub" or "Amazon EC2 us-east-1".');
  const hit = VENDOR_WORDS.find(([, re]) => re.test(text));
  if (!hit) throw new CheckError('VENDOR_NOT_COVERED', `"${String(raw).slice(0, 80)}" is not a covered vendor. Covered: ${listCards().map((c) => c.name).join(', ')}.`);
  const card = listCards().find((c) => c.vendor === hit[0]);
  const hint = String(planHint || '').toLowerCase();
  const plan = card.plans.find((p) => hint && (hint.includes(p.plan) || hint.includes(p.label.toLowerCase())))
    || card.plans.find((p) => new RegExp(`\\b${p.plan.replace(/-/g, '[ -]?')}\\b`).test(text))
    || card.plans[0];
  const named = plan.services.filter((s) => text.includes(s.service.toLowerCase()) || (SERVICE_WORDS[s.service] || []).some((re) => re.test(text)));
  // Prefer the longest explicit name (e.g. "GitHub Actions" over "GitHub Enterprise Cloud").
  named.sort((a, b) => b.service.length - a.service.length);
  let service = named[0];
  if (!service) {
    if (plan.per_region) throw new CheckError('BAD_INPUT', `Name one ${card.name} service and a region, e.g. "${plan.services[0].service} ${card.vendor === 'azure' ? 'East US' : card.vendor === 'gcp' ? 'us-central1' : 'us-east-1'}". Covered: ${plan.services.map((s) => s.service).join(', ')}.`);
    service = plan.services[0];
  }
  const regions = regionsIn(card.vendor, text);
  if (plan.per_region && !regions.length) throw new CheckError('BAD_INPUT', `${card.name} credits are per region; add one, e.g. "${service.service} ${card.vendor === 'azure' ? 'East US' : card.vendor === 'gcp' ? 'us-central1' : 'us-east-1'}".`);
  return { card, plan, service, regions, defaulted: !named.length };
}

// ---------- period text -> window
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNIT_MS = { minute: 60000, hour: 3600000, day: DAY, week: 7 * DAY };

export function parsePeriod(raw, now = new Date()) {
  const t = String(raw || '').trim().toLowerCase();
  const y0 = now.getUTCFullYear(), m0 = now.getUTCMonth();
  const key = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
  const billing = (k) => { const b = periodBounds(k); return { key: k, kind: b.kind, start: b.start, end: b.end, label: k }; };
  if (!t) return rolling(30, now, 'last 30 days (no period given)');
  let m;
  if ((m = /^(\d{4})-(\d{2})$/.exec(t))) return billing(t);
  if ((m = /^(\d{4})[- ]?q([1-4])$/.exec(t)) || (m = /^q([1-4])[ ,-]*(\d{4})$/.exec(t))) {
    const [y, q] = m[1].length === 4 ? [m[1], m[2]] : [m[2], m[1]];
    return billing(`${y}-Q${q}`);
  }
  if ((m = /^(?:(?:the\s+)?(?:last|past|previous|trailing)\s+)?(\d+)\s*(minute|hour|day|week|month)s?$/.exec(t)) || (m = /^p(\d+)([dw])$/.exec(t))) {
    const n = +m[1];
    const unit = { d: 'day', w: 'week' }[m[2]] || m[2];
    if (unit === 'month') return rolling(n * 30, now, `last ${n * 30} days`);
    const ms = n * UNIT_MS[unit];
    if (ms > 400 * DAY || ms <= 0) throw new CheckError('BAD_INPUT', `period "${raw}" is outside 1 hour to 400 days`);
    return { key: null, kind: 'window', start: new Date(+now - ms), end: now, label: `last ${n} ${unit}${n === 1 ? '' : 's'}` };
  }
  if (/^(the\s+)?(last|past) (24 hours|day)$/.test(t)) return rolling(1, now, 'last 24 hours');
  if (/^(the\s+)?(last|past) week$/.test(t)) return rolling(7, now, 'last 7 days');
  if (/^(the\s+)?(last|past) (year|12 months)$/.test(t)) return rolling(365, now, 'last 365 days');
  if (/^(the\s+)?(last|previous|prior) (calendar )?month$/.test(t)) return billing(key(m0 === 0 ? y0 - 1 : y0, (m0 + 11) % 12));
  if (/^(this|current) month$|^month to date$|^mtd$/.test(t)) return billing(key(y0, m0));
  if (/^(the\s+)?(last|previous|prior) quarter$/.test(t)) { const q = Math.floor(m0 / 3); return billing(q === 0 ? `${y0 - 1}-Q4` : `${y0}-Q${q}`); }
  if (/^(this|current) quarter$|^quarter to date$|^qtd$/.test(t)) return billing(`${y0}-Q${Math.floor(m0 / 3) + 1}`);
  if ((m = new RegExp(`^(${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')})\\.?,?\\s+(\\d{4})$`).exec(t))) {
    return billing(key(+m[2], MONTHS.findIndex((x) => x.startsWith(m[1].slice(0, 3)))));
  }
  if ((m = /^(\d{4}-\d{2}-\d{2})(?:t[\d:.]+z?)?\s*(?:to|until|through|thru|\/|–|-|and|\.\.)\s*(\d{4}-\d{2}-\d{2})(?:t[\d:.]+z?)?(?:\s*utc)?$/.exec(t.replace(/^(from|between)\s+/, '')))) {
    // Both dates are included, as people write them ("2026-07-01 to 2026-09-30" is the whole quarter).
    const start = new Date(`${m[1]}T00:00:00Z`), end = new Date(+new Date(`${m[2]}T00:00:00Z`) + DAY);
    if (Number.isNaN(+start) || Number.isNaN(+end) || !(end > start)) throw new CheckError('BAD_INPUT', `period "${raw}": end must be on or after start`);
    if (start.getUTCDate() === 1 && end.getUTCDate() === 1) {
      const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
      if (months === 1) return billing(key(start.getUTCFullYear(), start.getUTCMonth()));
      if (months === 3 && start.getUTCMonth() % 3 === 0) return billing(`${start.getUTCFullYear()}-Q${start.getUTCMonth() / 3 + 1}`);
    }
    if (+end - +start > 400 * DAY) throw new CheckError('BAD_INPUT', `period "${raw}" is longer than 400 days`);
    return { key: null, kind: 'window', start, end, label: `${m[1]} to ${m[2]} (both days included)` };
  }
  throw new CheckError('BAD_INPUT', `period "${String(raw).slice(0, 60)}" not understood. Use "last 30 days", "2026-10", "October 2026", "2026-Q3" or "2026-09-01 to 2026-09-30".`);
}

function rolling(days, now, label) {
  return { key: null, kind: 'window', start: new Date(+now - days * DAY), end: now, label };
}

// ---------- the answer
const iso = (d) => (d ? new Date(d).toISOString() : null);

export function answerSla(q, { now = new Date() } = {}) {
  const serviceText = q.service || q.question || q.query || '';
  const periodText = q.period ?? (q.service ? '' : (String(q.question || q.query || '').match(/(last|past|previous)\s+\d*\s*\w+|\d{4}-q[1-4]|q[1-4]\s+\d{4}|\d{4}-\d{2}-\d{2}\s*(to|until|through)\s*\d{4}-\d{2}-\d{2}|\d{4}-\d{2}(?!-)|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}/i) || [''])[0]);
  const { card, plan, service, regions, defaulted } = parseService(serviceText, q.plan);
  const p = parsePeriod(periodText, now);
  if (p.start >= now) throw new CheckError('BAD_INPUT', `period "${String(periodText).slice(0, 60)}" has not started yet; uptime can only be measured for past time.`);
  const notes = [];
  if (defaulted && plan.services.length > 1) notes.push(`No covered service named; answered for "${service.service}". Others on this plan: ${plan.services.slice(1).map((s) => s.service).join(', ')}.`);
  if (card.plans.length > 1) notes.push(`Plan read as ${plan.label}; ${card.plans.filter((x) => x !== plan).map((x) => x.label).join(', ')} also has an SLA.`);

  let m, credit = null;
  const complete = p.end <= now;
  if (p.kind === plan.period && complete) {
    const r = checkCredit({ vendor: card.vendor, plan: plan.plan, period: p.key, regions: regions.length ? regions : undefined, now });
    const s = r.services.find((x) => x.service === service.service);
    m = { uptime_pct: s.uptime_pct, covered_minutes: s.covered_minutes, period_minutes: s.period_minutes, incidents: s.incidents, period_start: r.period_start, period_end: r.period_end };
    credit = { credit_pct: s.credit_pct, claim_deadline: iso(r.deadline), deadline_rule: r.deadline_rule, verdict: r.code === 'OWED' || r.code === 'WINDOW_CLOSED' ? (s.credit_pct > 0 ? r.code : 'NOT_OWED') : r.code };
  } else {
    if (!complete) notes.push('Period still open: uptime counted up to now.');
    notes.push(`The ${plan.label} SLA is measured per calendar ${plan.period}; uptime for any other window is shown for information and is not by itself a credit.`);
    m = measureWindow({ vendor: card.vendor, plan: plan.plan, service: service.service, start: p.start, end: p.end, regions, now });
  }
  const minutes = (new Date(m.period_end) - new Date(m.period_start)) / 60000;
  const compliant = m.uptime_pct >= service.threshold_pct;
  const counted = m.incidents.filter((i) => i.in_scope);
  const excluded = m.incidents.filter((i) => !i.in_scope);
  const name = plan.per_region || service.service.includes(card.name) ? service.service : `${card.name} ${service.service}`;
  const planTxt = plan.per_region ? `${card.name} SLA` : `${plan.label} SLA`;
  const where = regions.length ? ` in ${regions.join(', ')}` : '';
  const sentence = `${name}${where} (${planTxt}): ${m.uptime_pct}% uptime for ${p.label} against a ${service.threshold_pct}% SLA target, so the SLA was ${compliant ? 'met' : 'missed'}. ${m.covered_minutes} minutes of vendor-marked outage on covered services were counted (${counted.length} incident${counted.length === 1 ? '' : 's'}); ${excluded.length} other incident${excluded.length === 1 ? '' : 's'} in the window did not count under the contract.${credit && credit.credit_pct > 0 ? ` Service credit owed: ${credit.credit_pct}% of the ${plan.period}'s fee.` : ''}`;
  return {
    service: `${name}${where}`, vendor: card.vendor, plan: plan.plan, covered_service: service.service, regions,
    period: p.label, period_start: iso(m.period_start), period_end: iso(m.period_end),
    uptime_pct: m.uptime_pct, sla_target_pct: service.threshold_pct, compliant,
    downtime_minutes: m.covered_minutes, allowed_downtime_minutes: Math.round(((100 - service.threshold_pct) / 100) * minutes * 10) / 10, period_minutes: Math.round(minutes * 10) / 10,
    credit_pct: credit ? credit.credit_pct : null, claim_deadline: credit ? credit.claim_deadline : null, deadline_rule: credit ? credit.deadline_rule : null,
    answer: sentence,
    incidents_counted: counted.length,
    incidents: [...counted, ...excluded.slice(0, 25)].map((i) => ({ name: i.name, start: iso(i.start), end: iso(i.end), minutes: i.minutes, counted: i.in_scope, reason: i.reason, url: i.url || null })),
    incidents_not_listed: Math.max(0, excluded.length - 25),
    scope: 'Contract scope: only time the vendor itself marked a covered service as down (Statuspage partial or major outage per component; AWS service disruption; Google SERVICE_OUTAGE; Azure review stating unavailability) counts. Degraded performance and scheduled maintenance do not.',
    sources: { sla_url: card.sla_url, sla_target_quote: service.threshold_quote || null, incident_history: HISTORY_URL[card.vendor] || `https://${VENDORS.find((v) => v.vendor === card.vendor).host}/history` },
    notes, method: METHOD_VERSION, computed_at: iso(now),
  };
}

export const ERROR_STATUS = { BAD_INPUT: 400, VENDOR_NOT_COVERED: 404, PLAN_NOT_COVERED: 404, NO_HISTORY: 422, TERMS_CHANGED: 409 };
