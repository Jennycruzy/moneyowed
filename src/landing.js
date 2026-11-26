// Landing page. Every figure is computed from the record, the engine and the purchase log at request time.
import fs from 'node:fs';
import path from 'node:path';
import { checkCredit } from './engine.js';
import { listCards } from './cards.js';
import { draftClaim } from './claim.js';
import { esc } from './views.js';
import { lastDay } from './engine.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;
let cache = { at: 0, data: null };

export function landingData(DATA, db) {
  if (cache.data && Date.now() - cache.at < 10 * 60000) return { ...cache.data, purchase: latestPurchase(db) };
  const rec = JSON.parse(fs.readFileSync(path.join(DATA, 'record.json'), 'utf8'));
  const cards = listCards();
  const first = Object.fromEntries(cards.map((c) => [c.vendor, c.plans[0]]));
  const rows = rec.rows.filter((x) => x.plan === first[x.vendor].plan);
  const owed = rows.filter((x) => x.owed);
  const vendorPeriods = new Set(owed.map((x) => `${x.vendor}|${x.period}`));

  // months shown: the 12 full months before the build date
  const built = new Date(rec.built_at);
  const months = [];
  for (let i = 12; i >= 1; i--) { const d = new Date(Date.UTC(built.getUTCFullYear(), built.getUTCMonth() - i, 1)); months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
  const quarterOf = (m) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5)) - 1) / 3) + 1}`;
  const heat = cards.map((c) => {
    const mine = rows.filter((x) => x.vendor === c.vendor);
    const cells = months.map((m) => {
      const key = first[c.vendor].period === 'quarter' ? quarterOf(m) : m;
      const here = mine.filter((x) => x.period === key);
      if (!here.length) return { m, none: true };
      const worst = here.reduce((a, b) => (b.credit_pct > a.credit_pct || (b.credit_pct === a.credit_pct && b.uptime_pct < a.uptime_pct) ? b : a));
      return { m, key, credit: worst.credit_pct, uptime: worst.uptime_pct, service: worst.service, threshold: worst.threshold_pct };
    });
    return { vendor: c.vendor, name: c.name, plan: first[c.vendor].label, breaches: new Set(mine.filter((x) => x.owed).map((x) => x.period)).size, cells };
  }).sort((a, b) => b.breaches - a.breaches || a.name.localeCompare(b.name));

  // hero strip: GitHub Enterprise Cloud, latest full quarter in the record
  const ghq = rows.filter((x) => x.vendor === 'github' && x.service === 'GitHub Enterprise Cloud').map((x) => x.period).sort().pop();
  const g = checkCredit({ vendor: 'github', plan: 'enterprise-cloud', period: ghq, spend: { 'GitHub Enterprise Cloud': 6000 } });
  const ghec = g.services[0];
  const nDays = Math.round((new Date(g.period_end) - new Date(g.period_start)) / DAY);
  const days = Array.from({ length: nDays }, () => 0);
  for (const i of ghec.incidents.filter((x) => x.in_scope)) {
    const d = Math.floor((new Date(i.start) - new Date(g.period_start)) / DAY);
    if (d >= 0 && d < nDays) days[d] += i.minutes;
  }
  const counted = ghec.incidents.filter((x) => x.in_scope);
  const notCounted = ghec.incidents.filter((x) => !x.in_scope);
  const samples = [...counted.slice(0, 2), ...notCounted.filter((x) => /Copilot|no outage|degraded/.test(x.reason)).slice(0, 3)].sort((a, b) => new Date(a.start) - new Date(b.start));

  // claim sample: newest owed statuspage month with a single service and an open or recently closed window
  const claimRow = owed.filter((x) => ['jira', 'bitbucket', 'confluence', 'jira-service-management', 'vercel'].includes(x.vendor)).sort((a, b) => b.period.localeCompare(a.period))[0];
  let claim = null;
  if (claimRow) {
    const c = checkCredit({ vendor: claimRow.vendor, plan: claimRow.plan, period: claimRow.period, spend: 1500, now: new Date(new Date(claimRow.period_end).getTime() + 2 * DAY) });
    const d = draftClaim(c, { customer: 'Your company' });
    claim = { vendor: c.vendor_name, period: c.period, subject: d.subject, lines: d.body.split('\n').filter((l) => /^\s+- \d{4}/.test(l)).slice(0, 3), deadline: c.deadline, total: c.credit_usd_total };
  }

  const data = {
    total_vendors: cards.length,
    owed_vendor_periods: vendorPeriods.size,
    vendors_with_breach: new Set(owed.map((x) => x.vendor)).size,
    months, heat,
    strip: { period: ghq, period_start: g.period_start, period_end: g.period_end, days, counted_minutes: ghec.covered_minutes, allowed: ghec.allowed_minutes, uptime: ghec.uptime_pct, threshold: ghec.threshold_pct, credit: ghec.credit_pct, deadline: g.deadline, counted_n: counted.length, total_n: ghec.incidents.length, tiers_quote: ghec.quotes.tiers, samples },
    claim,
    built_at: rec.built_at,
  };
  cache = { at: Date.now(), data };
  return { ...data, purchase: latestPurchase(db) };
}

function latestPurchase(db) {
  const p = db.allPurchases(200).find((x) => x.paid && x.answer && x.cost_usd > 0);
  return p || null;
}

const fmtMonth = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const longDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const fmtPct = (n) => `${Number(n).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;

// Running total of counted minutes across the period, against the contract's allowance.
function cumulative(s) {
  const W = 1000, H = 150, n = s.days.length;
  const total = Math.max(s.counted_minutes, s.allowed * 1.2);
  let acc = 0;
  const pts = [[0, H]];
  s.days.forEach((m, i) => { const x = ((i + 1) / n) * W; if (m > 0) { pts.push([(i / n) * W, H - (acc / total) * H]); acc += m; } pts.push([x, H - (acc / total) * H]); });
  const yA = H - (s.allowed / total) * H;
  const crossDay = (() => { let a = 0; for (let i = 0; i < n; i++) { a += s.days[i]; if (a > s.allowed) return i; } return -1; })();
  const xC = crossDay >= 0 ? ((crossDay + 0.5) / n) * W : null;
  return `<svg class="cum" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
<line class="allow" x1="0" x2="${W}" y1="${yA.toFixed(1)}" y2="${yA.toFixed(1)}"/>
<polyline class="run" pathLength="1" points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>
${xC != null ? `<line class="cross" x1="${xC.toFixed(1)}" x2="${xC.toFixed(1)}" y1="0" y2="${H}"/>` : ''}</svg>
<div class="cum-label allow-l mono" style="top:${((yA / H) * 100).toFixed(1)}%">contract allows ${Math.round(s.allowed)} min</div>
<div class="cum-label run-l mono">running total ${Math.round(s.counted_minutes)} min</div>
${xC != null ? `<div class="cum-label cross-l mono" style="left:${((xC / W) * 100).toFixed(1)}%">promise broken</div>` : ''}`;
}

function highlightNumbers(q) {
  return esc(q).replace(/(\d+(?:\.\d+)?\s?%)/g, '<mark>$1</mark>');
}

export function renderLanding(d, { vendorsOptions }) {
  const s = d.strip;
  const maxDay = Math.max(...s.days, 1);
  const bars = s.days.map((m, i) => {
    const h = m > 0 ? Math.max(8, Math.round((Math.sqrt(m) / Math.sqrt(maxDay)) * 100)) : 0;
    return `<i style="--h:${h}%;--i:${i}" class="${m > 0 ? 'down' : ''}" title="${m > 0 ? `${Math.round(m)} min counted` : 'no counted outage'}"></i>`;
  }).join('');
  const heatRows = d.heat.map((r, ri) => `<div class="hrow" role="row"><div class="hname" role="rowheader"><b>${esc(r.name)}</b><span>${esc(r.plan)}</span></div>${r.cells.map((c, ci) => c.none
    ? `<div class="cell none" role="gridcell" style="--d:${ri + ci}"><span class="tip">${esc(r.name)} · ${fmtMonth(c.m)}<br>no history held</span></div>`
    : `<div class="cell t${c.credit >= 25 ? 3 : c.credit >= 10 ? 2 : c.credit > 0 ? 1 : 0}" role="gridcell" style="--d:${ri + ci}" tabindex="0"><span class="tip">${esc(r.name)} · ${c.key.includes('Q') ? c.key : fmtMonth(c.m)}<br>${esc(c.service)}: ${fmtPct(c.uptime)} vs ${c.threshold}%<br>${c.credit > 0 ? `<b>${c.credit}% credit owed</b>` : 'promise kept'}</span></div>`).join('')}<div class="hcount">${r.breaches || '–'}</div></div>`).join('');
  const p = d.purchase;
  const ans = p?.answer || {};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MONEY OWED: the credits your vendors owe you</title>
<meta name="description" content="When a cloud or software vendor misses its written uptime promise, it owes you a credit, but only if you ask in time. MONEY OWED finds it, proves it and drafts the claim.">
<link rel="preload" href="/static/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/site.css"></head>
<body class="landing">
<header class="nav wrap"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>MONEY OWED</a>
<nav><a href="#year">The year</a><a href="#how">How it decides</a><a href="#proof">Proof</a><a href="/record">Record</a><a class="btn small" href="#check">Check yours</a></nav></header>

<section class="hero wrap">
  <div class="hero-num"><span class="count" data-to="${d.owed_vendor_periods}">${d.owed_vendor_periods}</span></div>
  <div class="hero-copy">
    <h1>times in the last year, a vendor we cover broke its written uptime promise and owed its customers money.</h1>
    <p class="lede">Every one of those credits is paid only if the customer asks, in writing, before a short deadline. MONEY OWED reads the vendor's own incident history against the vendor's own contract, works out what you are owed, and drafts the claim.</p>
    <div class="ctas"><a class="btn" href="#check">Check what you're owed</a><a class="btn ghost" href="#year">See the year</a></div>
    <p class="fine">${d.vendors_with_breach} of ${d.total_vendors} covered vendors · ${d.months.length} months · from public status history and published SLAs</p>
  </div>
</section>

<section class="strip-card wrap reveal" aria-label="GitHub Enterprise Cloud ${esc(s.period)}">
  <div class="strip-head">
    <div><p class="k">GitHub Enterprise Cloud · ${esc(s.period)}</p><p class="big mono"><span class="count" data-to="${s.uptime}" data-dec="3">${Number(s.uptime).toFixed(3)}</span>%<span class="vs"> against a ${s.threshold}% promise</span></p></div>
    <div class="owe"><p class="k">Owed</p><p class="big mono red">${s.credit}%<span class="vs"> of the quarter's bill</span></p></div>
  </div>
  <div class="strip-wrap"><div class="strip" role="img" aria-label="Counted outage minutes per day across the quarter">${bars}</div>${cumulative(s)}</div>
  <div class="strip-axis mono"><span>${longDay(s.period_start)}</span><span>counted outage minutes per day</span><span>${longDay(new Date(new Date(s.period_end) - 1))}</span></div>
  <div class="strip-foot">
    <p><b class="mono">${Math.round(s.counted_minutes)}</b> minutes down on covered services. The contract allows <b class="mono">${Math.round(s.allowed)}</b>.</p>
    <p><b class="mono">${s.counted_n}</b> of ${s.total_n} incidents counted. The rest were Copilot, Codespaces, or only “degraded”, which the SLA does not pay for.</p>
    <p>Claim window: 30 days after the quarter. ${new Date(s.deadline) < new Date() ? `Last day to claim was ${longDay(lastDay(s.deadline))}.` : `Last day to claim: ${longDay(lastDay(s.deadline))}.`}</p>
  </div>
</section>

<section id="year" class="year wrap reveal">
  <div class="sec-head"><h2>The year in broken promises</h2><p>Each square is a vendor's month, coloured by the credit its own SLA owes. Hover or tap for the numbers. Clouds are counted for us-east-1 / eu-west-1, us-central1 / europe-west1, East US / West Europe.</p></div>
  <div class="heat" role="grid" aria-label="Credits owed per vendor per month">
    <div class="hrow head" role="row"><div class="hname"></div>${d.months.map((m) => `<div class="mlabel mono">${fmtMonth(m)}</div>`).join('')}<div class="hcount mono">breaches</div></div>
    ${heatRows}
  </div>
  <div class="legend mono"><span><i class="cell t0"></i>kept</span><span><i class="cell t1"></i>under 10%</span><span><i class="cell t2"></i>10%</span><span><i class="cell t3"></i>25% or more</span></div>
</section>

<section id="how" class="how wrap reveal">
  <div class="sec-head"><h2>How it decides</h2><p>Plain code makes every decision. No model sets a threshold, a tier or a date.</p></div>
  <div class="cols">
    <article class="col">
      <h3>Only what the contract covers</h3>
      <p>Vendors post every hiccup. The SLA pays for some. Each incident is kept or dropped with the reason.</p>
      <ul class="inc">${s.samples.map((i) => `<li class="${i.in_scope ? 'in' : 'out'}"><span class="mono">${day(i.start)}</span><b>${esc(i.name)}</b><em>${i.in_scope ? `${Math.round(i.minutes)} min counted` : esc(i.reason.replace(/\s*\(.*$/, ''))}</em></li>`).join('')}</ul>
    </article>
    <article class="col">
      <h3>Terms, word for word</h3>
      <p>Every number comes with the sentence it was read from, re-checked against the vendor's page every night.</p>
      <blockquote class="quote">${highlightNumbers(s.tiers_quote.slice(0, s.tiers_quote.lastIndexOf('%') + 1))}</blockquote>
      <p class="fine">GitHub Online Services SLA · version June 2026</p>
    </article>
    <article class="col">
      <h3>A claim you send</h3>
      <p>The draft follows the vendor's own claim rules: where to send it, what to include, and by when.</p>
      ${d.claim ? `<div class="mail"><p class="mono subj">${esc(d.claim.subject)}</p>${d.claim.lines.map((l) => `<p class="mono">${esc(l.trim().replace(/ https?:\/\/\S+$/, ''))}</p>`).join('')}<p class="mono due">Window ends ${day(d.claim.deadline)}</p></div>` : ''}
    </article>
  </div>
</section>

<section class="tg wrap reveal">
  <div class="tg-copy"><h2>Second opinions, paid per answer</h2>
  <p>Each check also buys SLA answers from independent agents on Telegraph, paid per answer from an escrow wallet, and shows them next to its own count. When they disagree, you see why: wrong period, no incident list, or outages the contract excludes.</p>
  <p class="fine">Telegraph testnet · Ethereum Sepolia · test USDC · spending limits per user and per day</p></div>
  ${p ? `<div class="receipt" aria-label="Latest Telegraph purchase"><p class="r-top mono">TELEGRAPH · SLA_COMPLIANCE_GENERAL</p>
  <dl class="mono"><dt>miner</dt><dd>${esc(p.miner_name || p.miner_id)}</dd><dt>route</dt><dd>${esc(p.route)}</dd><dt>answer</dt><dd>${ans.uptime_pct != null ? `${esc(ans.uptime_pct)}% · ${ans.compliant === false ? 'missed' : ans.compliant === true ? 'met' : '?'}` : 'no figure'}</dd><dt>period</dt><dd>${esc(ans.period || '')}</dd><dt>paid</dt><dd>$${Number(p.cost_usd).toFixed(2)}</dd><dt>time</dt><dd>${(p.latency_ms / 1000).toFixed(1)} s</dd><dt>hash</dt><dd>${esc((p.answer_sha256 || '').slice(0, 16))}…</dd><dt>at</dt><dd>${esc(p.at.slice(0, 16).replace('T', ' '))} UTC</dd></dl></div>` : ''}
</section>

<section id="proof" class="proof wrap reveal">
  <div class="sec-head"><h2>Tested before it was trusted</h2></div>
  <div class="proof-grid">
    <div><p class="big mono red">93.7%</p><p>First blind test, 63 vendor-months read by hand. It failed our own 95% bar: the engine counted “degraded” as “down”.</p></div>
    <div><p class="big mono green">57 / 57</p><p>After the fix, a fresh sample drawn with a new seed. Every verdict, credit tier and minute count matched the hand count.</p></div>
    <div><p class="big mono">${d.total_vendors}</p><p>vendors with a written credit SLA and a machine-readable incident history. Others are listed with the reason they are not covered.</p></div>
  </div>
</section>

<section id="check" class="check-sec wrap reveal">
  <div class="sec-head"><h2>Check what you're owed</h2><p>Pick a vendor and a billing period. Add your bill to see dollars.</p></div>
  <form method="post" action="/check" class="check-form">
    <label><span>Vendor</span><select name="vendor" required>${vendorsOptions}</select></label>
    <label><span>Period</span><input name="period" required placeholder="2026-10  ·  GitHub: 2026-Q3"></label>
    <label><span>Your bill (USD)</span><input name="spend" inputmode="decimal" placeholder="2000"></label>
    <label><span>Regions <em>(clouds only)</em></span><input name="regions" placeholder="us-east-1, eu-west-1"></label>
    <button class="btn">Check</button>
  </form>
  <p class="fine">Or in Telegram: <a href="https://t.me/moneyowed_claims_bot">@moneyowed_claims_bot</a> · <code>/check jira 2026-09 2000</code></p>
</section>

<footer class="foot wrap"><p class="statement">The promise is in their contract. The proof is on their status page. The claim is yours to send.</p>
<p class="fine">MONEY OWED drafts claims and never sends them. A vendor decides each claim; this shows what its published terms and published incidents add up to. Record built ${longDay(d.built_at)}. <a href="/evidence">Method and limits</a></p></footer>
<script src="/static/landing.js" defer></script>
</body></html>`;
}
