// HTML helpers. Plain, readable pages; styling is kept minimal on purpose until the visual design is set.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => (n == null ? '' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const pct = (n) => (n == null ? '' : `${Number(n).toFixed(Number(n) % 1 === 0 ? 0 : Number(n) >= 99 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}%`);
export const dt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : 'ongoing');
export const dayOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const LABEL = { OWED: 'Owed', NOT_OWED: 'Not owed', WINDOW_CLOSED: 'Window closed', PERIOD_OPEN: 'Period open', TERMS_CHANGED: 'Terms changed', NO_HISTORY: 'No history', VENDOR_NOT_COVERED: 'Not covered', PLAN_NOT_COVERED: 'No SLA on that plan', BAD_INPUT: 'Check the input', LIMIT_REACHED: 'Spending limit' };
export const badge = (code) => `<span class="badge b-${esc(code)}">${esc(LABEL[code] || code)}</span>`;

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · MONEY OWED</title>
<link rel="stylesheet" href="/static/site.css"></head><body class="inner">
<header class="nav wrap"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>MONEY OWED</a><nav><a href="/record">Record</a><a href="/evidence">Evidence</a><a class="btn small" href="/#check">Check yours</a></nav></header>
<main>${body}</main>
<footer class="foot wrap"><p class="fine">MONEY OWED drafts claims and never sends them. Telegraph payments run on testnet. <a href="/evidence">Method and limits</a></p></footer></body></html>`;
}
