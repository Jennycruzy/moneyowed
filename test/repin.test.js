import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { repinCards, checkCard } from '../src/cards.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-'));
  const sla = path.join(root, 'sla'), cards = path.join(root, 'cards');
  fs.mkdirSync(sla); fs.mkdirSync(cards);
  const src = path.resolve('cards/sanity.json');
  const card = JSON.parse(fs.readFileSync(src, 'utf8'));
  const text = fs.readFileSync(path.resolve('data/sla/sanity.txt'), 'utf8');
  fs.writeFileSync(path.join(sla, 'sanity.txt'), text);
  card.sla_texts = [{ file: 'sanity.txt', sha256: sha(text) }];
  fs.writeFileSync(path.join(cards, 'sanity.json'), JSON.stringify(card));
  return { sla, cards, text };
}

test('a changed page that still holds every quote is pinned to the new text, old hash kept', () => {
  const { sla, cards, text } = setup();
  const old = sha(text);
  fs.writeFileSync(path.join(sla, 'sanity.txt'), text + ' Footer updated.');
  const r = repinCards(sla, { dir: cards, today: '2026-11-25' });
  assert.deepEqual(r, [{ vendor: 'sanity', repinned: true }]);
  const card = JSON.parse(fs.readFileSync(path.join(cards, 'sanity.json'), 'utf8'));
  assert.equal(card.sla_texts[0].sha256, sha(text + ' Footer updated.'));
  assert.deepEqual(card.sla_texts[0].history, [{ sha256: old, replaced: '2026-11-25' }]);
  const { problems, warnings } = checkCard(card, sla, { withWarnings: true });
  assert.equal(problems.length, 0); assert.equal(warnings.length, 0);
});

test('a changed page that lost a quoted term is not pinned, so its checks stay stopped', () => {
  const { sla, cards, text } = setup();
  fs.writeFileSync(path.join(sla, 'sanity.txt'), text.replace('within thirty (30) days', 'within fifteen (15) days'));
  const r = repinCards(sla, { dir: cards });
  assert.equal(r[0].repinned, false);
  const card = JSON.parse(fs.readFileSync(path.join(cards, 'sanity.json'), 'utf8'));
  assert.equal(card.sla_texts[0].sha256, sha(text));
});
