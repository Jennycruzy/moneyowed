import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-proof-'));
process.env.MONEYOWED_DATA = tmp;
fs.cpSync(path.join(here, '..', 'data', 'sla'), path.join(tmp, 'sla'), { recursive: true });

const { Archive } = await import('../src/archive.js');
const { normalizeStatuspageIncident } = await import('../src/sources/statuspage.js');
const { writeIncidents } = await import('../src/store.js');
const { checkCredit } = await import('../src/engine.js');
const { buildProof, verifyProof } = await import('../src/proof.js');

test('a proof recomputes offline from archived vendor records, and any edit is caught', async () => {
  const a = new Archive();
  const raw = { incident: { id: 'abc', name: 'Jira unavailable', impact: 'major', started_at: '2026-06-10T10:00:00Z', created_at: '2026-06-10T10:00:00Z', resolved_at: '2026-06-10T12:00:00Z',
    components: [{ id: 'c1', name: 'Viewing content', group_id: null }],
    incident_updates: [
      { status: 'investigating', created_at: '2026-06-10T10:00:00Z', affected_components: [{ code: 'c1', name: 'Viewing content', old_status: 'operational', new_status: 'major_outage' }] },
      { status: 'resolved', created_at: '2026-06-10T12:00:00Z', affected_components: [{ code: 'c1', name: 'Viewing content', old_status: 'major_outage', new_status: 'operational' }] },
    ] } };
  const rec = a.save('jira', 'incident-abc.json', JSON.stringify(raw));
  const comp = a.save('jira', 'components.json', JSON.stringify({ components: [{ id: 'c1', name: 'Viewing content' }] }));
  writeIncidents('jira', { source: 'statuspage', coverage_from: '2025-10-01T00:00:00.000Z', components: [{ id: 'c1', name: 'Viewing content', group: false, group_id: null }],
    incidents: [normalizeStatuspageIncident('jira', raw.incident, rec.sha256, 'jira-software.status.atlassian.com')] });
  assert.ok(comp.sha256);
  const r = JSON.parse(JSON.stringify(checkCredit({ vendor: 'jira', period: '2026-06', spend: 1000, now: '2026-07-02T00:00:00Z' })));
  assert.equal(r.services[0].covered_minutes, 120);
  const p = buildProof({ spend: 1000 }, r);
  const ok = await verifyProof(JSON.parse(JSON.stringify(p)));
  assert.ok(ok.ok, JSON.stringify(ok.checks.filter((c) => !c.ok)));

  const edited = JSON.parse(JSON.stringify(p)); edited.stated.services[0].credit_pct = 50;
  assert.equal((await verifyProof(edited)).ok, false);
  const forged = JSON.parse(JSON.stringify(p));
  const d = JSON.parse(Buffer.from(forged.raw[0].base64, 'base64')); d.incident.resolved_at = '2026-06-10T18:00:00Z';
  forged.raw[0].base64 = Buffer.from(JSON.stringify(d)).toString('base64');
  const fv = await verifyProof(forged);
  assert.equal(fv.ok, false);
  assert.ok(fv.checks.some((c) => !c.ok && /sha256/.test(c.name)));
});
