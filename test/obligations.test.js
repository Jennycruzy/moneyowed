import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerObligations, obligationsView, deadlineIn, extract } from '../src/obligations.js';

test('lists who owes what by when, with the clause, and stays Unclear without facts', async () => {
  const a = await answerObligations({ contract: 'In order to receive a service credit, Subscriber must notify Sanity (mailto:sla.support@sanity.io) within thirty (30) days from the missed Availability Commitment. The notice shall include "SLA Credit Request" in the subject line.' });
  assert.equal(a.verdict, 'Unclear');
  assert.match(a.obligations[0], /^MUST \| Subscriber \| must notify Sanity/);
  assert.match(a.obligations[0], /by: within 30 days from the missed Availability Commitment/);
  assert.match(a.obligations[0], /condition: in order to receive a service credit/);
  assert.equal(a.clauses.length, a.obligations.length);
});

test('a payment made after the deadline is Non-compliant, and names the breached clause', async () => {
  const a = await answerObligations({ contract: 'Buyer shall pay each invoice within 30 days of receipt. Buyer paid the invoice 45 days after receipt.' });
  assert.equal(a.verdict, 'Non-compliant');
  assert.match(a.summary, /Breached: "shall pay each invoice within 30 days of receipt"/);
});

test('a delivery after a dated deadline is a breach; one on time is not', async () => {
  const late = await answerObligations({ contract: 'Supplier shall deliver 500 units by 15 March 2026. Supplier delivered the units on 20 March 2026.' });
  assert.equal(late.verdict, 'Non-compliant');
  const ok = await answerObligations({ contract: 'Supplier shall deliver 500 units by 15 March 2026. Supplier delivered the units on 10 March 2026.' });
  assert.equal(ok.verdict, 'Compliant');
});

test('"X will receive" puts the duty on the payer; "may" is a right; "shall not" a prohibition', () => {
  const items = extract('Winners will receive their prize within 30 days of the announcement. The organizer may withhold payment if KYC is not completed. Licensee shall not sublicense the Software.');
  assert.equal(items[0].party, 'the paying party (owed to Winners)');
  assert.equal(items[1].kind, 'right');
  assert.equal(items[2].kind, 'prohibition');
});

test('deadlines in words and numbers', () => {
  assert.equal(deadlineIn('must notify within thirty (30) days from the miss').amount, 30);
  assert.equal(deadlineIn('shall pay no later than 5 business days after delivery').unit, 'business days');
  assert.equal(deadlineIn('deliver by 15 March 2026').kind, 'date');
});

test('no text, or a private link, is answered as not audited with a reason, never an error', async () => {
  const a = await answerObligations({});
  assert.equal(a.verdict, 'Unclear');
  assert.match(a.summary, /^CONTRACT NOT AUDITED/);
  const b = await answerObligations({ contract: 'http://169.254.169.254/latest/meta-data' });
  assert.match(b.summary, /private or internal/);
  assert.deepEqual(Object.keys(obligationsView(a)), ['verdict', 'obligations', 'clauses', 'summary']);
});

import { compareTerms } from '../src/evidence.js';
test('a bought contract answer agrees only when it gives the same claim window and destination', () => {
  const terms = { days: 30, where: 'sla.support@sanity.io' };
  const good = compareTerms({ status: 200, answer: { verdict: 'Unclear', obligations: ['MUST | Subscriber | must notify Sanity (sla.support@sanity.io) within 30 days'], summary: '' }, cost_usd: 0.01, latency_ms: 300 }, terms);
  assert.equal(good.agrees, true);
  const generic = compareTerms({ status: 200, answer: { verdict: 'Compliant', obligations: ['Standard Contract Terms'], clauses: ['Standard Contract Terms'], summary: 'all obligations are met' }, cost_usd: 0.01, latency_ms: 300 }, terms);
  assert.equal(generic.agrees, false);
  assert.deepEqual(generic.notes, ['does not give the 30-day claim window', 'does not say where the claim goes (sla.support@sanity.io)']);
  const failed = compareTerms({ status: 502, error: 'timeout', cost_usd: 0, latency_ms: 9000 }, terms);
  assert.equal(failed.agrees, null);
});
