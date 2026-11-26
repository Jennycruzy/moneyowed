import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-miner-'));
process.env.MONEYOWED_DATA = tmp;
fs.mkdirSync(path.join(tmp, 'incidents'), { recursive: true });
fs.cpSync(path.join(here, '..', 'data', 'sla'), path.join(tmp, 'sla'), { recursive: true });

const { parsePeriod, parseService, answerSla } = await import('../src/miner.js');
const { writeIncidents } = await import('../src/store.js');
const NOW = new Date('2026-11-21T12:00:00Z');

test('periods: rolling windows, billing periods and ranges', () => {
  const w = parsePeriod('last 30 days', NOW);
  assert.equal(w.kind, 'window'); assert.equal(+NOW - w.start, 30 * 86400000);
  assert.equal(parsePeriod('past 7 days', NOW).label, 'last 7 days');
  assert.equal(parsePeriod('P14D', NOW).label, 'last 14 days');
  assert.equal(parsePeriod('2026-10', NOW).key, '2026-10');
  assert.equal(parsePeriod('October 2026', NOW).key, '2026-10');
  assert.equal(parsePeriod('Oct 2026', NOW).key, '2026-10');
  assert.equal(parsePeriod('Q3 2026', NOW).key, '2026-Q3');
  assert.equal(parsePeriod('2026-q3', NOW).key, '2026-Q3');
  assert.equal(parsePeriod('last month', NOW).key, '2026-10');
  assert.equal(parsePeriod('last quarter', NOW).key, '2026-Q3');
  assert.equal(parsePeriod('last month', new Date('2026-01-05T00:00:00Z')).key, '2025-12');
  const r = parsePeriod('2026-09-03 to 2026-09-10', NOW);
  assert.equal(r.start.toISOString(), '2026-09-03T00:00:00.000Z'); assert.equal(r.end.toISOString(), '2026-09-11T00:00:00.000Z');
  assert.equal(parsePeriod('2026-07-01 to 2026-09-30', NOW).key, '2026-Q3');
  assert.equal(parsePeriod('2026-10-01 to 2026-10-31', NOW).key, '2026-10');
  assert.throws(() => parsePeriod('fortnight', NOW), { code: 'BAD_INPUT' });
  assert.throws(() => parsePeriod('last 900 days', NOW), { code: 'BAD_INPUT' });
});

test('services: vendor, covered service, plan and region from free text', () => {
  assert.equal(parseService('GitHub Actions').service.service, 'GitHub Actions');
  assert.equal(parseService('GitHub').service.service, 'GitHub Enterprise Cloud');
  assert.equal(parseService('Atlassian Jira Service Management').card.vendor, 'jira-service-management');
  assert.equal(parseService('Atlassian Jira Software').card.vendor, 'jira');
  assert.equal(parseService('Jira enterprise').plan.plan, 'enterprise');
  const a = parseService('Amazon EC2 us-east-1');
  assert.equal(a.service.service, 'Amazon EC2'); assert.deepEqual(a.regions, ['us-east-1']);
  assert.deepEqual(parseService('Azure Virtual Machines East US 2').regions, ['East US 2']);
  assert.deepEqual(parseService('Compute Engine us-central1').regions, ['us-central1']);
  assert.throws(() => parseService('AWS'), { code: 'BAD_INPUT' });
  assert.throws(() => parseService('Amazon S3'), { code: 'BAD_INPUT' });
  assert.throws(() => parseService('Cloudflare'), { code: 'VENDOR_NOT_COVERED' });
});

test('answer: only vendor-marked outage on covered parts counts; billing period carries the credit', () => {
  const comp = (n) => ({ id: n, name: n, group_id: null });
  writeIncidents('github', {
    source: 'statuspage', coverage_from: '2025-10-01T00:00:00.000Z', components: [comp('Git Operations'), comp('Copilot')],
    incidents: [
      // 600 min marked major outage on a covered component
      { id: 'a', name: 'Git down', impact: 'major', scheduled: false, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-01T10:00:00Z'), components: [comp('Git Operations')], component_statuses_published: true, component_windows: [{ component: 'Git Operations', component_id: 'Git Operations', status: 'major_outage', start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-01T10:00:00Z') }] },
      // degraded only: listed but not counted
      { id: 'b', name: 'Git slow', impact: 'minor', scheduled: false, start: new Date('2026-08-05T00:00:00Z'), end: new Date('2026-08-05T05:00:00Z'), components: [comp('Git Operations')], component_statuses_published: true, component_windows: [{ component: 'Git Operations', component_id: 'Git Operations', status: 'degraded_performance', start: new Date('2026-08-05T00:00:00Z'), end: new Date('2026-08-05T05:00:00Z') }] },
      // not a covered component
      { id: 'c', name: 'Copilot down', impact: 'major', scheduled: false, start: new Date('2026-08-07T00:00:00Z'), end: new Date('2026-08-07T05:00:00Z'), components: [comp('Copilot')], component_statuses_published: true, component_windows: [{ component: 'Copilot', component_id: 'Copilot', status: 'major_outage', start: new Date('2026-08-07T00:00:00Z'), end: new Date('2026-08-07T05:00:00Z') }] },
    ],
  });
  const q = answerSla({ service: 'GitHub', period: '2026-Q3' }, { now: NOW });
  assert.equal(q.downtime_minutes, 600);
  assert.equal(q.sla_target_pct, 99.9);
  assert.equal(q.compliant, false);
  assert.ok(q.uptime_pct < 99.6 && q.uptime_pct > 99.4);
  assert.equal(q.incidents_counted, 1);
  assert.equal(q.incidents.find((i) => i.name === 'Git slow').counted, false);
  assert.equal(q.incidents.find((i) => i.name === 'Copilot down').counted, false);
  assert.ok(q.credit_pct > 0);
  const w = answerSla({ service: 'GitHub', period: '2026-08-01 to 2026-08-01' }, { now: NOW });
  assert.equal(w.credit_pct, null);
  assert.equal(w.downtime_minutes, 600);
  const g = answerSla({ question: 'Did GitHub meet its SLA in Q3 2026?' }, { now: NOW });
  assert.equal(g.period, '2026-Q3');
});

test('a period that has not started yet is refused, not answered as 100%', async () => {
  const { answerSla } = await import('../src/miner.js');
  assert.throws(() => answerSla({ service: 'github', period: '2027-03' }, { now: new Date('2026-11-21T12:00:00Z') }), /has not started yet/);
});

test('questions the miner cannot measure get a full answer with no invented number', async () => {
  const { answerSla, abstainSla } = await import('../src/miner.js');
  const now = new Date('2026-11-25T00:30:00Z');
  for (const q of [{ service: 'Alpha', period: '2024-Q1' }, { service: 'Billing', period: 'last 45 days' }, { service: 'github', period: '2027-03' }]) {
    let err; try { answerSla(q, { now }); } catch (e) { err = e; }
    assert.ok(err && err.code, `expected a refusal for ${q.service}`);
    const a = abstainSla(q, err, { now });
    assert.equal(a.service, q.service); assert.equal(a.period, q.period);
    assert.equal(a.uptime_pct, null); assert.equal(a.sla_target_pct, null); assert.equal(a.compliant, null);
    assert.equal(a.abstained, true); assert.match(a.answer, /^Not measured/); assert.match(a.answer, /GitHub/);
  }
});

test('the short view puts the verdict first and keeps the measured numbers', async () => {
  const { answerSla, shortView } = await import('../src/miner.js');
  const full = answerSla({ service: 'GitHub', period: '2026-Q3' }, { now: NOW });
  const s = shortView(full);
  assert.deepEqual(Object.keys(s).slice(0, 7), ['summary', 'sla', 'service', 'period', 'uptime_pct', 'sla_target_pct', 'compliant']);
  assert.equal(s.uptime_pct, full.uptime_pct); assert.equal(s.compliant, full.compliant);
  assert.equal(s.sla.breached, !full.compliant);
  assert.match(s.summary, new RegExp(full.compliant ? 'SLA MET' : 'SLA BREACHED'));
  assert.equal(s.status, 'assessed'); assert.equal(s.incidents, undefined);
});

test('the short view of an unmeasurable question states it was not assessed and guesses nothing', async () => {
  const { answerSla, abstainSla, shortView } = await import('../src/miner.js');
  const now = new Date('2026-11-25T00:30:00Z');
  for (const q of [{ service: 'Alpha', period: '2024-Q1' }, { service: 'github', period: '2027-03' }]) {
    let err; try { answerSla(q, { now }); } catch (e) { err = e; }
    const s = shortView(abstainSla(q, err, { now }));
    assert.equal(s.uptime_pct, null); assert.equal(s.sla_target_pct, null); assert.equal(s.compliant, null);
    assert.equal(s.sla.breached, null); assert.equal(s.status, 'not_assessed');
    assert.match(s.summary, /SLA NOT ASSESSED/); assert.doesNotMatch(JSON.stringify(s), /Covered:/);
  }
});

test('a period still running gets no final verdict unless outage already exceeds the whole period', async () => {
  const { shortView } = await import('../src/miner.js');
  const comp = (n) => ({ id: n, name: n, group_id: null });
  const down = (id, start, mins) => ({ id, name: 'Git down', impact: 'major', scheduled: false, start: new Date(start), end: new Date(+new Date(start) + mins * 60000),
    components: [comp('Git Operations')], component_statuses_published: true,
    component_windows: [{ component: 'Git Operations', component_id: 'Git Operations', status: 'major_outage', start: new Date(start), end: new Date(+new Date(start) + mins * 60000) }] });
  const seedGh = (incidents) => writeIncidents('github', { source: 'statuspage', coverage_from: '2025-10-01T00:00:00.000Z', components: [comp('Git Operations')], incidents });
  seedGh([down('x', '2026-11-03T00:00:00Z', 30)]);
  let a = answerSla({ service: 'GitHub', period: '2026-11' }, { now: NOW });
  assert.equal(a.in_progress, true); assert.equal(a.compliant, null); assert.equal(a.already_missed, false);
  assert.equal(a.allowed_downtime_minutes, 43.2); // 0.1% of all 30 days of November, not of the days so far
  let v = shortView(a);
  assert.equal(v.status, 'in_progress'); assert.equal(v.sla.breached, null); assert.match(v.summary, /PERIOD IN PROGRESS/);
  seedGh([down('y', '2026-11-03T00:00:00Z', 60)]);
  a = answerSla({ service: 'GitHub', period: '2026-11' }, { now: NOW });
  assert.equal(a.already_missed, true); assert.equal(a.compliant, false);
  v = shortView(a);
  assert.equal(v.sla.breached, true); assert.match(v.summary, /SLA BREACHED, PERIOD STILL RUNNING/);
});
