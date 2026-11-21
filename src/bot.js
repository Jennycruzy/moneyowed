// Telegram bot (long polling). Same engine and the same Telegraph purchases as the web app.
//   /check <vendor> <period> [bill] [regions...]   verdict, amount, deadline
//   /owed                                          open claim windows across covered vendors
//   /watch <vendor>  /unwatch <vendor>  /watching  alerts when a covered breach appears
//   /vendors /help
import fs from 'node:fs';
import path from 'node:path';
import { checkCredit } from './engine.js';
import { listCards } from './cards.js';
import { openDb } from './db.js';
import { Telegraph } from './telegraph.js';
import { buySecondOpinions } from './evidence.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}`;
const DATA = path.resolve(process.env.MONEYOWED_DATA || 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const db = openDb(path.join(DATA, 'moneyowed.sqlite'));
db.db.exec('CREATE TABLE IF NOT EXISTS watches (chat_id TEXT, vendor TEXT, PRIMARY KEY (chat_id, vendor)); CREATE TABLE IF NOT EXISTS alerts_sent (chat_id TEXT, key TEXT, PRIMARY KEY (chat_id, key));');
const REGIONS = { aws: ['us-east-1', 'eu-west-1'], gcp: ['us-central1', 'europe-west1'], azure: ['East US', 'West Europe'] };
let tg = null;
if (process.env.TELEGRAPH_PRIVATE_KEY) tg = new Telegraph({ privateKey: process.env.TELEGRAPH_PRIVATE_KEY, ledger: db, limits: { perBucketUsd: Number(process.env.LIMIT_PER_USER_USD || 0.2), globalUsd: Number(process.env.LIMIT_DAILY_USD || 3) } });

async function call(method, body) {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  return r.json();
}
const send = (chat_id, text) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const money = (n) => `$${Number(n).toFixed(2)}`;

function findVendor(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cards = listCards();
  return cards.find((c) => c.vendor.replace(/[^a-z0-9]/g, '') === w) || cards.find((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === w)
    || ({ jsm: 'jira-service-management', do: 'digitalocean', gcloud: 'gcp', google: 'gcp', amazon: 'aws', microsoft: 'azure', akamai: 'linode' }[w] && cards.find((c) => c.vendor === { jsm: 'jira-service-management', do: 'digitalocean', gcloud: 'gcp', google: 'gcp', amazon: 'aws', microsoft: 'azure', akamai: 'linode' }[w]));
}

const HELP = `<b>MONEY OWED</b> finds the credits your vendors owe you under their own SLAs.

/check github 2026-Q3 6000
/check jira 2026-09 2000
/check aws 2026-10 1500 us-east-1
/owed - open claim windows now
/watch jira - alert me when Jira breaks its promise
/vendors - who is covered

Checks use the vendor's own public incident history and SLA text, and buy SLA answers on Telegraph (testnet) to compare. Claims are drafted, never sent for you.`;

async function onCheck(chat, args) {
  const [vw, period, bill, ...regions] = args;
  const card = findVendor(vw);
  if (!card || !period) return send(chat, `Usage: /check &lt;vendor&gt; &lt;period&gt; [bill] [regions]\nExample: /check github 2026-Q3 6000\nCovered: ${listCards().map((c) => c.vendor).join(', ')}`);
  const plan = card.plans[0];
  let spend = bill && !Number.isNaN(Number(bill.replace(/[$,]/g, ''))) ? Number(bill.replace(/[$,]/g, '')) : undefined;
  const regs = regions.length ? regions.join(' ').split(',').map((s) => s.trim()).filter(Boolean) : (plan.per_region ? REGIONS[card.vendor] : undefined);
  let r;
  try {
    r = checkCredit({ vendor: card.vendor, plan: plan.plan, period, regions: regs, spend: plan.services.length > 1 && spend != null ? undefined : spend });
    if (spend != null && plan.services.length > 1) {
      const t = r.services.find((s) => s.credit_pct > 0) || r.services[0];
      r = checkCredit({ vendor: card.vendor, plan: plan.plan, period, regions: regs, spend: { [t.service]: spend } });
    }
  } catch (e) { return send(chat, `${esc(e.code || 'Error')}: ${esc(e.message)}`); }
  const id = db.newId();
  db.saveCheck(id, {}, r, 'telegram');
  const owed = r.services.filter((s) => s.credit_pct > 0);
  const lines = [];
  const head = { OWED: '✅ Owed', WINDOW_CLOSED: '⌛ Was owed, window closed', NOT_OWED: 'Not owed', PERIOD_OPEN: 'Period still running' }[r.code];
  lines.push(`<b>${head}</b> · ${esc(r.plan_label)} · ${esc(r.period)}${r.regions.length ? ` · ${esc(r.regions.join(', '))}` : ''}`);
  for (const s of r.services) lines.push(`${esc(s.service)}: ${s.uptime_pct}% vs ${s.threshold_pct}% · ${s.covered_minutes} min counted${s.credit_pct ? ` · <b>${s.credit_pct}%</b>${s.credit_usd != null ? ` = ${money(s.credit_usd)}` : ''}` : ''}`);
  if (owed.length) lines.push(r.deadline ? `Claim by <b>${day(r.deadline)}</b> (${r.days_left >= 0 ? `${r.days_left} days left` : 'closed'}). ${esc(r.deadline_rule)}.` : esc(r.deadline_rule));
  if (owed.length && !r.credit_usd_total && spend == null) lines.push('Add your bill to see dollars: /check ' + `${card.vendor} ${period} 2000`);
  if (PUBLIC_URL) lines.push(`${PUBLIC_URL}/check/${id}${['OWED', 'PERIOD_OPEN'].includes(r.code) && owed.length ? `  ·  claim draft: ${PUBLIC_URL}/claim/${id}` : ''}`);
  await send(chat, lines.join('\n'));
  if (tg) {
    try {
      const ev = await buySecondOpinions(tg, r, { bucket: `tg:${chat}`, checkId: id, reuse: (q, m) => db.recentAnswer(q, m) });
      db.db.prepare("UPDATE checks SET result = json_set(result, '$.evidence', json(?)) WHERE id = ?").run(JSON.stringify(ev), id);
      const got = ev.opinions.filter((o) => !o.skipped && !o.error && o.cost_usd > 0);
      const txt = ev.opinions.filter((o) => !o.skipped).map((o) => o.error ? `${esc(o.label)}: ${esc(o.error)}` : `${esc(o.miner_name || o.label)}: ${o.uptime_pct != null ? `${o.uptime_pct}%` : 'no figure'}${o.agrees === true ? ' (same verdict)' : o.agrees === false ? ' (<b>different verdict</b>)' : ''}${o.notes?.length ? ` - ${esc(o.notes[0])}` : ''}`).join('\n');
      await send(chat, `<b>Telegraph second opinions</b> (${money(got.reduce((t, o) => t + o.cost_usd, 0))} paid, testnet)\n${txt}`);
    } catch (e) { await send(chat, `Telegraph purchase failed: ${esc(e.message)}`); }
  }
}

function openWindows() {
  const f = path.join(DATA, 'record.json');
  if (!fs.existsSync(f)) return [];
  const now = Date.now();
  return JSON.parse(fs.readFileSync(f, 'utf8')).rows.filter((x) => x.owed && x.deadline && new Date(x.deadline) > now);
}

async function onOwed(chat) {
  const rows = openWindows().sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  if (!rows.length) return send(chat, 'No claim window is open right now for the covered vendors (clouds counted for us-east-1/eu-west-1, us-central1/europe-west1, East US/West Europe).');
  return send(chat, `<b>Open claim windows</b>\n${rows.slice(0, 25).map((x) => `${esc(x.vendor_name)} ${esc(x.plan_label.replace(x.vendor_name, '').trim())} ${esc(x.period)} · ${esc(x.service)}: ${x.uptime_pct}% → ${x.credit_pct}% · claim by ${day(x.deadline)}`).join('\n')}`);
}

// Alerts: after each record rebuild, tell watchers about owed rows they have not been told about.
async function sendAlerts() {
  const rows = openWindows();
  for (const w of db.db.prepare('SELECT chat_id, vendor FROM watches').all()) {
    for (const x of rows.filter((r) => r.vendor === w.vendor)) {
      const key = `${x.vendor}|${x.plan}|${x.period}|${x.service}`;
      if (db.db.prepare('SELECT 1 FROM alerts_sent WHERE chat_id = ? AND key = ?').get(w.chat_id, key)) continue;
      await send(w.chat_id, `🔔 <b>${esc(x.vendor_name)}</b> missed its promise: ${esc(x.service)} ${x.uptime_pct}% vs ${x.threshold_pct}% in ${esc(x.period)}. Credit tier ${x.credit_pct}%. Claim by ${day(x.deadline)}.\n/check ${x.vendor} ${x.period}`);
      db.db.prepare('INSERT OR IGNORE INTO alerts_sent VALUES (?,?)').run(w.chat_id, key);
    }
  }
}

async function handle(msg) {
  const chat = String(msg.chat.id);
  const [cmdRaw, ...args] = String(msg.text || '').trim().split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  if (cmd === '/start' || cmd === '/help') return send(chat, HELP);
  if (cmd === '/check') return onCheck(chat, args);
  if (cmd === '/owed') return onOwed(chat);
  if (cmd === '/vendors') return send(chat, listCards().map((c) => `${c.vendor} - ${esc(c.name)} (${c.plans.map((p) => p.plan).join(', ')})`).join('\n'));
  if (cmd === '/watch' || cmd === '/unwatch') {
    const card = findVendor(args[0]);
    if (!card) return send(chat, `Which vendor? e.g. ${cmd} jira`);
    if (cmd === '/watch') { db.db.prepare('INSERT OR IGNORE INTO watches VALUES (?,?)').run(chat, card.vendor); await send(chat, `Watching ${esc(card.name)}. You'll get a message when it misses its SLA in a way that owes a credit.`); return sendAlerts(); }
    db.db.prepare('DELETE FROM watches WHERE chat_id = ? AND vendor = ?').run(chat, card.vendor);
    return send(chat, `Stopped watching ${esc(card.name)}.`);
  }
  if (cmd === '/watching') { const w = db.db.prepare('SELECT vendor FROM watches WHERE chat_id = ?').all(chat).map((x) => x.vendor); return send(chat, w.length ? `Watching: ${w.join(', ')}` : 'Not watching any vendor. Try /watch jira'); }
  return send(chat, 'Try /check github 2026-Q3 6000 or /help');
}

let offset = 0;
let lastAlert = 0;
console.log('bot polling');
for (;;) {
  try {
    const r = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    for (const u of r.result || []) {
      offset = u.update_id + 1;
      if (u.message?.text) handle(u.message).catch((e) => console.error('handle', e.message));
    }
    if (Date.now() - lastAlert > 15 * 60000) { lastAlert = Date.now(); sendAlerts().catch((e) => console.error('alerts', e.message)); }
  } catch (e) { console.error('poll', e.message); await new Promise((res) => setTimeout(res, 3000)); }
}
