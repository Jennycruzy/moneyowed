// Every page after the landing page: check, result, claim, record, evidence, sample invoice.
// Same type, colour and layout language as the landing page. Server-rendered; small progressive JS in static/app.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listCards } from './cards.js';
import { NOT_COVERED } from './vendors.js';
import { draftClaim } from './claim.js';
import { page, phead, esc, money, pct, dt, dayOnly, longDay, badge } from './views.js';

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const unit = (period) => (String(period).includes('Q') ? 'quarter' : 'month');
// "GitHub" + "GitHub Enterprise Cloud" -> "Enterprise Cloud"; keeps the plan readable next to the vendor name.
const planOnly = (vendor, label) => String(label || '').replace(new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '') || label;
const windowCell = (deadline) => {
  if (!deadline) return '<span class="pill">not stated</span>';
  const open = new Date(deadline) > new Date();
  return `<span class="pill ${open ? 'pill-open' : ''}">${open ? 'open to' : 'closed'} ${longDay(deadline)}</span>`;
};

export function makePages({ db, jobs, loadRecord, ROOT, DEFAULT_REGIONS, REGION_CHOICES }) {
  // ---------- check form
  function checkForm(prefill = {}) {
    const cards = listCards();
    const rec = loadRecord();
    const open = (rec?.rows || []).filter((r) => r.owed && r.deadline && new Date(r.deadline) > new Date())
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline)).slice(0, 4);
    const vendorOpts = cards.map((c) => `<option value="${esc(c.vendor)}"${(prefill.vendor || 'github') === c.vendor ? ' selected' : ''} data-period="${esc(c.plans[0].period)}" data-region="${c.plans[0].per_region ? '1' : ''}" data-plans="${esc(JSON.stringify(c.plans.map((p) => [p.plan, p.label])))}">${esc(c.name)}</option>`).join('');
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    return page('Check what you are owed', `${phead('Check', 'What does your vendor owe you?', 'Pick the vendor and the billing period. Add what you paid to see dollars. The answer comes from the vendor\'s own incident records and the vendor\'s own contract.')}
<div class="split">
  <form method="post" action="/check" class="panel form" id="checkform">
    <label class="f-wide"><span>Vendor</span><select name="vendor" required id="f-vendor">${vendorOpts}</select></label>
    <label><span>Plan</span><select name="plan" id="f-plan"><option value="">The vendor's plan with an SLA</option></select></label>
    <label><span>Billing period</span><input name="period" required id="f-period" value="${esc(prefill.period || '')}" placeholder="${lastMonth}" autocomplete="off"><em id="f-period-hint">A month, written ${lastMonth}. GitHub bills SLAs per quarter: 2026-Q3.</em></label>
    <label><span>What you paid (USD)</span><input name="spend" inputmode="decimal" placeholder="2000" autocomplete="off"><em>Optional. Gives the credit in dollars.</em></label>
    <label class="f-wide" id="f-regions-wrap"><span>Your regions</span><input name="regions" id="f-regions" placeholder="us-east-1, eu-west-1"><em>AWS, Google Cloud and Azure credit each region separately.</em></label>
    <button class="btn f-wide">Check</button>
  </form>
  <aside class="side">
    <h2 class="side-h">What you get back</h2>
    <ol class="steps">
      <li><b>The verdict and the amount.</b> Owed or not, the credit tier, and the dollars if you gave your bill.</li>
      <li><b>Every incident in the period.</b> Counted or not, and the reason in the contract's terms.</li>
      <li><b>The contract sentence</b> each number comes from, word for word.</li>
      <li><b>The claim, drafted</b> in the vendor's format, with the last day to send it.</li>
      <li><b>Second opinions from Telegraph</b> agents, paid per answer, with receipts. And a proof file anyone can recompute offline.</li>
    </ol>
  </aside>
</div>
${open.length ? `<section class="block"><div class="block-head"><h2>Claims you can still make</h2><p>Breaches in the record whose claim window is still open.</p></div>
<div class="cards4">${open.map((r) => `<a class="mini" href="/check?vendor=${esc(r.vendor)}&amp;period=${esc(r.period)}"><span class="k">${esc(r.vendor_name)} · ${esc(r.period)}</span><span class="mini-num mono">${r.credit_pct}%</span><span>of the ${unit(r.period)}'s bill · ${esc(r.service)}</span><span class="fine">claim by ${longDay(r.deadline)}</span></a>`).join('')}</div></section>` : ''}
<section class="block"><div class="block-head"><h2>Covered vendors</h2><p>Each has a written credit SLA and a public incident history a program can read. <a href="/evidence#not-covered">Not covered, and why</a></p></div>
<ul class="chips">${cards.map((c) => `<li>${esc(c.name)} <span>${esc(c.plans.map((p) => planOnly(c.name, p.label)).join(' · '))}</span></li>`).join('')}</ul></section>`, { active: 'check' });
  }

  // ---------- one check
  function checkPage(id) {
    const row = db.getCheck(id);
    if (!row) return null;
    const r = row.result;
    const job = jobs.get(id);
    const owed = r.services.filter((s) => s.credit_pct > 0);
    const amount = r.credit_usd_total != null ? money(r.credit_usd_total) : `${owed.map((s) => `${s.credit_pct}%`).join(' + ')} of the bill`;
    const title = {
      OWED: `${esc(r.vendor_name)} owes you ${amount}`,
      WINDOW_CLOSED: `${amount} was owed. The claim window closed ${longDay(r.deadline)}.`,
      NOT_OWED: `${esc(r.vendor_name)} kept its promise for ${esc(r.period)}`,
      PERIOD_OPEN: `${esc(r.period)} is still running`,
    }[r.code];
    const lede = {
      OWED: `Claim by <b>${longDay(r.deadline)}</b>, ${r.days_left} days from now (${esc(r.deadline_rule)}). The vendor pays only if you ask.`,
      WINDOW_CLOSED: `${esc(r.deadline_rule)}. Below is what a claim would have said, and the proof behind it.`,
      NOT_OWED: 'Counted outage stayed inside what the contract allows.',
      PERIOD_OPEN: 'Figures so far. The verdict is final when the period ends.',
    }[r.code];
    const actions = [
      ['OWED', 'PERIOD_OPEN'].includes(r.code) && owed.length ? `<a class="btn" href="/claim/${esc(id)}">Open the claim draft</a>` : '',
      `<a class="btn ghost" href="/check/${esc(id)}/proof.json">Download proof file</a>`,
      `<a class="btn ghost" href="/check/${esc(id)}.json">JSON</a>`,
    ].join('');
    const svc = r.services.map((s) => {
      const counted = s.incidents.filter((i) => i.in_scope);
      const over = s.allowed_minutes > 0 ? Math.min(100, (s.covered_minutes / Math.max(s.allowed_minutes, s.covered_minutes)) * 100) : 0;
      const allowPos = s.covered_minutes > s.allowed_minutes ? (s.allowed_minutes / s.covered_minutes) * 100 : 100;
      return `<article class="panel svc">
  <div class="svc-head"><div><p class="k">${esc(s.service)}</p><p class="big mono">${pct(s.uptime_pct)}<span class="vs">against a ${pct(s.threshold_pct)} promise</span></p></div>
  <div class="owe"><p class="k">Credit</p><p class="big mono ${s.credit_pct > 0 ? 'red' : ''}">${s.credit_pct}%</p>${s.credit_usd != null ? `<p class="fine">${money(s.credit_usd)} of ${money(s.fee)}</p>` : s.credit_pct > 0 ? '<p class="fine">add your bill for dollars</p>' : ''}</div></div>
  <div class="budget" role="img" aria-label="${s.covered_minutes} minutes counted, ${s.allowed_minutes} allowed"><i style="width:${over.toFixed(2)}%" class="${s.covered_minutes > s.allowed_minutes ? 'over' : ''}"></i><b style="left:${allowPos.toFixed(2)}%"></b></div>
  <p class="budget-l"><span><b>${s.covered_minutes}</b> min of covered outage counted</span><span>${s.allowed_minutes} min allowed${s.minutes_to_next_tier ? ` · ${s.minutes_to_next_tier} more would owe a credit` : ''}</span></p>
  ${s.config_note ? `<p class="fine">Configuration: ${esc(s.config_note)}</p>` : ''}${s.measure_note ? `<p class="fine">${esc(s.measure_note)}</p>` : ''}
  <details ${s.credit_pct > 0 ? 'open' : ''}><summary>Incidents in the period: ${counted.length} counted of ${s.incidents.length}</summary>
  <div class="tscroll"><table class="inc-t"><thead><tr><th></th><th>Start (UTC)</th><th>End</th><th class="num">Min</th><th>Incident</th><th>Why</th></tr></thead><tbody>
  ${s.incidents.map((i) => `<tr class="${i.in_scope ? 'in' : 'out'}"><td>${i.in_scope ? '<span class="dot" title="counted"></span>' : ''}</td><td class="mono">${dt(i.start)}</td><td class="mono">${dt(i.end)}</td><td class="num mono">${i.in_scope ? i.minutes : ''}</td><td>${i.url ? `<a href="${esc(i.url)}">${esc(i.name)}</a>` : esc(i.name)}</td><td class="why">${esc(i.reason)}</td></tr>`).join('')}
  </tbody></table></div></details>
  <details><summary>The contract terms used</summary><blockquote>${esc(s.quotes.threshold)}</blockquote><blockquote>${esc(s.quotes.tiers)}</blockquote>${s.quotes.scope ? `<blockquote>${esc(s.quotes.scope)}</blockquote>` : ''}</details>
</article>`;
    }).join('');
    const ev = r.evidence;
    const verdictOf = (o) => (o.uptime_pct != null ? `${pct(o.uptime_pct)} ${o.compliant === true ? 'met' : o.compliant === false ? 'missed' : ''}` : 'no figure');
    const evHtml = job === 'buying' ? '<p class="panel pad">Buying SLA answers on Telegraph. This page refreshes by itself.</p><meta http-equiv="refresh" content="4">'
      : ev ? `<div class="tscroll"><table class="ev-t"><thead><tr><th>Asked</th><th>Answered by</th><th>Their answer</th><th>Same verdict?</th><th>Notes</th><th class="num">Paid</th><th class="num">Time</th><th>Answer hash</th></tr></thead><tbody>${ev.opinions.map((o) => o.skipped ? `<tr class="out"><td>${esc(o.label)}</td><td colspan="7">${esc(o.skipped)}</td></tr>`
        : o.error ? `<tr class="out"><td>${esc(o.label)}</td><td colspan="7">${esc(o.error)}</td></tr>`
          : `<tr><td>${esc(o.label)}${o.reused ? '<br><span class="fine">reused, under 1 h old</span>' : ''}</td><td>${esc(o.miner_name || '')}<br><span class="fine mono">${esc(o.miner_id || '')}</span></td><td class="mono">${verdictOf(o)}<br><span class="fine">${esc(o.period_label || '')}</span></td><td>${o.agrees === true ? '<span class="pill pill-open">yes</span>' : o.agrees === false ? '<span class="pill pill-red">no</span>' : '<span class="pill">?</span>'}</td><td class="why">${esc((o.notes || []).join('; '))}</td><td class="num mono">${money(o.cost_usd)}</td><td class="num mono">${(o.latency_ms / 1000).toFixed(1)} s</td><td class="mono">${esc((o.answer_sha256 || '').slice(0, 12))}</td></tr>`).join('')}</tbody></table></div>
<p class="fine">Question sent: <code>${esc(JSON.stringify(ev.question.params))}</code>. Paid through Telegraph escrow on testnet (Ethereum Sepolia, test USDC). The verdict above comes from the vendor's records and contract; bought answers are shown beside it, never instead of it.</p>`
        : job ? `<p class="panel pad">${esc(job)}</p>` : '<p class="fine">No Telegraph purchase for this check.</p>';
    return page(`${r.vendor_name} ${r.period}`, `${phead(`${badge(r.code)} ${esc(r.plan_label)} · ${esc(r.period)} · ${dayOnly(r.period_start)} to ${dayOnly(new Date(+new Date(r.period_end) - 1))}${r.regions.length ? ` · ${esc(r.regions.join(', '))}` : ''}`, title, lede)}
<div class="actions">${actions}</div>
${r.spend_note ? `<p class="note">${esc(r.spend_note)}</p>` : ''}${(r.card.page_changed || []).length ? '<p class="note">The SLA page changed since its rule card was checked. Every quoted term is still on it word for word.</p>' : ''}
<div class="stack">${svc}</div>
<section class="block"><div class="block-head"><h2>Second opinions from Telegraph</h2><p>SLA answers bought from agents on Telegraph for this exact question, with what each one cost.</p></div>${evHtml}</section>
<section class="block meta"><p class="fine">Contract: <a href="${esc(r.card.sla_url)}">${esc(r.card.sla_url)}</a>, rule card checked ${esc(r.card.checked_at)}. ${r.card.notes.map(esc).join(' ')}</p>
<p class="fine">Incident history collected ${dt(r.history.collected_at)} UTC · method ${esc(r.method_version)} · counting: ${r.mode === 'lower' ? 'major outages only' : 'partial and major outages'}. Recompute this result offline: <code>node bin/moneyowed.js verify moneyowed-proof-${esc(id)}.json</code></p></section>`, { active: 'check' });
  }

  // ---------- claim
  function claimPage(id) {
    const row = db.getCheck(id);
    if (!row) return null;
    let d;
    try { d = draftClaim(row.result); } catch (e) { return page('No claim', `${phead('Claim', 'Nothing to claim', esc(e.message))}<p><a class="btn ghost" href="/check/${esc(id)}">Back to the check</a></p>`, { active: 'check' }); }
    const r = row.result;
    const c = db.getClaim(id);
    const status = c?.status || 'drafted';
    const mailto = `mailto:?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
    const steps = [['drafted', 'Drafted'], ['sent', 'Sent'], ['credited', 'Credited']];
    const at = status === 'refused' || status === 'declined' ? -1 : steps.findIndex(([k]) => k === status);
    return page('Claim draft', `${phead(`Claim · ${esc(r.vendor_name)} · ${esc(r.period)}`, `Ask ${esc(r.vendor_name)} for ${r.credit_usd_total != null ? money(r.credit_usd_total) : 'your credit'}`, `Send it yourself. MONEY OWED never sends anything.${r.deadline ? ` Last day: <b>${longDay(r.deadline)}</b>.` : ''}`)}
<div class="split claim-split">
  <div><div class="panel letter"><div class="letter-bar"><span class="fine">${esc(d.subject)}</span><button type="button" class="btn small ghost" data-copy="#claimtext">Copy</button></div><pre id="claimtext">${esc(d.body)}</pre></div></div>
  <aside class="side">
    <h2 class="side-h">Send to</h2><p>${esc(d.to)}</p>
    <p><a class="btn" href="${esc(mailto)}">Open in my email</a></p>
    <h2 class="side-h">Track it</h2>
    <ol class="track">${steps.map(([k, label], i) => `<li class="${at >= i ? 'done' : ''}">${label}</li>`).join('')}${status === 'refused' ? '<li class="done red">Refused</li>' : ''}${status === 'declined' ? '<li class="done">Not claiming</li>' : ''}</ol>
    <form method="post" action="/claim/${esc(id)}/status" class="status-f">
      <button name="status" value="sent">I sent it</button><button name="status" value="credited">Vendor credited it</button><button name="status" value="refused">Vendor refused</button><button name="status" value="declined">I'm not claiming</button>
      <input name="note" placeholder="The vendor's reply (optional)">
    </form>
    <p class="fine"><a href="/check/${esc(id)}">← Back to the check and its proof</a></p>
  </aside>
</div>`, { active: 'check' });
  }

  // ---------- the 12-month record
  function recordPage() {
    const rec = loadRecord();
    if (!rec) return page('The record', phead('Record', 'The record is being built', 'It is rebuilt every hour from the archived incident history.'), { active: 'record' });
    const rows = rec.rows.filter((r) => r.owed).sort((a, b) => b.period.localeCompare(a.period) || a.vendor_name.localeCompare(b.vendor_name));
    const vendors = [...new Set(rows.map((r) => r.vendor_name))].sort();
    const openN = rows.filter((r) => r.deadline && new Date(r.deadline) > new Date()).length;
    return page('The record', `${phead('Record', 'Every broken uptime promise in the last 12 months', `Each row is a ${'month or quarter'} where a covered vendor's own incident history put it below its own written promise, so its customers were owed a credit. Rebuilt every hour.`)}
<div class="stats"><div><p class="big mono">${rec.rows.length}</p><p>vendor-periods checked</p></div><div><p class="big mono red">${rows.length}</p><p>owed a credit</p></div><div><p class="big mono">${openN}</p><p>still open to claim today</p></div><div><p class="big mono">${vendors.length}</p><p>vendors with a breach</p></div></div>
<div class="filter" data-filter="#rec"><button type="button" class="chip on" data-v="">All</button>${vendors.map((v) => `<button type="button" class="chip" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>
<div class="tscroll"><table class="rec-t" id="rec"><thead><tr><th>Period</th><th>Vendor</th><th>Covered service</th><th class="num">Uptime</th><th class="num">Promise</th><th class="num">Credit</th><th>Claim window</th><th></th></tr></thead><tbody>
${rows.map((r) => `<tr data-v="${esc(r.vendor_name)}"><td class="mono">${esc(r.period)}</td><td><b>${esc(r.vendor_name)}</b><br><span class="fine">${esc(planOnly(r.vendor_name, r.plan_label))}</span></td><td>${esc(r.service)}</td><td class="num mono">${pct(r.uptime_pct)}</td><td class="num mono">${pct(r.threshold_pct)}</td><td class="num mono red">${r.credit_pct}%</td><td>${windowCell(r.deadline)}</td><td><a class="go" href="/check?vendor=${esc(r.vendor)}&amp;period=${esc(r.period)}" aria-label="Check ${esc(r.vendor_name)} ${esc(r.period)}">Check →</a></td></tr>`).join('')}
</tbody></table></div>
<p class="fine">Built ${dt(rec.built_at)} UTC. Clouds are counted for regions ${Object.entries(DEFAULT_REGIONS).map(([k, v]) => `${k} ${v.join(' + ')}`).join('; ')}. Download: <a href="/record.csv">CSV</a> · <a href="/record.json">JSON</a></p>`, { active: 'record', description: 'Every SLA breach by GitHub, Atlassian, Vercel, AWS and other vendors in the last 12 months, from their own incident history.' });
  }

  // ---------- evidence
  function minerSection() {
    const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'miner', f), 'utf8')); } catch { return null; } };
    const reg = read('registration.json');
    if (!reg) return '';
    const acc = read('accuracy.json');
    const yamlFile = path.join(ROOT, 'miner', 'moneyowed-sla.yaml');
    const yamlHash = fs.existsSync(yamlFile) ? crypto.createHash('sha256').update(fs.readFileSync(yamlFile)).digest('hex') : '';
    const st = db.minerStats();
    const tx = (h) => `<a class="mono" href="https://sepolia.etherscan.io/tx/${esc(h)}">${esc(h.slice(0, 10))}…</a>`;
    return `<section class="block" id="miner"><div class="block-head"><h2>Our SLA miner on Telegraph</h2><p>The same engine answers <b>${esc(reg.intent)}</b> for any Telegraph buyer, as miner <b class="mono">${esc(reg.miner_id)}</b>. It is run by the MONEY OWED team, so when a check here buys its answer the row says so, and it never counts as an outside opinion.</p></div>
<dl class="facts"><div><dt>Registration</dt><dd>${esc(reg.registration_id)} on ${esc(reg.chain)} · ${tx(reg.register_tx)} · updated ${tx(reg.update_tx)}</dd></div>
<div><dt>Miner file</dt><dd><a href="/miner.yaml">miner.yaml</a> · sha256 <span class="mono">${esc(yamlHash.slice(0, 16))}…</span>, the hash stored on chain</dd></div>
<div><dt>Ask it directly</dt><dd><a class="mono" href="/miner/sla?service=GitHub&amp;period=2026-Q3">/miner/sla?service=GitHub&amp;period=2026-Q3</a></dd></div>
<div><dt>Calls served</dt><dd>${st.n || 0} (${st.ok || 0} answered)${st.last ? `, last ${esc(dt(st.last))} UTC` : ''}</dd></div></dl>
${acc ? `<h3 class="sub">Every SLA miner against hand-checked truth</h3><p class="body">${esc(acc.items)} vendor-months whose correct answer was worked out by hand before any miner was asked. Each miner got the same question, paid through Telegraph, under rules fixed in advance (sha256 <span class="mono">${esc(acc.protocol_sha256.slice(0, 12))}…</span>). Our miner uses the same counting rules as the hand check, so its row is not an independent test. "Answered" counts replies with an uptime figure or a verdict; several miners were paid for replies with neither. Run ${longDay(acc.run_at)}, ${money(acc.table.reduce((t, r) => t + r.spent, 0))} spent.</p>
<div class="tscroll"><table class="acc-t"><thead><tr><th>Miner</th><th class="num">Answered</th><th class="num">Verdict right</th><th class="num">Uptime within 0.01 pt</th><th class="num">Breaches caught</th></tr></thead><tbody>${acc.table.map((r) => `<tr class="${r.own ? 'own' : ''}"><td>${esc(r.name)} <span class="fine mono">${esc(r.miner)}${r.own ? ' · ours' : ''}</span></td><td class="num mono">${r.answered}/${r.asked}</td><td class="num mono">${r.verdict_right}/${r.asked}</td><td class="num mono">${r.uptime_close}/${r.asked}</td><td class="num mono">${r.owed_caught}/${r.owed_total}</td></tr>`).join('')}</tbody></table></div>` : ''}
</section>`;
  }

  function evidencePage() {
    const paid = db.allPurchases(500).filter((p) => p.paid);
    return page('Evidence', `${phead('Evidence', 'How every number is checked', 'Nothing here asks you to trust us. Each step can be re-run from public data, and each check ships with a proof file that recomputes offline.')}
<div class="method">
  <div><p class="num-l mono">01</p><h3>The vendor's own records</h3><p>Each vendor's public incident history, read every hour and archived exactly as fetched, with its sha256.</p></div>
  <div><p class="num-l mono">02</p><h3>The vendor's own contract</h3><p>One rule card per plan. Every threshold, tier, cap and claim deadline sits next to the sentence it came from, re-checked against the live page every night.</p></div>
  <div><p class="num-l mono">03</p><h3>Only what the contract covers</h3><p>Time the vendor itself marked a covered service as down. Slowdowns and planned maintenance do not count, because the contracts say they do not.</p></div>
  <div><p class="num-l mono">04</p><h3>Plain code decides</h3><p>Minutes, uptime, tier, cap, deadline. A language model never sets a number. Bought answers are shown beside the result, never instead of it.</p></div>
</div>
<section class="block"><div class="block-head"><h2>Tested before it was trusted</h2><p>Vendor-periods drawn by a fixed seed, every incident read by hand against the contract before the engine ran.</p></div>
<div class="stats"><div><p class="big mono red">93.7%</p><p>First run. It failed our own 95% bar: degraded time was counted as down.</p></div><div><p class="big mono green">57 / 57</p><p>After the fix, on a fresh sample: verdict, credit tier and minutes all matched.</p></div><div><p class="big mono">${paid.length}</p><p>paid Telegraph answers on this server, ${money(paid.reduce((t, p) => t + p.cost_usd, 0))} in total, median ${median(paid.map((p) => p.latency_ms / 1000)).toFixed(1)} s. <a href="/purchases.json">All of them</a></p></div></div></section>
${minerSection()}
<section class="block" id="not-covered"><div class="block-head"><h2>Vendors not covered, and why</h2><p>A vendor is covered only with a written credit SLA and an incident history a program can read.</p></div>
<dl class="facts">${NOT_COVERED.map((n) => `<div><dt>${esc(n.name)}</dt><dd>${esc(n.reason)}</dd></div>`).join('')}</dl></section>`, { active: 'evidence' });
  }

  // ---------- sample invoice (labelled), for trying the browser extension
  const SAMPLE_FROM = { github: 'billing@github.com', jira: 'billing@atlassian.com', confluence: 'billing@atlassian.com', 'jira-service-management': 'billing@atlassian.com', bitbucket: 'billing@atlassian.com', vercel: 'billing@vercel.com', digitalocean: 'billing@digitalocean.com', twilio: 'billing@twilio.com', linode: 'billing@linode.com', mailgun: 'billing@mailgun.com', sanity: 'billing@sanity.io', prisma: 'billing@prisma.io', mapbox: 'billing@mapbox.com', buildkite: 'billing@buildkite.com' };
  function sampleInvoice() {
    const rec = loadRecord();
    const firstPlan = Object.fromEntries(listCards().map((c) => [c.vendor, c.plans[0].plan]));
    const rows = (rec?.rows || []).filter((r) => r.owed && SAMPLE_FROM[r.vendor] && !r.period.includes('Q') && r.plan === firstPlan[r.vendor]);
    const open = rows.filter((r) => r.deadline && new Date(r.deadline) > new Date());
    const r = (open.length ? open : rows).sort((a, b) => (a.period < b.period ? 1 : -1))[0];
    if (!r) return page('Sample invoice', phead('Sample', 'No sample available right now'));
    const [y, mo] = r.period.split('-').map(Number);
    const monthName = new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    return page('Sample invoice email', `${phead('MONEY OWED SAMPLE · not a real invoice', 'Try the browser extension here', 'Install the extension, then click its icon on this page. It reads this text the same way it reads an open invoice email in Gmail.')}
<p class="actions"><a class="btn" href="/extension.zip">Download the extension</a><span class="fine">Unzip, open chrome://extensions, turn on Developer mode, Load unpacked.</span></p>
<div class="panel invoice" data-from="${esc(SAMPLE_FROM[r.vendor])}">
<p class="fine">From: ${esc(r.vendor_name)} billing &lt;${esc(SAMPLE_FROM[r.vendor])}&gt; (sample)</p>
<h2>${esc(r.vendor_name)} invoice for ${monthName} ${y}</h2>
<p>${esc(r.plan_label)} subscription, ${monthName} 1 to end of month, ${y}.</p>
<p class="inv-total">Total due: $2,000.00</p>
<p class="fine">MONEY OWED SAMPLE.</p></div>`, { active: '' });
  }

  const notFound = () => page('Not found', `${phead('404', 'Nothing here', 'The page may have moved.')}<p class="actions"><a class="btn" href="/check">Check what you're owed</a><a class="btn ghost" href="/">Home</a></p>`);
  const errorPage = (code, message) => page('Cannot check', `${phead(badge(code), esc(message))}<p class="actions"><a class="btn" href="/check">Try again</a></p>`, { active: 'check' });

  return { checkForm, checkPage, claimPage, recordPage, evidencePage, sampleInvoice, notFound, errorPage };
}
