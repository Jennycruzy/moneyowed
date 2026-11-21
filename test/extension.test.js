import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(new URL('../extension/parse.js', import.meta.url), 'utf8'), ctx);
const { parse } = ctx.module.exports;
const TODAY = new Date('2026-11-21T00:00:00Z');

test('invoice email: vendor from sender, period from text, total due', () => {
  const r = parse({ from: 'billing@sanity.io', subject: 'Your Sanity invoice for October 2026', body: 'Invoice\nGrowth plan\nSubtotal $1,800.00\nTax $200.00\nTotal due: $2,000.00' }, TODAY);
  assert.equal(r.vendor, 'sanity'); assert.equal(r.period, '2026-10'); assert.equal(r.spend, 2000);
});
test('GitHub invoices map to the quarter', () => {
  const r = parse({ from: 'noreply@github.com', subject: '[GitHub] Payment receipt', body: 'GitHub Enterprise\nBilling period Aug 1, 2026 - Aug 31, 2026\nTotal $6,300.00' }, TODAY);
  assert.equal(r.vendor, 'github'); assert.equal(r.period, '2026-Q3'); assert.equal(r.spend, 6300);
});
test('Atlassian product is read from the text', () => {
  assert.equal(parse({ from: 'noreply@atlassian.com', subject: 'Confluence Premium invoice', body: 'Invoice date 2026-10-03 Amount due $450.00' }, TODAY).vendor, 'confluence');
  assert.equal(parse({ from: 'noreply@atlassian.com', subject: 'Jira invoice', body: 'September 2026 Amount due $90.00' }, TODAY).period, '2026-09');
});
test('no period in the email: the month before today', () => {
  assert.equal(parse({ from: 'invoices@vercel.com', subject: 'Receipt', body: 'Total $20.00' }, TODAY).period, '2026-10');
});
test('other senders are ignored', () => {
  assert.equal(parse({ from: 'friend@example.com', subject: 'lunch', body: 'GitHub is down lol $5.00' }, TODAY), null);
});
