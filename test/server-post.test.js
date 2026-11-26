import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MONEYOWED_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'moneyowed-post-'));
process.env.PORT = String(20000 + Math.floor(Math.random() * 20000));
delete process.env.TELEGRAPH_PRIVATE_KEY;
const { default: server } = await import('../src/server.js');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://127.0.0.1:${process.env.PORT}`;
after(() => server.close());

const contract = 'The Provider will make the Service available 99.9% of the time each calendar month. If Monthly Uptime falls below 99.9%, Customer may claim a credit of 10% of monthly fees by emailing support within 30 days.';

async function post(p, body, type) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': type }, body });
  assert.equal(r.status, 200);
  return r.json();
}

test('contract POST reads the contract from JSON, a form and plain text', async () => {
  const get = await (await fetch(`${base}/miner/contract?contract=${encodeURIComponent(contract)}`)).json();
  assert.ok(get.obligations.length >= 2);
  for (const [body, type] of [
    [JSON.stringify({ contract }), 'application/json'],
    [new URLSearchParams({ contract }).toString(), 'application/x-www-form-urlencoded'],
    [contract, 'text/plain'],
  ]) {
    const a = await post('/miner/contract', body, type);
    assert.equal(a.verdict, get.verdict, type);
    assert.deepEqual(a.obligations, get.obligations, type);
  }
});

test('SLA POST reads its question from a JSON body', async () => {
  const question = 'Did GitHub meet its SLA for Actions in 2026-09?';
  const get = await (await fetch(`${base}/miner/sla?question=${encodeURIComponent(question)}`)).text();
  const a = await post('/miner/sla', JSON.stringify({ question }), 'application/json');
  const strip = (o) => JSON.stringify(o, (k, v) => (/(_at|_ms|latency|elapsed)$/.test(k) ? undefined : v));
  assert.equal(strip(a), strip(JSON.parse(get)));
});
