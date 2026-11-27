import test from 'node:test';
import assert from 'node:assert/strict';
import { periods, termsOf, diffTerms, runWatch, Budget, DEFAULTS } from '../src/watch.js';

const card = (over = {}) => ({
  vendor: 'vercel', name: 'Vercel', sla_url: 'https://vercel.com/legal/sla',
  sla_texts: [{ file: 'vercel.txt', sha256: 'aaa' }],
  plans: [{ plan: 'enterprise', label: 'Vercel Enterprise', period: 'month', threshold: 99.99, tiers: [[99.99, 10]], claim: { days_after_eligible: 30, quote: 'you must notify Vercel' } }],
  ...over,
});
const owed = (period, days_left = 20) => ({ id: `id-${period}`, code: 'OWED', vendor_name: 'Vercel', plan_label: 'Vercel Enterprise', period, credit_usd_total: 200, last_day: '2026-11-05', last_day_later: '2026-11-30', days_left,
  services: [{ service: 'Vercel Services', uptime_pct: 99.96, threshold_pct: 99.99, covered_minutes: 15.8, allowed_minutes: 4.4, credit_pct: 10, credit_usd: 200 }], owed_services: ['Vercel Services'] });
const notOwed = (period) => ({ id: `id-${period}`, code: 'NOT_OWED', period, services: [], owed_services: [] });

function io({ cardFn = () => card(), check = (b) => notOwed(b.period), buy = null } = {}) {
  const calls = [];
  return { calls, getJson: async () => cardFn(), postJson: async (_p, b) => { calls.push(b.period); return check(b); }, buy };
}
const cfg = { ...DEFAULTS, vendors: [{ vendor: 'vercel', spend: 2000 }] };
const NOW = new Date('2026-11-27T12:00:00Z');

test('periods: months and quarters, running one and the two closed before it', () => {
  assert.deepEqual(periods('month', NOW), { open: '2026-11', closed: ['2026-10', '2026-09'] });
  assert.deepEqual(periods('month', new Date('2026-01-03T00:00:00Z')), { open: '2026-01', closed: ['2025-12', '2025-11'] });
  assert.deepEqual(periods('quarter', NOW), { open: '2026-Q4', closed: ['2026-Q3', '2026-Q2'] });
  assert.deepEqual(periods('quarter', new Date('2026-02-01T00:00:00Z')), { open: '2026-Q1', closed: ['2025-Q4', '2025-Q3'] });
});

test('terms ignore quoted wording but catch a changed number', () => {
  const a = termsOf(card(), 'enterprise');
  const b = termsOf(card({ plans: [{ ...card().plans[0], claim: { days_after_eligible: 30, quote: 'reworded' } }] }), 'enterprise');
  assert.deepEqual(diffTerms(a, b), []);
  const c = termsOf(card({ plans: [{ ...card().plans[0], claim: { days_after_eligible: 15 } }] }), 'enterprise');
  assert.deepEqual(diffTerms(a, c), [{ field: 'enterprise.claim.days_after_eligible', before: 30, after: 15 }]);
});

test('first run introduces itself and reports an owed credit once', async () => {
  const st = { baseline: {}, notified: {}, spend: {}, runs: [] };
  const x = io({ check: (b) => (b.period === '2026-10' ? owed('2026-10') : notOwed(b.period)) });
  const r1 = await runWatch(cfg, st, x, { now: NOW });
  assert.match(r1.text, /now watching: vercel/);
  assert.match(r1.text, /Vercel owes you \$200 for 2026-10/);
  assert.match(r1.text, /moneyowed claim id-2026-10/);
  assert.deepEqual(x.calls, ['2026-10', '2026-09', '2026-11']);
  const r2 = await runWatch(cfg, st, x, { now: NOW });
  assert.equal(r2.text, '', 'nothing new: silent');
});

test('one reminder when the claim window gets close, never right after the first message', async () => {
  const st = { baseline: {}, notified: {}, spend: {}, runs: [] };
  let days = 20;
  const x = io({ check: (b) => (b.period === '2026-10' ? owed('2026-10', days) : notOwed(b.period)) });
  await runWatch(cfg, st, x, { now: NOW });
  days = 4;
  const r2 = await runWatch(cfg, st, x, { now: NOW });
  assert.match(r2.text, /^Reminder: Vercel owes you/);
  const r3 = await runWatch(cfg, st, x, { now: NOW });
  assert.equal(r3.text, '');
  // first seen already close to the deadline: no reminder on the next run
  const st2 = { baseline: {}, notified: {}, spend: {}, runs: [] };
  await runWatch(cfg, st2, x, { now: NOW });
  assert.equal((await runWatch(cfg, st2, x, { now: NOW })).text, '');
});

test('a running period already missed is reported once', async () => {
  const st = { baseline: {}, notified: {}, spend: {}, runs: [] };
  const open = { id: 'o', code: 'PERIOD_OPEN', period: '2026-11', owed_services: ['Vercel Services'], services: [{ service: 'Vercel Services', covered_minutes: 30, allowed_minutes: 4.4, credit_pct: 10, credit_usd: 200 }] };
  const x = io({ check: (b) => (b.period === '2026-11' ? open : notOwed(b.period)) });
  const r1 = await runWatch(cfg, st, x, { now: NOW });
  assert.match(r1.text, /2026-11 is already missed, and the period is still running/);
  assert.match(r1.text, /30 min of counted outage so far, 4.4 allowed/);
  assert.equal((await runWatch(cfg, st, x, { now: NOW })).text, '');
});

test('changed terms are reported; reworded text with the same terms is not', async () => {
  const st = { baseline: {}, notified: {}, spend: {}, runs: [] };
  let c = card();
  const x = io({ cardFn: () => c });
  await runWatch(cfg, st, x, { now: NOW });
  c = card({ sla_texts: [{ file: 'vercel.txt', sha256: 'bbb' }], plans: [{ ...card().plans[0], claim: { days_after_eligible: 30, quote: 'new words' } }] });
  const r2 = await runWatch(cfg, st, x, { now: NOW });
  assert.equal(r2.text, '');
  assert.match(r2.notes.join(), /wording changed, the terms you get are the same/);
  c = card({ plans: [{ ...card().plans[0], claim: { days_after_eligible: 15 } }] });
  const r3 = await runWatch(cfg, st, x, { now: NOW });
  assert.match(r3.text, /Vercel Enterprise: the terms of the SLA changed/);
  assert.match(r3.text, /claim.days_after_eligible: 30 -> 15/);
  assert.equal((await runWatch(cfg, st, x, { now: NOW })).text, '', 'reported once');
});

test('a failed check is never silent', async () => {
  const st = { baseline: {}, notified: {}, spend: {}, runs: [] };
  await runWatch(cfg, st, io(), { now: NOW });
  const x = io({ check: () => { throw new Error('HTTP 502'); } });
  const r = await runWatch(cfg, st, x, { now: NOW });
  assert.match(r.text, /Could not check these 3 today, will try again next run/);
  assert.match(r.text, /Vercel Enterprise 2026-10 \(HTTP 502\)/);
});

test('Telegraph evidence is bought once per owed credit and shown with its cost', async () => {
  const st = { baseline: {}, notified: {}, spend: {}, runs: [] };
  let buys = 0;
  const buy = async (_r, budget) => {
    buys++;
    budget.record({ cost_usd: 0.01 }); budget.record({ cost_usd: 0.01 });
    return { sla: { opinions: [{ cost_usd: 0.01, agrees: true, label: 'Telegraph routing (auto)' }, { cost_usd: 0.01, agrees: true, label: 'our scoped SLA miner' }] }, terms: { opinions: [] } };
  };
  const x = io({ check: (b) => (b.period === '2026-10' ? owed('2026-10') : notOwed(b.period)), buy });
  const r = await runWatch(cfg, st, x, { now: NOW });
  assert.match(r.text, /Telegraph: 2 answers bought for \$0.02; 2 of 2 SLA answers agree it was missed \(one seller is MONEY OWED's own miner\)/);
  assert.equal(st.spend['2026-11'], 0.02);
  await runWatch(cfg, st, x, { now: NOW });
  assert.equal(buys, 1);
});

test('budget: per run and per month limits feed the Telegraph spending check', () => {
  const b = new Budget({ perRun: 0.05, perMonth: 0.2, spentThisMonth: 0.17 });
  b.record({ cost_usd: 0.02 });
  assert.equal(b.spentToday('run'), 0.02);
  assert.equal(Math.round(b.spentToday(null) * 100) / 100, 0.19);
});
