import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { periodBounds, periodMinutes, periodsBetween, periodOf, toDate } from '../src/lib/time.js';
import { mergeClip } from '../src/lib/intervals.js';
import { evaluatePeriod, vendorWideSelector } from '../src/uptime.js';
import { normalizeStatuspageIncident } from '../src/sources/statuspage.js';
import { parseAzureWindow, normalizeAws, normalizeGcp } from '../src/sources/clouds.js';
import { Archive } from '../src/archive.js';

const D = (s) => new Date(s);

test('month and quarter bounds are UTC and exact', () => {
  assert.deepEqual(periodBounds('2026-02'), { start: D('2026-02-01T00:00:00Z'), end: D('2026-03-01T00:00:00Z'), kind: 'month' });
  assert.equal(periodMinutes('2026-02'), 28 * 1440);
  assert.equal(periodMinutes('2024-02'), 29 * 1440);
  assert.equal(periodMinutes('2026-Q3'), 92 * 1440);
  assert.equal(periodBounds('2026-12').end.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(periodBounds('2026-Q4').end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('bad period keys fail loudly', () => {
  assert.throws(() => periodBounds('2026-13'));
  assert.throws(() => periodBounds('Oct 2026'));
  assert.throws(() => periodBounds('2026-Q5'));
});

test('periodOf and periodsBetween', () => {
  assert.equal(periodOf(D('2026-08-17T10:00:00Z'), 'quarter'), '2026-Q3');
  assert.equal(periodOf(D('2026-01-31T23:59:59Z'), 'month'), '2026-01');
  assert.deepEqual(periodsBetween(D('2025-11-15Z'), D('2026-02-02Z'), 'month'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(periodsBetween(D('2026-01-01Z'), D('2026-12-01Z'), 'quarter'), ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
});

test('toDate handles seconds, milliseconds and ISO', () => {
  assert.equal(toDate(1794746282).toISOString(), toDate(1794746282000).toISOString());
  assert.equal(toDate('2026-10-21T14:28:49.567Z').getTime(), Date.UTC(2026, 9, 21, 14, 28, 49, 567));
  assert.equal(toDate(null), null);
  assert.throws(() => toDate('not a date'));
});

test('overlapping and touching intervals merge; clipping to the window', () => {
  const r = mergeClip([
    { start: D('2026-10-01T00:00Z'), end: D('2026-10-01T01:00Z') },
    { start: D('2026-10-01T00:30Z'), end: D('2026-10-01T02:00Z') },
    { start: D('2026-10-01T02:00Z'), end: D('2026-10-01T02:10Z') },
    { start: D('2026-09-30T23:00Z'), end: D('2026-10-01T00:20Z') },
  ], D('2026-10-01T00:00Z'), D('2026-11-01T00:00Z'));
  assert.equal(r.minutes, 130);
  assert.equal(r.spans.length, 1);
  assert.equal(mergeClip([{ start: D('2026-09-01Z'), end: D('2026-09-02Z') }], D('2026-10-01Z'), D('2026-11-01Z')).minutes, 0);
});

test('incident crossing a month boundary counts only its part in each month', () => {
  const inc = [{ id: 'a', name: 'x', impact: 'major', start: D('2026-09-30T23:00Z'), end: D('2026-10-01T01:00Z') }];
  const sel = vendorWideSelector({ levels: ['major', 'critical'] });
  assert.equal(evaluatePeriod(inc, '2026-09', sel).covered_minutes, 60);
  assert.equal(evaluatePeriod(inc, '2026-10', sel).covered_minutes, 60);
});

test('uptime percentage and out-of-scope reasons', () => {
  const inc = [
    { id: 'a', name: 'big', impact: 'major', start: D('2026-10-05T00:00Z'), end: D('2026-10-05T04:28Z') },
    { id: 'b', name: 'small', impact: 'minor', start: D('2026-10-06T00:00Z'), end: D('2026-10-06T05:00Z') },
    { id: 'c', name: 'planned', impact: 'major', scheduled: true, start: D('2026-10-07T00:00Z'), end: D('2026-10-07T05:00Z') },
  ];
  const r = evaluatePeriod(inc, '2026-10', vendorWideSelector({ levels: ['major', 'critical'] }));
  assert.equal(r.covered_minutes, 268);
  assert.equal(r.uptime_pct, 99.3996);
  assert.deepEqual(r.incidents.map((i) => i.in_scope), [true, false, false]);
  assert.match(r.incidents[2].reason, /scheduled/);
});

test('statuspage component windows come from the update stream', () => {
  const i = normalizeStatuspageIncident('x', {
    id: 'abc', name: 'Outage', impact: 'major', created_at: '2026-10-01T10:00:00Z', resolved_at: '2026-10-01T12:00:00Z',
    components: [{ id: 'c1', name: 'API' }, { id: 'c2', name: 'Web' }],
    incident_updates: [
      { created_at: '2026-10-01T10:05:00Z', affected_components: [{ code: 'c1', name: 'API', old_status: 'operational', new_status: 'partial_outage' }] },
      { created_at: '2026-10-01T10:30:00Z', affected_components: [{ code: 'c1', name: 'API', old_status: 'partial_outage', new_status: 'major_outage' }, { code: 'c2', name: 'Web', old_status: 'operational', new_status: 'degraded_performance' }] },
      { created_at: '2026-10-01T11:00:00Z', affected_components: [{ code: 'c1', name: 'API', old_status: 'major_outage', new_status: 'operational' }] },
    ],
  });
  assert.equal(i.component_windows.length, 1);
  assert.equal(i.component_windows[0].component, 'API');
  assert.equal(i.component_windows[0].status, 'major_outage');
  assert.equal((i.component_windows[0].end - i.component_windows[0].start) / 60000, 55);
});

test('azure impact window sentences in every wording seen', () => {
  const cases = [
    ['Between 20:30 UTC on 30 September 2026 and 02:15 UTC on 1 October 2026, customers', '2026-09-30T20:30:00.000Z', '2026-10-01T02:15:00.000Z'],
    ['Between 10:03 UTC and 15:58 UTC on 29 September 2026, a platform issue', '2026-09-29T10:03:00.000Z', '2026-09-29T15:58:00.000Z'],
    ['Between 14:44 and 19:41 UTC on 23 July 2026, a subset', '2026-07-23T14:44:00.000Z', '2026-07-23T19:41:00.000Z'],
    ['Between 04:24 UTC on 29 May and 02:30 UTC on 30 May 2026, customers', '2026-05-29T04:24:00.000Z', '2026-05-30T02:30:00.000Z'],
    ['Between 07:58 UTC and approximately 09:45 UTC on 07 February 2026, customers', '2026-02-07T07:58:00.000Z', '2026-02-07T09:45:00.000Z'],
  ];
  for (const [t, s, e] of cases) {
    const w = parseAzureWindow(t);
    assert.equal(w.start.toISOString(), s, t);
    assert.equal(w.end.toISOString(), e, t);
  }
  assert.equal(parseAzureWindow('Between 11:04 and 14:13 EST on 08 December 2025'), null);
});

test('aws per-service windows from status changes; region parsed from key', () => {
  const data = { 'multipleservices-us-east-1': [{
    summary: 'Increased errors', arn: 'arn:aws:health:us-east-1::event/X', status: '1', date: '1794746282',
    event_log: [{ timestamp: 1794746282, status: '1' }, { timestamp: 1794754409, status: '0' }],
    impacted_services: { 'elb-us-east-1': { service_name: 'Amazon Elastic Load Balancing', max: '2' } },
    impacted_service_status_changes: [
      { service: 'elb-us-east-1', current_status: '2', timestamp: 1794746282000 },
      { service: 'elb-us-east-1', current_status: '0', timestamp: 1794749882000 },
    ],
  }] };
  const [r] = normalizeAws('aws', data);
  assert.equal(r.service_key, 'elb');
  assert.deepEqual(r.locations, ['us-east-1']);
  assert.equal(r.event_region, 'us-east-1');
  assert.equal((r.windows[0].end - r.windows[0].start) / 60000, 60);
});

test('gcp products and locations', () => {
  const r = normalizeGcp('gcp', { id: 'i1', begin: '2026-08-20T15:40:00+00:00', end: '2026-08-20T19:20:00+00:00', severity: 'high', external_desc: 'x',
    affected_products: [{ title: 'Google Compute Engine' }], previously_affected_locations: [{ id: 'global' }, { id: 'us-west1' }], currently_affected_locations: [], uri: 'incidents/i1' });
  assert.deepEqual(r.services, ['Google Compute Engine']);
  assert.deepEqual(r.locations, ['global', 'us-west1']);
  assert.equal((r.end - r.start) / 60000, 220);
});

test('archive keeps bytes, hashes them, and refuses a file changed on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-'));
  const a = new Archive(dir);
  const rec = a.save('github', 'incident-1.json', '{"a":1}');
  assert.equal(rec.sha256, '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  assert.equal(a.read(rec).toString(), '{"a":1}');
  const h = a.dailyHashList(rec.fetched_at.slice(0, 10));
  assert.equal(h.lines.length, 1);
  fs.writeFileSync(path.join(dir, 'archive', rec.path), 'tampered');
  assert.throws(() => a.read(rec), /changed on disk/);
});
