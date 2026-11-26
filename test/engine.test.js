import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-engine-'));
process.env.MONEYOWED_DATA = tmp;
fs.mkdirSync(path.join(tmp, 'incidents'), { recursive: true });
fs.cpSync(path.join(here, '..', 'data', 'sla'), path.join(tmp, 'sla'), { recursive: true });

const { checkCredit, tierFor, claimDeadline } = await import('../src/engine.js');
const { writeIncidents } = await import('../src/store.js');

const NOW = '2026-11-21T12:00:00Z';
const sp = (id, name, start, end, impact = 'major', windows = [], { components = ['Git Operations'], ...extra } = {}) => ({
  vendor: 'x', source: 'statuspage', id, name, impact, scheduled: false, start, end, ...extra,
  components: components.map((n) => ({ id: n, name: n, group_id: n === 'us-east' ? 'g' : null })), component_windows: windows, url: `https://example/${id}`,
});

function seed(vendor, incidents, extra = {}) {
  writeIncidents(vendor, { source: 'statuspage', coverage_from: '2025-10-01T00:00:00.000Z', components: [], incidents, ...extra });
}

test('tier lookup edges: exactly at a boundary belongs to the higher band', () => {
  const t = [{ from_pct: 99.5, below_pct: 99.9, credit_pct: 5 }, { from_pct: 99.0, below_pct: 99.5, credit_pct: 10 }, { from_pct: 0, below_pct: 99.0, credit_pct: 25 }];
  assert.equal(tierFor(t, 99.9), 0);
  assert.equal(tierFor(t, 99.8999), 5);
  assert.equal(tierFor(t, 99.5), 5);
  assert.equal(tierFor(t, 99.4999), 10);
  assert.equal(tierFor(t, 98.9), 25);
});

test('github quarter: exactly at the allowance is not owed; one minute over is', () => {
  // Q3 2026 = 92 days = 132,480 minutes; 99.9% allows 132.48 minutes.
  seed('github', [sp('a', 'git down', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T02:12:00Z'))]);
  let r = checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2026-Q3', spend: { 'GitHub Enterprise Cloud': 6000 }, now: NOW });
  assert.equal(r.services[0].covered_minutes, 132);
  assert.equal(r.services[0].credit_pct, 0);
  assert.equal(r.code, 'NOT_OWED');
  seed('github', [sp('a', 'git down', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T02:14:00Z'))]);
  r = checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2026-Q3', spend: { 'GitHub Enterprise Cloud': 6000 }, now: '2026-10-05T00:00:00Z' });
  assert.equal(r.services[0].credit_pct, 5);
  assert.equal(r.services[0].credit_usd, 300);
  assert.equal(r.code, 'OWED');
  assert.equal(r.deadline.toISOString(), '2026-10-31T00:00:00.000Z');
});

test('uncovered components and scheduled maintenance do not count, with reasons', () => {
  seed('github', [
    sp('c', 'copilot down', new Date('2026-08-02T00:00:00Z'), new Date('2026-08-02T10:00:00Z'), 'critical', [], { components: ['Copilot'] }),
    sp('m', 'planned', new Date('2026-08-03T00:00:00Z'), new Date('2026-08-03T10:00:00Z'), 'major', [], { scheduled: true }),
  ]);
  const r = checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2026-Q3', spend: {}, now: NOW });
  const ghec = r.services[0];
  assert.equal(ghec.covered_minutes, 0);
  assert.match(ghec.incidents[0].reason, /not a covered service \(Copilot\)/);
  assert.match(ghec.incidents[1].reason, /scheduled maintenance/);
});

test('per-component timing wins over the incident window', () => {
  seed('jira', [sp('w', 'emails', new Date('2026-06-19T00:00:00Z'), new Date('2026-06-26T00:00:00Z'), 'major',
    [{ component: 'Automation for Jira', start: new Date('2026-06-19T00:00:00Z'), end: new Date('2026-06-26T00:00:00Z'), status: 'partial_outage' }],
    { components: ['Viewing content', 'Automation for Jira'] })]);
  const r = checkCredit({ vendor: 'jira', plan: 'premium', period: '2026-06', spend: 2000, now: NOW });
  assert.equal(r.services[0].covered_minutes, 0);
  assert.match(r.services[0].incidents[0].reason, /status updates mark them no outage/);
});

test('a "major" incident whose parts the vendor marked only degraded does not count', () => {
  seed('jira', [sp('d', 'slow', new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T06:00:00Z'), 'major', [], { components: ['Viewing content'], component_statuses_published: true })]);
  const r = checkCredit({ vendor: 'jira', plan: 'premium', period: '2026-06', spend: 2000, now: NOW });
  assert.equal(r.services[0].covered_minutes, 0);
  assert.match(r.services[0].incidents[0].reason, /degraded or operational, never down/);
});

test('lower mode counts only major outages; upper counts partial too', () => {
  const w = (status) => [{ component: 'Viewing content', start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-01T02:00:00Z'), status }];
  seed('jira', [sp('p', 'partial', new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T02:00:00Z'), 'major', w('partial_outage'), { components: ['Viewing content'] })]);
  assert.equal(checkCredit({ vendor: 'jira', plan: 'premium', period: '2026-06', spend: 2000, now: NOW }).services[0].covered_minutes, 120);
  assert.equal(checkCredit({ vendor: 'jira', plan: 'premium', period: '2026-06', spend: 2000, mode: 'lower', now: NOW }).services[0].covered_minutes, 0);
});

test('enterprise plan uses its own stricter tiers; July is 31 days', () => {
  // 99.95% of 44,640 min allows 22.32 min. 30 min down -> 99.9328% -> Enterprise 5% band.
  seed('jira', [sp('e', 'x', new Date('2026-07-10T00:00:00Z'), new Date('2026-07-10T00:30:00Z'), 'major', [], { components: ['Viewing content'] })]);
  const p = checkCredit({ vendor: 'jira', plan: 'premium', period: '2026-07', spend: 1000, now: NOW });
  const e = checkCredit({ vendor: 'jira', plan: 'enterprise', period: '2026-07', spend: 1000, now: NOW });
  assert.equal(p.services[0].credit_pct, 0);
  assert.equal(e.services[0].credit_pct, 5);
  assert.equal(e.services[0].credit_usd, 50);
});

test('cap applies (Vercel 50%)', () => {
  seed('vercel', [sp('v', 'cdn', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-05T00:00:00Z'), 'critical', [], { components: ['Functions'] })]);
  const r = checkCredit({ vendor: 'vercel', plan: 'enterprise', period: '2026-08', spend: 1000, now: NOW });
  assert.equal(r.services[0].credit_pct, 50); // 4 days down in August = 87.1% uptime -> below 95% -> 50% band, equal to the 50% cap
});

test('wrong period kind, unknown plan and unknown vendor fail loudly', () => {
  seed('github', []);
  assert.throws(() => checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2026-08', now: NOW }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => checkCredit({ vendor: 'github', plan: 'free', period: '2026-Q3', now: NOW }), (e) => e.code === 'PLAN_NOT_COVERED');
  assert.throws(() => checkCredit({ vendor: 'cloudflare', period: '2026-08', now: NOW }), (e) => e.code === 'VENDOR_NOT_COVERED');
});

test('page chrome changing keeps checks running with a note; a changed quoted term stops them (TERMS_CHANGED)', () => {
  seed('github', []);
  const f0 = path.join(tmp, 'sla', 'github.txt');
  const o = fs.readFileSync(f0);
  fs.writeFileSync(f0, o.toString() + ' New footer link.');
  try {
    const r = checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2026-Q3', spend: {}, now: NOW });
    assert.equal(r.card.page_changed.length, 1);
  } finally { fs.writeFileSync(f0, o); }

  seed('github', []);
  const f = path.join(tmp, 'sla', 'github.txt');
  const orig = fs.readFileSync(f);
  fs.writeFileSync(f, orig.toString().replace('99.9% Uptime', '99.5% Uptime'));
  try {
    assert.throws(() => checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2026-Q3', now: NOW }), (e) => e.code === 'TERMS_CHANGED');
  } finally { fs.writeFileSync(f, orig); }
});

test('period before held history is NO_HISTORY; open period is PERIOD_OPEN', () => {
  seed('github', []);
  assert.throws(() => checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2025-Q2', now: NOW }), (e) => e.code === 'NO_HISTORY');
  assert.equal(checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: '2026-Q4', spend: {}, now: NOW }).code, 'PERIOD_OPEN');
});

test('cloud feed history begins at its earliest record: an earlier period is NO_HISTORY, not 100% uptime', async () => {
  const { earliestStart } = await import('../src/sources/clouds.js');
  const ev = (id, start) => ({ vendor: 'aws', source: 'aws', id, name: 'EC2 errors', impact: '3', start: new Date(start), end: new Date(+new Date(start) + 3600000), windows: [], service_key: 'ec2', service_name: 'Amazon EC2', locations: ['us-east-1'], event_region: 'us-east-1', disruption: false, max_status: 2 });
  const incidents = [ev('a', '2026-03-10T00:00:00Z'), ev('b', '2026-01-28T09:00:00Z'), { ...ev('c', '2026-05-01T00:00:00Z'), start: null }];
  assert.equal(earliestStart(incidents), '2026-01-28T09:00:00.000Z');
  writeIncidents('aws', { source: 'aws', incidents });
  assert.throws(() => checkCredit({ vendor: 'aws', period: '2023-09', regions: ['us-east-1'], now: NOW }), (e) => e.code === 'NO_HISTORY' && /starts 2026-01-28/.test(e.message));
  assert.throws(() => checkCredit({ vendor: 'aws', period: '2026-01', regions: ['us-east-1'], now: NOW }), (e) => e.code === 'NO_HISTORY');
  assert.equal(checkCredit({ vendor: 'aws', period: '2026-02', regions: ['us-east-1'], spend: {}, now: NOW }).services.length > 0, true);
  writeIncidents('aws', { source: 'aws', incidents: [] });
  assert.throws(() => checkCredit({ vendor: 'aws', period: '2026-02', regions: ['us-east-1'], now: NOW }), (e) => e.code === 'NO_HISTORY');
});

test('mailgun per-30-minute credit after the first 0.01%, capped at 50%', () => {
  // Oct: 44,640 min; free 4.464 min. 100 min down -> floor(95.5/30)=3 blocks -> 15%.
  seed('mailgun', [sp('g', 'api', new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T01:40:00Z'), 'major', [], { components: ['API'] })]);
  let r = checkCredit({ vendor: 'mailgun', plan: 'paid', period: '2026-10', spend: 1000, now: NOW });
  assert.equal(r.services[0].credit_pct, 15);
  assert.equal(r.deadline, null);
  assert.match(r.deadline_rule, /does not state/);
  seed('mailgun', [sp('g', 'api', new Date('2026-10-02T00:00:00Z'), new Date('2026-10-04T00:00:00Z'), 'major', [], { components: ['API'] })]);
  r = checkCredit({ vendor: 'mailgun', plan: 'paid', period: '2026-10', spend: 1000, now: NOW });
  assert.equal(r.services[0].credit_pct, 50);
});

test('linode pro-rata credit', () => {
  seed('linode', [sp('l', 'region', new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T07:26:24Z'), 'major', [], { components: ['us-east'] })],
    { components: [{ id: 'g', name: 'Regions', group: true }, { id: 'us-east', name: 'us-east', group: false, group_id: 'g' }] });
  const r = checkCredit({ vendor: 'linode', plan: 'standard', period: '2026-10', spend: { 'Compute instances': 1000 }, now: NOW });
  assert.equal(r.services[0].covered_minutes, 446.4);
  assert.equal(r.services[0].credit_pct, 1);
  assert.equal(r.services[0].credit_usd, 10);
});

test('sanity months start at midnight CET', () => {
  seed('sanity', [sp('s', 'api', new Date('2026-09-30T23:00:00Z'), new Date('2026-09-30T23:59:00Z'), 'major', [], { components: ['api.sanity.io'] })]);
  const r = checkCredit({ vendor: 'sanity', plan: 'e2', period: '2026-10', spend: 1000, now: NOW });
  assert.equal(r.period_start.toISOString(), '2026-09-30T23:00:00.000Z');
  assert.equal(r.services[0].covered_minutes, 59);
});

test('clouds need regions; out-of-region incidents are excluded with a reason', () => {
  writeIncidents('aws', { source: 'aws', incidents: [
    { vendor: 'aws', source: 'aws', id: 'e1', name: 'EC2 errors', impact: '2', start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-01T05:00:00Z'), windows: [{ start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-01T05:00:00Z') }], service_key: 'ec2', service_name: 'Amazon EC2', locations: ['us-east-1'], event_region: 'us-east-1', disruption: true, max_status: 3 },
    { vendor: 'aws', source: 'aws', id: 'e3', name: 'EC2 slow', impact: '2', start: new Date('2026-10-05T00:00:00Z'), end: new Date('2026-10-05T09:00:00Z'), windows: [], service_key: 'ec2', service_name: 'Amazon EC2', locations: ['us-east-1'], event_region: 'us-east-1', disruption: false, max_status: 2 },
    { vendor: 'aws', source: 'aws', id: 'e2', name: 'EC2 errors', impact: '3', start: new Date('2026-10-03T00:00:00Z'), end: new Date('2026-10-03T05:00:00Z'), windows: [{ start: new Date('2026-10-03T00:00:00Z'), end: new Date('2026-10-03T05:00:00Z') }], service_key: 'ec2', service_name: 'Amazon EC2', locations: ['ap-south-1'], event_region: 'ap-south-1' },
  ] });
  assert.throws(() => checkCredit({ vendor: 'aws', period: '2026-10', now: NOW }), (e) => e.code === 'BAD_INPUT');
  const r = checkCredit({ vendor: 'aws', period: '2026-10', regions: ['us-east-1'], spend: { 'Amazon EC2': 1000 }, now: NOW });
  const ec2 = r.services.find((s) => s.service === 'Amazon EC2');
  assert.equal(ec2.covered_minutes, 300);
  assert.equal(ec2.credit_pct, 10);
  assert.match(ec2.incidents.find((i) => i.id === 'e2').reason, /ap-south-1 is not one of yours/);
  assert.match(ec2.incidents.find((i) => i.id === 'e3').reason, /2 \(degradation\), not a service disruption/);
  assert.equal(r.deadline.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('deadline rules', () => {
  const pe = new Date('2026-11-01T00:00:00Z');
  assert.equal(claimDeadline({ days_after_period_end: 15 }, { periodEnd: pe }).date.toISOString(), '2026-11-16T00:00:00.000Z');
  assert.equal(claimDeadline({ billing_cycles_after_period: 2 }, { periodEnd: pe }).date.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(claimDeadline({ days_after_incident: 60 }, { periodEnd: pe, firstIncidentStart: new Date('2026-10-10T00:00:00Z') }).date.toISOString(), '2026-12-09T00:00:00.000Z');
  assert.equal(claimDeadline({ days_after_eligible: 30 }, { periodEnd: pe, breachAt: null }).date, null);
});

test('gcp: an incident Google tags "global" plus one region counts only in that region', () => {
  const inc = (id, locations) => ({ vendor: 'gcp', source: 'gcp', id, name: id, impact: 'high', status_impact: 'SERVICE_OUTAGE', scheduled: false,
    start: '2026-08-20T15:40:00.000Z', end: '2026-08-20T19:20:00.000Z', services: ['Google Compute Engine'], locations, url: `https://example/${id}` });
  writeIncidents('gcp', { source: 'gcp', coverage_from: '2025-10-01T00:00:00.000Z', incidents: [inc('west', ['global', 'us-west1']), inc('everywhere', ['global'])] });
  const ce = (regions) => checkCredit({ vendor: 'gcp', period: '2026-08', regions, now: NOW }).services.find((s) => s.service === 'Compute Engine');
  const central = ce(['us-central1']);
  assert.deepEqual(central.incidents.filter((i) => i.in_scope).map((i) => i.id), ['everywhere']);
  const west = ce(['us-west1']);
  assert.deepEqual(west.incidents.filter((i) => i.in_scope).map((i) => i.id).sort(), ['everywhere', 'west']);
});
