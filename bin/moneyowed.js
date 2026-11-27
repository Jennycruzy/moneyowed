#!/usr/bin/env node
// MONEY OWED command line.
//   moneyowed check <vendor> <period> [--plan p] [--spend 6000] [--region us-east-1] [--api https://...]
//   moneyowed verify <proof.json>        recompute a downloaded proof offline, no network
//   moneyowed vendors [--api https://...]
//   moneyowed claim <check id> [--customer "Acme Ltd"] [--account org-123]
//   moneyowed watch add <vendor> [--plan p] [--spend 2000] [--region us-east-1]   (also: remove, list, budget, run)
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
  if (cmd === 'claim') {
    if (!args[0]) return usage();
    const r = await fetch(`${api}/check/${encodeURIComponent(args[0])}.json`);
    if (!r.ok) { console.error(`no check ${args[0]} (HTTP ${r.status})`); process.exit(2); }
    const { draftClaim } = await import('../src/claim.js');
    const d = draftClaim(await r.json(), { customer: flags.customer, account: flags.account });
    console.log(d.body);
    return;
  }
  if (cmd === 'watch') return watch();
  if (cmd === 'vendors') {
    const v = await (await fetch(`${api}/api/vendors`)).json();
    for (const c of v) console.log(`${c.vendor.padEnd(26)} ${c.plans.map((p) => `${p.plan} (per ${p.period})`).join(', ')}`);
    return;
  }
  usage();
}
async function watch() {
  const W = await import('../src/watch.js');
  const [sub, vendor] = args;
  const cfg = W.loadConfig();
  if (sub === 'add') {
    if (!vendor) return usage();
    const card = await fetch(`${api}/api/cards/${encodeURIComponent(vendor)}`);
    if (!card.ok) { console.error(`unknown vendor ${vendor}; see: moneyowed vendors`); process.exit(2); }
    const c = await card.json();
    if (flags.plan && !c.plans.some((p) => p.plan === flags.plan)) { console.error(`${vendor} has no plan ${flags.plan}; plans: ${c.plans.map((p) => p.plan).join(', ')}`); process.exit(2); }
    const e = { vendor, ...(flags.plan && { plan: flags.plan }), ...(flags.spend && { spend: Number(flags.spend) }), ...(flags.region && { regions: flags.region.split(',') }) };
    cfg.vendors = cfg.vendors.filter((x) => W.entryKey(x) !== W.entryKey(e)).concat(e);
    W.saveConfig(cfg);
    console.log(`watching ${W.entryLabel(e)}${e.spend ? ` (bill $${e.spend})` : ''}; ${cfg.vendors.length} in the list`);
    return;
  }
  if (sub === 'remove') {
    if (!vendor) return usage();
    cfg.vendors = cfg.vendors.filter((x) => x.vendor !== vendor); W.saveConfig(cfg);
    console.log(`${cfg.vendors.length} in the list`); return;
  }
  if (sub === 'budget') {
    if (flags.run) cfg.budget_usd_per_run = Number(flags.run);
    if (flags.month) cfg.budget_usd_per_month = Number(flags.month);
    W.saveConfig(cfg);
    console.log(`Telegraph budget: $${cfg.budget_usd_per_run} per run, $${cfg.budget_usd_per_month} per month`); return;
  }
  if (sub === 'list') {
    const st = W.loadState();
    for (const e of cfg.vendors) console.log(`${W.entryLabel(e).padEnd(36)} ${e.spend ? `$${e.spend}` : ''}`);
    console.log(`Telegraph budget: $${cfg.budget_usd_per_run} per run, $${cfg.budget_usd_per_month} per month; spent this month $${(st.spend[new Date().toISOString().slice(0, 7)] || 0).toFixed(2)}`);
    const last = st.runs?.at(-1);
    if (last) console.log(`last run ${last.at}: ${last.messages} messages, $${last.spent_usd.toFixed(2)} spent${last.notes.length ? `; ${last.notes.join('; ')}` : ''}`);
    return;
  }
  if (sub === 'run') {
    if (!cfg.vendors.length) { console.error('no vendors yet: moneyowed watch add <vendor> --spend <monthly bill>'); process.exit(2); }
    // the public API allows about 10 checks a minute per address: wait and retry instead of failing
    const call = async (p, init) => {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(`${api}${p}`, init);
        if (r.status === 429 && attempt < 8) { await new Promise((ok) => setTimeout(ok, 7000)); continue; }
        const text = await r.text();
        let j; try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}`); }
        if (!r.ok) throw new Error(j.error?.message || j.error || `HTTP ${r.status}`);
        return j;
      }
    };
    const getJson = (p) => call(p);
    const postJson = (p, b) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const buy = await W.makeBuyer({ privateKey: process.env.TELEGRAPH_PRIVATE_KEY || W.keyFromHome(), ownMinerId: cfg.own_miner_id });
    const st = W.loadState();
    const out = await W.runWatch(cfg, st, { getJson, postJson, buy }, { api, now: flags.now ? new Date(flags.now) : new Date() });
    if (flags['dry-run'] === undefined) W.saveState(st);
    // nothing to say: OpenClaw stays quiet on NO_REPLY, Hermes and plain cron on empty output (--silent-token none)
    const quiet = flags['silent-token'] === 'none' ? '' : (flags['silent-token'] || 'NO_REPLY');
    const text = out.text || quiet;
    if (text) console.log(text);
    return;
  }
  usage();
}
function usage() {
  console.log('usage:\n  moneyowed check <vendor> <period> [--plan p] [--spend 6000] [--region us-east-1]\n  moneyowed verify <proof.json>\n  moneyowed vendors\n  moneyowed claim <check id> [--customer name] [--account id]\n  moneyowed watch add <vendor> [--plan p] [--spend 2000] [--region r]\n  moneyowed watch remove <vendor> | list | budget --run 0.05 --month 0.20\n  moneyowed watch run [--silent-token NO_REPLY] [--dry-run 1]   (buys Telegraph evidence only when TELEGRAPH_PRIVATE_KEY is set)');
  process.exit(cmd ? 2 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
