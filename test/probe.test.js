import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-probe-'));
process.env.MONEYOWED_DATA = tmp;
fs.mkdirSync(path.join(tmp, 'incidents'), { recursive: true });
fs.cpSync(path.join(here, '..', 'data', 'sla'), path.join(tmp, 'sla'), { recursive: true });

const { isPrivateAddress, targetFrom, vendorFor, answerUptime, answerApiHealth, liveOpenIncidents } = await import('../src/probe.js');

test('private and internal addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '140.82.112.3', '2606:4700::1111', '172.32.0.1'])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test('the address is read from a url field or from free text', () => {
  assert.equal(targetFrom({ url: 'https://api.github.com/zen' }).url, 'https://api.github.com/zen');
  assert.equal(targetFrom({ question: 'Is https://example.com/health up right now?' }).url, 'https://example.com/health');
  assert.equal(targetFrom({ question: 'is api.stripe.com up?' }).url, 'https://api.stripe.com');
  assert.equal(targetFrom({ question: 'is my server up?' }).url, null);
});

test('vendor is found from the host', () => {
  assert.equal(vendorFor('https://api.github.com'), 'github');
  assert.equal(vendorFor('https://foo.atlassian.net/x'), 'jira');
  assert.equal(vendorFor('https://example.com'), null);
});

test('private addresses are refused before any connection, with no status guessed', async () => {
  for (const url of ['http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/', 'http://10.0.0.5/health']) {
    for (const fn of [answerUptime, answerApiHealth]) {
      const a = await fn({ url });
      assert.equal(a.status, 'not_checked', `${fn.name} ${url}`);
      assert.equal(a.is_up, null); assert.equal(a.status_code, null);
      assert.match(a.summary, /NOT CHECKED/);
    }
  }
});

test('no address: not checked, nothing guessed', async () => {
  const a = await answerUptime({ question: 'is my server up?' });
  assert.equal(a.status, 'not_checked'); assert.equal(a.is_up, null);
});

test('live status page: unresolved incidents are read, scheduled ones dropped, failures fall back', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ incidents: [
    { name: 'Degraded Jira search', status: 'investigating', started_at: '2026-11-25T10:00:00Z', impact: 'minor', shortlink: 'https://stspg.io/x' },
    { name: 'Planned work', status: 'scheduled' },
  ] }) });
  const live = await liveOpenIncidents('jira', { fetchImpl: fake });
  assert.deepEqual(live.map((i) => i.name), ['Degraded Jira search']);
  const failing = async () => { throw new Error('offline'); };
  assert.equal(await liveOpenIncidents('confluence', { fetchImpl: failing }), null);
  assert.equal(await liveOpenIncidents('aws', { fetchImpl: fake }), null);
});

test('uptime view: verdict first, sla block agrees with every field, history below target is a breach', async () => {
  const { uptimeView } = await import('../src/probe.js');
  const base = { status: 'checked', url: 'https://api.github.com', service: 'GitHub', is_up: true, status_code: 200, latency_ms: 40, check: { result: 'up', reasons: [] }, vendor_status: { open_incidents: [] } };
  const met = uptimeView({ ...base, uptime_pct: 99.95, sla_target_pct: 99.9 });
  assert.deepEqual(Object.keys(met), ['url', 'is_up', 'status_code', 'latency_ms', 'error', 'summary', 'sla', 'service', 'period', 'uptime_pct', 'sla_target_pct', 'compliant', 'data_source']);
  assert.equal(met.compliant, true); assert.equal(met.sla.breached, false); assert.match(met.summary, /is UP: HTTP 200/);
  const low = uptimeView({ ...base, uptime_pct: 99.5, sla_target_pct: 99.9 });
  assert.equal(low.compliant, false); assert.equal(low.sla.breached, true); assert.match(low.summary, /is UP:/);
  const down = uptimeView({ ...base, service: 'x.com', is_up: false, status_code: 503, check: { result: 'down', reasons: ['HTTP 503'] }, vendor_status: undefined });
  assert.equal(down.uptime_pct, 0); assert.equal(down.period, 'instant (single live check)'); assert.equal(down.compliant, false); assert.match(down.summary, /DOWN/);
  const inc = uptimeView({ ...base, vendor_status: { open_incidents: [{ name: 'x' }] } });
  assert.match(inc.summary, /UP, DEGRADED/); assert.equal(inc.sla.breached, true);
  const nc = uptimeView({ status: 'not_checked', url: null, service: 'is my server up?', summary: 'is my server up?: UPTIME NOT CHECKED.', check: { reasons: ['no address was given to check'] } });
  assert.equal(nc.is_up, null); assert.equal(nc.uptime_pct, null); assert.equal(nc.compliant, null); assert.equal(nc.sla.breached, null);
});

test('api health default view drops only repeated fields', async () => {
  const { apiHealthView } = await import('../src/probe.js');
  const full = { summary: 's', check: { result: 'healthy', reasons: [], summary: 'HEALTHY' }, url: 'https://a.example', healthy: true, latency_ms: 10, ttfb_ms: 10,
    json: { valid: true, type: 'object', keys: ['a'] }, final_url: 'https://a.example', redirects: 0, status: 'checked' };
  const v = apiHealthView(full);
  assert.deepEqual(Object.keys(v), ['summary', 'check', 'url', 'healthy', 'latency_ms', 'json', 'status']);
  assert.deepEqual(v.check, { result: 'healthy', reasons: [] });
  assert.deepEqual(v.json, { valid: true, type: 'object' });
  assert.equal(full.check.summary, 'HEALTHY');   // the full answer is not changed
  const moved = apiHealthView({ ...full, ttfb_ms: 4, final_url: 'https://b.example', redirects: 1 });
  assert.equal(moved.ttfb_ms, 4); assert.equal(moved.final_url, 'https://b.example'); assert.equal(moved.redirects, 1);
});
