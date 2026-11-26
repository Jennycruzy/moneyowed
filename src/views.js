// HTML helpers and the shared shell for every page after the landing page (same nav, type and footer as the landing).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => (n == null ? '' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const pct = (n) => (n == null ? '' : `${Number(n).toFixed(Number(n) % 1 === 0 ? 0 : Number(n) >= 99 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}%`);
export const dt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : 'ongoing');
export const dayOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
// When a claim window closes, as a moment: "00:00 UTC on 16 Jul 2026".
export const closesAt = (d) => (d ? `${new Date(d).toISOString().slice(11, 16)} UTC on ${longDay(d)}` : '');
export const longDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const LABEL = { OWED: 'Owed', NOT_OWED: 'Not owed', WINDOW_CLOSED: 'Window closed', PERIOD_OPEN: 'Period open', TERMS_CHANGED: 'Terms changed', NO_HISTORY: 'No history', VENDOR_NOT_COVERED: 'Not covered', PLAN_NOT_COVERED: 'No SLA on that plan', BAD_INPUT: 'Check the input', LIMIT_REACHED: 'Spending limit' };
export const badge = (code) => `<span class="badge b-${esc(code)}">${esc(LABEL[code] || code)}</span>`;

const NAV = [['/record', 'Record', 'record', ''], ['/evidence', 'Evidence', 'evidence', 'hide-xs']];

// opts: { active: 'check'|'record'|'evidence'|'claim', description }
export function page(title, body, opts = {}) {
  const links = NAV.map(([href, label, key, cls]) => `<a${cls ? ` class="${cls}"` : ''} href="${href}"${opts.active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · MONEY OWED</title><meta name="description" content="${esc(opts.description || 'Find the SLA credits your vendors owe you, proved incident by incident, with the claim drafted.')}">
<link rel="preload" href="/static/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/site.css"></head><body class="app">
<header class="nav wrap"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>MONEY OWED</a>
<nav><a class="hide-sm" href="/#year">The year</a><a class="hide-sm" href="/#how">How it decides</a>${links}<a class="btn small"${opts.active === 'check' ? ' aria-current="page"' : ''} href="/check">Check yours</a></nav></header>
<main class="wrap">${body}</main>
<footer class="foot wrap"><nav class="foot-nav"><a href="/">Home</a><a href="/check">Check yours</a><a href="/record">Record</a><a href="/evidence">Evidence</a><a href="/sample-invoice">Browser extension</a><a href="https://t.me/moneyowed_claims_bot">Telegram bot</a></nav><p class="statement">The promise is in their contract. The proof is on their status page. The claim is yours to send.</p>
<p class="fine">MONEY OWED drafts claims and never sends them. Telegraph payments run on testnet. <a href="/evidence">Method and limits</a></p></footer>
<script src="/static/app.js" defer></script>
</body></html>`;
}

// Page header: small label, large title, optional lede.
export const phead = (label, title, lede = '') => `<header class="phead">${label ? `<p class="k">${label}</p>` : ''}<h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
