// Web app + JSON API. Node's own http server; no framework.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCredit, CheckError, METHOD_VERSION } from './engine.js';
import { listCards } from './cards.js';
import { VENDORS, NOT_COVERED } from './vendors.js';
import { draftClaim } from './claim.js';
import { openDb } from './db.js';
import { Telegraph } from './telegraph.js';
import { buySecondOpinions } from './evidence.js';
import { page, esc, money, pct, dt, dayOnly, badge } from './views.js';
import { landingData, renderLanding } from './landing.js';
import { answerSla, ERROR_STATUS } from './miner.js';
import { buildProof } from './proof.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.MONEYOWED_DATA || path.join(ROOT, 'data'));
const db = openDb(path.join(DATA, 'moneyowed.sqlite'));
const DEFAULT_REGIONS = { aws: ['us-east-1', 'eu-west-1'], gcp: ['us-central1', 'europe-west1'], azure: ['East US', 'West Europe'] };
const REGION_CHOICES = {
  aws: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-central-1', 'ap-south-1', 'ap-southeast-1', 'ap-northeast-1', 'sa-east-1', 'af-south-1', 'me-central-1'],
  gcp: ['us-central1', 'us-east1', 'us-east4', 'us-west1', 'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4', 'asia-south1', 'asia-southeast1', 'asia-northeast1', 'southamerica-east1', 'africa-south1'],
  azure: ['East US', 'East US 2', 'West US', 'West US 2', 'Central US', 'North Europe', 'West Europe', 'UK South', 'Germany West Central', 'Central India', 'Southeast Asia', 'Japan East', 'Brazil South', 'South Africa North'],
};

let tg = null;
try {
  if (process.env.TELEGRAPH_PRIVATE_KEY) tg = new Telegraph({ privateKey: process.env.TELEGRAPH_PRIVATE_KEY, ledger: db, limits: { perBucketUsd: Number(process.env.LIMIT_PER_USER_USD || 0.2), globalUsd: Number(process.env.LIMIT_DAILY_USD || 3) } });
} catch (e) { console.error('Telegraph disabled:', e.message); }
const jobs = new Map(); // check id -> 'buying' | 'done' | error text

function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body, null, 1)); }
function html(res, code, body) { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" }); res.end(body); }
async function readBody(req) {
  let b = '';
  for await (const c of req) { b += c; if (b.length > 100000) throw new Error('request too large'); }
  return req.headers['content-type']?.includes('application/json') ? JSON.parse(b || '{}') : Object.fromEntries(new URLSearchParams(b));
}

function parseInput(src) {
  const vendor = String(src.vendor || '').trim();
  const regions = [].concat(src.regions || []).flatMap((r) => String(r).split(',')).map((r) => r.trim()).filter(Boolean);
  let spend = src.spend;
  if (typeof spend === 'string') spend = spend.trim() === '' ? undefined : Number(spend.replace(/[$,\s]/g, ''));
  if (typeof spend === 'number' && !(spend >= 0)) throw new CheckError('BAD_INPUT', 'spend must be a positive number (your bill for this period)');
  return { vendor, plan: src.plan || undefined, period: String(src.period || '').trim(), spend, regions: regions.length ? regions : undefined, mode: src.mode === 'lower' ? 'lower' : 'upper' };
}

// For a single typed spend on a multi-service card, apply it to the first service with a credit, and say so.
function runCheck(input) {
  const card = listCards().find((c) => c.vendor === input.vendor);
  if (!card) throw new CheckError('VENDOR_NOT_COVERED', `${input.vendor || 'that vendor'} is not covered yet`);
  if (card.plans[0].per_region && !input.regions) input.regions = DEFAULT_REGIONS[input.vendor];
  let r = checkCredit(input);
  if (typeof input.spend === 'number' && r.services.length > 1) {
    const target = r.services.find((s) => s.credit_pct > 0) || r.services[0];
    r = checkCredit({ ...input, spend: { [target.service]: input.spend } });
    r.spend_note = `The amount you typed was used as the bill for ${target.service}. Give one amount per service for the others.`;
  }
  return r;
}

async function startEvidence(id, result, bucket) {
  if (!tg) { jobs.set(id, 'Telegraph buying is switched off on this server (no wallet key set).'); return; }
  jobs.set(id, 'buying');
  try {
    const ev = await buySecondOpinions(tg, result, { bucket, checkId: id, reuse: (q, m) => db.recentAnswer(q, m) });
    db.db.prepare("UPDATE checks SET result = json_set(result, '$.evidence', json(?)) WHERE id = ?").run(JSON.stringify(ev), id);
    jobs.set(id, 'done');
  } catch (e) { jobs.set(id, `Telegraph purchase failed: ${e.message}`); }
}

// ---------- pages
function home() {
  const rec = loadRecord();
  const latest = rec?.rows?.filter((r) => r.owed).sort((a, b) => (b.period_end || '').localeCompare(a.period_end || ''))[0];
  const vendors = listCards().map((c) => `<option value="${esc(c.vendor)}">${esc(c.name)}</option>`).join('');
  const hero = latest ? `<section class="hero"><p class="k">Latest breach in the record</p><h1>${esc(latest.plan_label)}, ${esc(latest.period)}: ${pct(latest.uptime_pct)} on covered services against a ${pct(latest.threshold_pct)} promise.</h1><p>Owed: <b>${latest.credit_pct}%</b> of that ${latest.period.includes('Q') ? 'quarter' : 'month'}'s bill for ${esc(latest.service)}. ${latest.deadline ? `Claim window ${new Date(latest.deadline) < new Date() ? 'closed' : 'closes'} ${dayOnly(latest.deadline)}.` : ''} The vendor pays only if the customer asks.</p><p><a href="/record">See every breach in the last 12 months →</a></p></section>` : '';
  return page('MONEY OWED', `${hero}
<section><h2>Check what you are owed</h2>
<form method="post" action="/check" class="check">
<label>Vendor <select name="vendor" required>${vendors}</select></label>
<label>Plan <input name="plan" placeholder="leave blank for the vendor's first plan with an SLA"></label>
<label>Period <input name="period" required placeholder="2026-10  (GitHub: 2026-Q3)"></label>
<label>Your bill for that period (USD) <input name="spend" inputmode="decimal" placeholder="e.g. 2000"></label>
<label>Regions (AWS, Google Cloud, Azure) <input name="regions" placeholder="us-east-1, eu-west-1"></label>
<button>Check</button></form>
<p class="small">Uses the vendor's own public incident history and the vendor's own SLA text. Each check also buys SLA answers from miners on Telegraph (testnet) and shows them next to ours.</p></section>
<section><h2>Covered vendors</h2><p>${listCards().map((c) => esc(c.name)).join(' · ')}</p><p class="small"><a href="/evidence#not-covered">Vendors not covered, and why</a></p></section>`);
}

function checkPage(id) {
  const row = db.getCheck(id);
  if (!row) return null;
  const r = row.result;
  const job = jobs.get(id);
  const owed = r.services.filter((s) => s.credit_pct > 0);
  const head = {
    OWED: `<h1>${badge('OWED')} ${r.credit_usd_total != null ? money(r.credit_usd_total) : `${owed.map((s) => `${s.credit_pct}%`).join(' + ')} of the bill`} from ${esc(r.vendor_name)}</h1><p>Claim by <b>${dayOnly(r.deadline)}</b> (${r.days_left} days left; ${esc(r.deadline_rule)}).</p>`,
    WINDOW_CLOSED: `<h1>${badge('WINDOW_CLOSED')} ${r.credit_usd_total != null ? money(r.credit_usd_total) : `${owed.map((s) => `${s.credit_pct}%`).join(' + ')}`} was owed; the claim window closed ${dayOnly(r.deadline)}</h1><p>${esc(r.deadline_rule)}. The record below is what a claim would have said.</p>`,
    NOT_OWED: `<h1>${badge('NOT_OWED')} ${esc(r.vendor_name)} kept its promise for ${esc(r.period)}</h1>`,
    PERIOD_OPEN: `<h1>${badge('PERIOD_OPEN')} ${esc(r.period)} is still running</h1><p>Figures so far.</p>`,
  }[r.code];
  const svc = r.services.map((s) => `<article class="svc"><h3>${esc(s.service)}</h3>
<p class="big">${pct(s.uptime_pct)} <span class="small">uptime on covered parts · promise ${pct(s.threshold_pct)}</span></p>
<p>${s.covered_minutes} minutes counted, ${s.allowed_minutes} allowed. ${s.credit_pct > 0 ? `<b>Credit tier ${s.credit_pct}%</b>${s.credit_usd != null ? ` = ${money(s.credit_usd)} on ${money(s.fee)}` : ' (enter your bill to see dollars)'}.` : `${s.minutes_to_next_tier != null ? `${s.minutes_to_next_tier} more minutes of covered downtime would owe a credit.` : ''}`}</p>
${s.config_note ? `<p class="small">Configuration: ${esc(s.config_note)}</p>` : ''}${s.measure_note ? `<p class="small">${esc(s.measure_note)}</p>` : ''}
<details ${s.credit_pct > 0 ? 'open' : ''}><summary>Incidents (${s.incidents.filter((i) => i.in_scope).length} counted of ${s.incidents.length})</summary><table><tr><th></th><th>Start</th><th>End</th><th>Min</th><th>Incident</th><th>Why</th></tr>
${s.incidents.map((i) => `<tr class="${i.in_scope ? 'in' : 'out'}"><td>${i.in_scope ? '✔' : '–'}</td><td>${dt(i.start)}</td><td>${dt(i.end)}</td><td>${i.in_scope ? i.minutes : ''}</td><td>${i.url ? `<a href="${esc(i.url)}">${esc(i.name)}</a>` : esc(i.name)}</td><td>${esc(i.reason)}</td></tr>`).join('')}</table></details>
<details><summary>The SLA terms used</summary><blockquote>${esc(s.quotes.threshold)}</blockquote><blockquote>${esc(s.quotes.tiers)}</blockquote>${s.quotes.scope ? `<blockquote>${esc(s.quotes.scope)}</blockquote>` : ''}</details></article>`).join('');
  const ev = r.evidence;
  const evHtml = job === 'buying' ? '<p>Buying SLA answers on Telegraph… this page refreshes.</p><meta http-equiv="refresh" content="4">'
    : ev ? `<table><tr><th>Route</th><th>Miner</th><th>Their answer</th><th>Same verdict as ours?</th><th>Notes</th><th>Cost</th><th>Time</th><th>Answer hash</th></tr>${ev.opinions.map((o) => o.skipped ? `<tr><td>${esc(o.label)}</td><td colspan="7" class="small">${esc(o.skipped)}</td></tr>` : o.error ? `<tr><td>${esc(o.label)}</td><td colspan="7">${esc(o.error)}</td></tr>` : `<tr><td>${esc(o.label)}${o.reused ? ' (reused, under 1 h old)' : ''}</td><td>${esc(o.miner_name || '')} <span class="small">${esc(o.miner_id || '')}</span></td><td>${o.uptime_pct != null ? pct(o.uptime_pct) : ''} ${o.compliant === true ? 'met' : o.compliant === false ? 'missed' : ''}<br><span class="small">${esc(o.period_label || '')}</span></td><td>${o.agrees === true ? 'yes' : o.agrees === false ? '<b>no</b>' : '?'}</td><td class="small">${esc((o.notes || []).join('; '))}</td><td>${money(o.cost_usd)}</td><td>${(o.latency_ms / 1000).toFixed(1)} s</td><td class="mono">${esc((o.answer_sha256 || '').slice(0, 12))}</td></tr>`).join('')}</table>
<p class="small">Question sent: <code>${esc(JSON.stringify(ev.question))}</code>. Payments: Telegraph escrow on testnet (Ethereum Sepolia, test USDC). Our verdict is computed from the vendor's own incident records and SLA text; bought answers are shown for comparison.</p>`
    : job ? `<p>${esc(job)}</p>` : '<p class="small">No Telegraph purchase for this check.</p>';
  return page(`${r.vendor_name} ${r.period}`, `<section class="verdict">${head}<p class="small">${esc(r.plan_label)} · ${esc(r.period)} (${dayOnly(r.period_start)} to ${dayOnly(new Date(+new Date(r.period_end) - 1))})${r.regions.length ? ` · regions ${esc(r.regions.join(', '))}` : ''} · count: ${r.mode === 'lower' ? 'major outages only' : 'all outages'} · <a href="/check/${id}.json">JSON</a> · <a href="/check/${id}/proof.json">Proof file</a> (recompute offline: <span class="mono">node bin/moneyowed.js verify moneyowed-proof-${id}.json</span>)</p>
${r.spend_note ? `<p class="small">${esc(r.spend_note)}</p>` : ''}${(r.card.page_changed || []).length ? `<p class="warn">The SLA page changed since its card was checked; every quoted term is still on it word for word. Card under review.</p>` : ''}
${['OWED', 'PERIOD_OPEN'].includes(r.code) && owed.length ? `<p><a class="button" href="/claim/${id}">Open the claim draft</a></p>` : ''}</section>
${svc}
<section><h2>Telegraph</h2>${evHtml}</section>
<section class="small"><p>SLA: <a href="${esc(r.card.sla_url)}">${esc(r.card.sla_url)}</a>, checked ${esc(r.card.checked_at)}. ${r.card.notes.map(esc).join(' ')}</p><p>History collected ${dt(r.history.collected_at)}. Method ${esc(r.method_version)}. Status-page incidents are the vendor's own public record; your own logs can add to them.</p></section>`);
}

function claimPage(id) {
  const row = db.getCheck(id);
  if (!row) return null;
  let d;
  try { d = draftClaim(row.result); } catch (e) { return page('No claim', `<p>${esc(e.message)}</p>`); }
  const c = db.getClaim(id);
  const mailto = `mailto:?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
  return page('Claim draft', `<section><h1>Claim draft</h1><p>Send it yourself through: <b>${esc(d.to)}</b>. MONEY OWED never sends anything.</p>
<pre class="claim">${esc(d.body)}</pre>
<p><a class="button" href="${esc(mailto)}">Open in my email</a></p>
<form method="post" action="/claim/${id}/status" class="row"><span>Status: <b>${esc(c?.status || 'drafted')}</b></span>
<button name="status" value="sent">I sent it</button><button name="status" value="credited">Vendor credited it</button><button name="status" value="refused">Vendor refused</button><button name="status" value="declined">I'm not claiming</button>
<input name="note" placeholder="vendor's reply (optional)"></form></section>`);
}

function loadRecord() {
  const f = path.join(DATA, 'record.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function recordPage() {
  const rec = loadRecord();
  if (!rec) return page('The record', '<p>The record has not been built on this server yet (npm run record).</p>');
  const rows = rec.rows.filter((r) => r.owed).sort((a, b) => b.period.localeCompare(a.period) || a.vendor_name.localeCompare(b.vendor_name));
  return page('The record', `<section><h1>Every SLA breach in the last 12 months</h1><p>${rec.rows.length} vendor-periods checked, ${rows.length} with a credit owed. Built ${dt(rec.built_at)} from the archived incident history. Figures for clouds use regions: ${Object.entries(DEFAULT_REGIONS).map(([k, v]) => `${k} ${v.join(' + ')}`).join('; ')}.</p>
<p><a href="/record.json">JSON</a> · <a href="/record.csv">CSV</a></p>
<table><tr><th>Period</th><th>Vendor / plan</th><th>Service</th><th>Uptime</th><th>Promise</th><th>Credit</th><th>Claim window</th></tr>${rows.map((r) => `<tr><td>${esc(r.period)}</td><td>${esc(r.vendor_name)} ${esc(r.plan_label)}</td><td>${esc(r.service)}</td><td>${pct(r.uptime_pct)}</td><td>${pct(r.threshold_pct)}</td><td>${r.credit_pct}%</td><td>${r.deadline ? `${new Date(r.deadline) < new Date() ? 'closed' : 'open to'} ${dayOnly(r.deadline)}` : 'not stated'}</td></tr>`).join('')}</table></section>`);
}

function evidencePage() {
  const purchases = db.allPurchases(200);
  const paid = purchases.filter((p) => p.paid);
  return page('Evidence', `<section><h1>How it is checked</h1>
<ul><li>Incident history: each vendor's public status history, archived as fetched with its sha256.</li><li>Rules: one card per vendor, written from the vendor's SLA text; every threshold, tier, cap and claim deadline is backed by a word-for-word quote, re-checked automatically against the text.</li><li>Decision: plain code. A language model never sets a number.</li><li>Telegraph: every check buys SLA answers from miners and shows them beside ours, with cost, time and answer hash.</li></ul></section>
<section><h2>Telegraph purchases on this server</h2><p>${paid.length} paid answers, ${money(paid.reduce((t, p) => t + p.cost_usd, 0))} total, median ${median(paid.map((p) => p.latency_ms / 1000)).toFixed(1)} s. <a href="/purchases.json">JSON</a></p></section>
${minerSection()}
<section id="not-covered"><h2>Vendors not covered, and why</h2><ul>${NOT_COVERED.map((n) => `<li><b>${esc(n.name)}</b>: ${esc(n.reason)}</li>`).join('')}</ul></section>`);
}
function minerSection() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'miner', f), 'utf8')); } catch { return null; } };
  const reg = read('registration.json');
  if (!reg) return '';
  const acc = read('accuracy.json');
  const yamlFile = path.join(ROOT, 'miner', 'moneyowed-sla.yaml');
  const yamlHash = fs.existsSync(yamlFile) ? crypto.createHash('sha256').update(fs.readFileSync(yamlFile)).digest('hex') : '';
  const st = db.minerStats();
  const tx = (h) => `<a class="mono" href="https://sepolia.etherscan.io/tx/${esc(h)}">${esc(h.slice(0, 10))}…</a>`;
  return `<section id="miner"><h2>Our SLA miner on Telegraph</h2>
<p>The same engine answers <b>${esc(reg.intent)}</b> for any Telegraph buyer, as miner <b>${esc(reg.miner_id)}</b> (<span class="mono">${esc(reg.slug)}</span>). It is run by the MONEY OWED team. When a check here buys its answer, the page labels it as ours, and it never counts as an outside opinion.</p>
<ul><li>Registration ${esc(reg.registration_id)} on ${esc(reg.chain)}: ${tx(reg.register_tx)}, updated ${tx(reg.update_tx)}</li>
<li>Miner file: <a href="/miner.yaml">miner.yaml</a>, sha256 <span class="mono">${esc(yamlHash.slice(0, 16))}…</span>, the same hash that is stored on chain</li>
<li>Try it without Telegraph: <a class="mono" href="/miner/sla?service=GitHub&amp;period=2026-Q3">/miner/sla?service=GitHub&amp;period=2026-Q3</a></li>
<li>Calls served by this server: ${st.n || 0} (${st.ok || 0} answered)${st.last ? `, last ${esc(dt(st.last))} UTC` : ''}</li></ul>
${acc ? `<h3>Every SLA miner against hand-checked truth</h3><p>${esc(acc.items)} vendor-months whose correct answer was worked out by hand before any miner was asked. Each miner got the same question, paid through Telegraph. Rules fixed in advance (sha256 <span class="mono">${esc(acc.protocol_sha256.slice(0, 12))}…</span>). Our miner uses the same counting rules as the person who did the hand check, so its row is not an independent test.</p>
<table><tr><th>Miner</th><th>Answered</th><th>Verdict right</th><th>Uptime within 0.01 pt</th><th>Breaches caught</th><th>Answered a different window</th></tr>${acc.table.map((r) => `<tr><td>${esc(r.name)} <span class="small">${esc(r.miner)}${r.own ? ' · ours' : ''}</span></td><td>${r.answered}/${r.asked}</td><td>${r.verdict_right}/${r.asked}</td><td>${r.uptime_close}/${r.asked}</td><td>${r.owed_caught}/${r.owed_total}</td><td>${r.wrong_window}</td></tr>`).join('')}</table>` : ''}
</section>`;
}
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') {
      try { return html(res, 200, renderLanding(landingData(DATA, db), { vendorsOptions: listCards().map((c) => `<option value="${esc(c.vendor)}">${esc(c.name)}</option>`).join('') })); }
      catch (e) { console.error('landing', e); return html(res, 200, home()); }
    }
    if (req.method === 'GET' && p === '/check') return html(res, 200, home());
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const rel = path.normalize(p.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '');
      const f = path.join(ROOT, 'static', rel);
      if (!f.startsWith(path.join(ROOT, 'static') + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return html(res, 404, page('Not found', '<p>Nothing here.</p>'));
      const type = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(f)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && p === '/health') {
      const stat = VENDORS.map((v) => { const f = path.join(DATA, 'incidents', `${v.vendor}.json`); return { vendor: v.vendor, collected_at: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).collected_at : null }; });
      return json(res, 200, { ok: true, method: METHOD_VERSION, telegraph: Boolean(tg), wallet: tg?.from || null, spent_today_usd: db.spentToday(null), vendors: stat });
    }
    if (req.method === 'POST' && (p === '/check' || p === '/api/check')) {
      const body = await readBody(req);
      const input = parseInput(body);
      const result = runCheck(input);
      const id = db.newId();
      db.saveCheck(id, input, result, p === '/api/check' ? 'api' : 'web');
      const bucket = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon').split(',')[0].trim();
      const evidence = body.evidence !== 'none' && body.evidence !== false;
      if (evidence) {
        const pr = startEvidence(id, result, `ip:${bucket}`);
        if (p === '/api/check') { await pr; return json(res, 200, { id, ...db.getCheck(id).result }); }
      }
      if (p === '/api/check') return json(res, 200, { id, ...result });
      res.writeHead(303, { location: `/check/${id}` }); return res.end();
    }
    let m;
    if (req.method === 'GET' && (m = /^\/check\/([\w-]+)\/proof\.json$/.exec(p))) {
      const r = db.getCheck(m[1]);
      if (!r) return json(res, 404, { error: 'not found' });
      const fees = Object.fromEntries(r.result.services.filter((x) => x.fee != null).map((x) => [x.service, x.fee]));
      const proof = buildProof({ spend: Object.keys(fees).length ? fees : null }, r.result);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="moneyowed-proof-${m[1]}.json"` });
      return res.end(JSON.stringify(proof));
    }
    if (req.method === 'GET' && (m = /^\/check\/([\w-]+)\.json$/.exec(p))) { const r = db.getCheck(m[1]); return r ? json(res, 200, { id: m[1], ...r.result, purchases: db.purchasesFor(m[1]) }) : json(res, 404, { error: 'not found' }); }
    if (req.method === 'GET' && (m = /^\/check\/([\w-]+)$/.exec(p))) { const b = checkPage(m[1]); return b ? html(res, 200, b) : html(res, 404, page('Not found', '<p>No such check.</p>')); }
    if (req.method === 'GET' && (m = /^\/claim\/([\w-]+)$/.exec(p))) { const b = claimPage(m[1]); return b ? html(res, 200, b) : html(res, 404, page('Not found', '<p>No such check.</p>')); }
    if (req.method === 'POST' && (m = /^\/claim\/([\w-]+)\/status$/.exec(p))) {
      const body = await readBody(req);
      if (!['sent', 'credited', 'refused', 'declined'].includes(body.status)) return json(res, 400, { error: 'bad status' });
      db.setClaim(m[1], body.status, { note: body.note });
      res.writeHead(303, { location: `/claim/${m[1]}` }); return res.end();
    }
    if (req.method === 'GET' && p === '/record') return html(res, 200, recordPage());
    if (req.method === 'GET' && p === '/record.json') { const r = loadRecord(); return r ? json(res, 200, r) : json(res, 404, { error: 'not built' }); }
    if (req.method === 'GET' && p === '/record.csv') {
      const r = loadRecord(); if (!r) return json(res, 404, { error: 'not built' });
      const cols = ['period', 'vendor', 'plan', 'service', 'uptime_pct', 'threshold_pct', 'covered_minutes', 'credit_pct', 'deadline', 'owed'];
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
      return res.end([cols.join(','), ...r.rows.map((x) => cols.map((c) => JSON.stringify(x[c] ?? '')).join(','))].join('\n'));
    }
    if (p === '/miner/sla' && (req.method === 'GET' || req.method === 'POST')) {
      const t0 = Date.now();
      let q = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') { try { q = { ...q, ...JSON.parse((await readBody(req)) || '{}') }; } catch { q = { ...q }; } }
      const fromTelegraph = /telegraph|anjoman|go-http-client/i.test(req.headers['user-agent'] || '');
      try {
        const a = answerSla(q);
        db.minerCall({ service: q.service || q.question, period: q.period, status: 200, uptime_pct: a.uptime_pct, from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        return json(res, 200, a);
      } catch (e) {
        const status = ERROR_STATUS[e.code] || 500;
        db.minerCall({ service: q.service || q.question, period: q.period, status, code: e.code || 'ERROR', from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        if (status === 500) console.error('miner', e);
        return json(res, status, { error: { code: e.code || 'ERROR', message: status === 500 ? 'internal error' : e.message } });
      }
    }
    if (req.method === 'GET' && p === '/miner.yaml') {
      const f = path.join(ROOT, 'miner', 'moneyowed-sla.yaml');
      if (!fs.existsSync(f)) return html(res, 404, page('Not found', '<p>Nothing here.</p>'));
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'access-control-allow-origin': '*' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && p === '/evidence') return html(res, 200, evidencePage());
    if (req.method === 'GET' && p === '/purchases.json') return json(res, 200, db.allPurchases(500).map(({ answer, ...x }) => x));
    if (req.method === 'GET' && p === '/api/vendors') return json(res, 200, listCards().map((c) => ({ vendor: c.vendor, name: c.name, plans: c.plans.map((pl) => ({ plan: pl.plan, label: pl.label, period: pl.period, per_region: Boolean(pl.per_region), services: pl.services.map((s) => s.service) })), regions: REGION_CHOICES[c.vendor] || null })));
    return html(res, 404, page('Not found', '<p>Nothing here.</p>'));
  } catch (e) {
    if (e instanceof CheckError || e.code) {
      if (p.startsWith('/api/')) return json(res, 400, { code: e.code, error: e.message });
      return html(res, 400, page('Cannot check', `<section><h1>${badge(e.code)} ${esc(e.message)}</h1><p><a href="/">Back</a></p></section>`));
    }
    console.error(e);
    return p.startsWith('/api/') ? json(res, 500, { error: 'internal error' }) : html(res, 500, page('Error', '<p>Something went wrong on our side.</p>'));
  }
});

const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`MONEY OWED on http://${process.env.HOST || '127.0.0.1'}:${PORT} (telegraph ${tg ? 'on' : 'off'})`));
export default server;
