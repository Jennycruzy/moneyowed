// Build data/record.json: every covered vendor x every full period in the held history x every service.
import fs from 'node:fs';
import path from 'node:path';
import { listCards } from '../src/cards.js';
import { checkCredit } from '../src/engine.js';
import { periodsBetween } from '../src/lib/time.js';

const DATA = path.resolve(process.env.MONEYOWED_DATA || 'data');
const REGIONS = { aws: ['us-east-1', 'eu-west-1'], gcp: ['us-central1', 'europe-west1'], azure: ['East US', 'West Europe'] };
const now = new Date();
const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
const rows = [], skipped = [];
for (const card of listCards()) {
  for (const plan of card.plans) {
    for (const period of periodsBetween(from, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), plan.period)) {
      try {
        const r = checkCredit({ vendor: card.vendor, plan: plan.plan, period, regions: plan.per_region ? REGIONS[card.vendor] : undefined, now });
        if (r.code === 'PERIOD_OPEN') continue;
        for (const s of r.services) rows.push({
          period, vendor: card.vendor, vendor_name: card.name, plan: plan.plan, plan_label: plan.label, service: s.service,
          uptime_pct: s.uptime_pct, threshold_pct: s.threshold_pct, covered_minutes: s.covered_minutes, credit_pct: s.credit_pct,
          owed: s.credit_pct > 0, deadline: s.credit_pct > 0 ? r.deadline : null, period_end: r.period_end, incidents_counted: s.incidents.filter((i) => i.in_scope).length,
          regions: r.regions,
        });
      } catch (e) { skipped.push({ vendor: card.vendor, plan: plan.plan, period, code: e.code, reason: e.message }); }
    }
  }
}
const out = { built_at: now.toISOString(), regions: REGIONS, rows, skipped };
fs.writeFileSync(path.join(DATA, 'record.json'), JSON.stringify(out, null, 1));
const owed = rows.filter((r) => r.owed);
console.log(`${rows.length} vendor-period-services, ${owed.length} owed, ${skipped.length} skipped`);
const byV = {};
for (const r of owed) byV[r.vendor] = (byV[r.vendor] || 0) + 1;
console.log(byV);
for (const s of skipped.slice(0, 8)) console.log('skipped', s.vendor, s.period, s.code, s.reason.slice(0, 100));
