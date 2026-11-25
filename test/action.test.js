import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVendors, lastClosed } from '../action/run.mjs';

test('vendor lines: vendor, optional plan, optional monthly bill', () => {
  assert.deepEqual(parseVendors('jira:premium=1200\n# a comment\ngithub, vercel=$3000'), [
    { vendor: 'jira', plan: 'premium', spend: 1200 }, { vendor: 'github', plan: undefined, spend: undefined }, { vendor: 'vercel', plan: undefined, spend: 3000 },
  ]);
  assert.throws(() => parseVendors('jira premium'), /cannot read vendor line/);
});

test('default period is the last closed month or quarter', () => {
  assert.equal(lastClosed('month', new Date('2026-11-25T00:00:00Z')), '2026-10');
  assert.equal(lastClosed('month', new Date('2026-01-03T00:00:00Z')), '2025-12');
  assert.equal(lastClosed('quarter', new Date('2026-11-25T00:00:00Z')), '2026-Q3');
  assert.equal(lastClosed('quarter', new Date('2026-02-01T00:00:00Z')), '2025-Q4');
});
