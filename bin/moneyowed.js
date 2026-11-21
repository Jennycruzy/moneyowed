#!/usr/bin/env node
// MONEY OWED command line.
//   moneyowed check <vendor> <period> [--plan p] [--spend 6000] [--region us-east-1] [--api https://...]
//   moneyowed verify <proof.json>        recompute a downloaded proof offline, no network
//   moneyowed vendors [--api https://...]
import fs from 'node:fs';

const API = 'https://moneyowed.38-49-216-59.sslip.io';
const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]; else args.push(rest[i]); }
const api = flags.api || process.env.MONEYOWED_API || API;
const mark = (ok) => (ok ? '  ok ' : ' FAIL');

async function main() {
  if (cmd === 'verify') {
    if (!args[0]) return usage();
    const { verifyProof } = await import('../src/proof.js');
    const proof = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    console.log(`Recomputing ${proof.card?.name} ${proof.input?.period} from the records inside the proof (no network)...`);
    const v = await verifyProof(proof);
    for (const c of v.checks) console.log(`${mark(c.ok)}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    console.log(v.ok ? '\nVERIFIED: same verdict, uptime, minutes, credit and deadline as stated.' : '\nNOT VERIFIED: see the FAIL lines above.');
    process.exit(v.ok ? 0 : 1);
  }
  if (cmd === 'check') {
    const [vendor, period] = args;
    if (!vendor || !period) return usage();
    const body = { vendor, period, plan: flags.plan, spend: flags.spend, regions: flags.region, evidence: 'none' };
    const r = await (await fetch(`${api}/api/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (r.error) { console.error(`${r.code}: ${r.error}`); process.exit(2); }
    console.log(`${r.vendor_name} ${r.plan_label}, ${r.period}: ${r.code}`);
    for (const s of r.services) console.log(`  ${s.service}: ${s.uptime_pct}% vs ${s.threshold_pct}% promised, ${s.covered_minutes} min counted, credit ${s.credit_pct}%${s.credit_usd != null ? ` = $${s.credit_usd}` : ''}`);
    if (r.deadline) console.log(`  claim by ${String(r.deadline).slice(0, 10)} (${r.deadline_rule})`);
    console.log(`  details ${api}/check/${r.id}   proof ${api}/check/${r.id}/proof.json`);
    return;
  }
  if (cmd === 'vendors') {
    const v = await (await fetch(`${api}/api/vendors`)).json();
    for (const c of v) console.log(`${c.vendor.padEnd(26)} ${c.plans.map((p) => `${p.plan} (per ${p.period})`).join(', ')}`);
    return;
  }
  usage();
}
function usage() {
  console.log('usage:\n  moneyowed check <vendor> <period> [--plan p] [--spend 6000] [--region us-east-1]\n  moneyowed verify <proof.json>\n  moneyowed vendors');
  process.exit(cmd ? 2 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
