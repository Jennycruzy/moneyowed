// Checks every rule card against the SLA texts it was written from. Exit code 1 if any card fails.
import path from 'node:path';
import { listCards, checkCard } from '../src/cards.js';

const slaDir = path.resolve(process.env.MONEYOWED_DATA || 'data', 'sla');
let bad = 0;
for (const card of listCards()) {
  const { problems, warnings } = checkCard(card, slaDir, { withWarnings: true });
  warnings.forEach((w) => console.log(`note ${card.vendor}: ${w}`));
  const n = card.plans.reduce((t, p) => t + p.services.length, 0);
  if (problems.length) { bad++; console.log(`FAIL ${card.vendor} (${n} services)`); problems.forEach((p) => console.log(`   - ${p}`)); }
  else console.log(`ok   ${card.vendor} (${card.plans.length} plan(s), ${n} services)`);
}
process.exitCode = bad ? 1 : 0;
