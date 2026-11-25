// GitHub Action entry: check each vendor, write a job summary, open one issue per open claim.
// No dependencies: runs on the runner's own Node.
import fs from 'node:fs';
import { draftClaim } from '../src/claim.js';

const input = (n, d = '') => (process.env[`INPUT_${n.replace(/ /g, '_').toUpperCase()}`] ?? d).trim();
const api = input('api', 'https://moneyowed.38-49-216-59.sslip.io').replace(/\/$/, '');
const token = input('github-token');
const openIssue = input('open-issue', 'true') !== 'false';
const repo = process.env.GITHUB_REPOSITORY;
const fetchJson = async (url, opts) => { const r = await fetch(url, opts); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`${url}: HTTP ${r.status}`); } };

export function parseVendors(text) {
  return text.split(/[\n,]/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const m = /^([\w-]+)(?::([\w-]+))?(?:=\s*\$?([\d.]+))?$/.exec(l);
    if (!m) throw new Error(`cannot read vendor line "${l}" (use vendor[:plan][=monthly bill])`);
    return { vendor: m[1].toLowerCase(), plan: m[2] || undefined, spend: m[3] ? Number(m[3]) : undefined };
  });
}

export function lastClosed(kind, now = new Date()) {
  const y = now.getUTCFullYear(), mo = now.getUTCMonth();
  if (kind === 'quarter') { const q = Math.floor(mo / 3); return q === 0 ? `${y - 1}-Q4` : `${y}-Q${q}`; }
  return mo === 0 ? `${y - 1}-12` : `${y}-${String(mo).padStart(2, '0')}`;
}

function out(name, value) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`); }
function summary(md) { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); else console.log(md); }

async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, { ...opts, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function upsertIssue(title, body) {
  const q = encodeURIComponent(`repo:${repo} is:issue in:title "${title}"`);
  const found = await gh(`/search/issues?q=${q}`);
  const hit = found.items?.find((i) => i.title === title);
  if (hit) { await gh(`/repos/${repo}/issues/${hit.number}`, { method: 'PATCH', body: JSON.stringify({ body }) }); return hit.html_url; }
  const made = await gh(`/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body, labels: ['sla-credit'] }) });
  return made.html_url;
}

async function main() {
  const vendors = parseVendors(input('vendors'));
  const catalog = await fetchJson(`${api}/api/vendors`);
  const rows = []; let owed = 0;
  for (const v of vendors) {
    const card = catalog.find((c) => c.vendor === v.vendor);
    if (!card) { rows.push(`| ${v.vendor} | not covered | | | |`); continue; }
    const plan = card.plans.find((p) => p.plan === v.plan) || card.plans[0];
    const period = input('period') || lastClosed(plan.period);
    const r = await fetchJson(`${api}/api/check`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'moneyowed-action/1' }, body: JSON.stringify({ vendor: v.vendor, plan: plan.plan, period, spend: v.spend }) });
    if (r.error) { rows.push(`| ${card.name} | ${period} | ${r.code} | | ${r.error} |`); continue; }
    const s = r.services.find((x) => x.credit_pct > 0) || r.services[0];
    const money = r.credit_usd_total != null ? `$${r.credit_usd_total.toFixed(2)}` : s.credit_pct ? `${s.credit_pct}% of the bill` : '';
    const paid = (r.evidence?.opinions || []).filter((o) => o.cost_usd > 0);
    let link = `[details](${api}/check/${r.id})`;
    if (r.code === 'OWED') {
      owed++;
      if (openIssue && token && repo) {
        const c = draftClaim(r);
        const body = [`**${r.vendor_name} owes a service credit for ${r.period}**: ${s.service} was up ${s.uptime_pct}% against the ${s.threshold_pct}% in its SLA. Credit: ${money}.`, '',
          `**Claim by ${String(r.deadline).slice(0, 10)}** (${r.deadline_rule}). Send to: ${c.to}`, '', '```text', c.body, '```', '',
          `Every counted incident, the contract wording and an offline proof: ${api}/check/${r.id}`,
          paid.length ? `Second opinions bought on Telegraph for this check: ${paid.length} (${paid.map((o) => o.miner_name || o.miner_id).join(', ')}).` : ''].join('\n');
        link = await upsertIssue(`SLA credit owed: ${r.vendor_name} ${r.period}`, body);
      }
    }
    const open = r.code === 'OWED';
    const label = { OWED: 'owed', NOT_OWED: 'promise kept', WINDOW_CLOSED: 'missed, claim window closed', PERIOD_OPEN: 'period still open' }[r.code] || r.code;
    rows.push(`| ${card.name} | ${r.period} | ${label} | ${open || r.code === 'WINDOW_CLOSED' ? money : ''} | ${s.uptime_pct}% vs ${s.threshold_pct}%${open && r.deadline ? `, claim by ${String(r.deadline).slice(0, 10)}` : ''} ${link} |`);
  }
  summary(['### SLA credits', '', '| Vendor | Period | Result | Credit | Detail |', '|---|---|---|---|---|', ...rows].join('\n'));
  out('owed', owed);
}

if (process.argv[1]?.endsWith('run.mjs')) main().catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
