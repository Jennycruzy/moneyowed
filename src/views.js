// HTML helpers. Plain, readable pages; styling is kept minimal on purpose until the visual design is set.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => (n == null ? '' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const pct = (n) => (n == null ? '' : `${Number(n).toFixed(Number(n) % 1 === 0 ? 0 : Number(n) >= 99 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}%`);
export const dt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : 'ongoing');
export const dayOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const LABEL = { OWED: 'Owed', NOT_OWED: 'Not owed', WINDOW_CLOSED: 'Window closed', PERIOD_OPEN: 'Period open', TERMS_CHANGED: 'Terms changed', NO_HISTORY: 'No history', VENDOR_NOT_COVERED: 'Not covered', PLAN_NOT_COVERED: 'No SLA on that plan', BAD_INPUT: 'Check the input', LIMIT_REACHED: 'Spending limit' };
export const badge = (code) => `<span class="badge b-${esc(code)}">${esc(LABEL[code] || code)}</span>`;

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#1b1f23;background:#fff}
header,main,footer{max-width:980px;margin:0 auto;padding:0 20px}
header{display:flex;gap:20px;align-items:center;padding-top:16px;padding-bottom:16px;border-bottom:1px solid #e5e7eb}
header a{color:#1b1f23;text-decoration:none}header .logo{font-weight:700;margin-right:auto}
section,article{margin:28px 0}h1{font-size:26px;line-height:1.3}h2{font-size:20px}h3{font-size:17px;margin-bottom:4px}
.small{font-size:13px;color:#57606a}.big{font-size:28px;font-weight:600;margin:4px 0}.k{text-transform:none;color:#57606a;margin:0}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #eaeef2;padding:6px 8px;text-align:left;vertical-align:top}
tr.out td{color:#6e7781}.mono,code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid #d0d7de;background:#f6f8fa;font-size:14px}
form.check{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:end}
label{display:flex;flex-direction:column;font-size:14px;gap:4px}input,select{font:inherit;padding:8px;border:1px solid #d0d7de;border-radius:6px}
button,.button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
form.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}form.row button{background:#fff;color:#1f6feb}
.badge{display:inline-block;font-size:13px;padding:2px 8px;border-radius:12px;background:#eaeef2;vertical-align:middle}
.b-OWED{background:#dafbe1;color:#116329}.b-WINDOW_CLOSED{background:#fff1e5;color:#953800}.b-NOT_OWED{background:#eaeef2}.b-TERMS_CHANGED,.b-LIMIT_REACHED{background:#ffebe9;color:#a40e26}
pre.claim{white-space:pre-wrap;background:#f6f8fa;padding:16px;border-radius:6px;font-size:14px}.warn{background:#fff8c5;padding:8px 12px}
.hero h1{font-size:24px}
</style></head><body><header><a class="logo" href="/">MONEY OWED</a><a href="/record">Record</a><a href="/evidence">Evidence</a></header><main>${body}</main>
<footer class="small"><p>Finds the service credits your vendors owe you under their own published SLAs. Drafts claims; never sends them. Telegraph payments run on testnet.</p></footer></body></html>`;
}
