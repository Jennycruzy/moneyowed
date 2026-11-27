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
import { answerObligations, obligationsView } from './obligations.js';
import { openDb } from './db.js';
import { Telegraph } from './telegraph.js';
import { buySecondOpinions, buyContractTerms } from './evidence.js';
import { page, esc, money, pct, dt, dayOnly, badge } from './views.js';
import { landingData, renderLanding } from './landing.js';
import { makePages } from './pages.js';
import { answerSla, abstainSla, shortView, ERROR_STATUS } from './miner.js';
import { buildProof } from './proof.js';
import { answerUptime, answerApiHealth, uptimeView, apiHealthView } from './probe.js';

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
async function readRaw(req) {
  let b = '';
  for await (const c of req) { b += c; if (b.length > 100000) throw new Error('request too large'); }
  return b;
}

async function readBody(req) {
  const b = await readRaw(req);
  return req.headers['content-type']?.includes('application/json') ? JSON.parse(b || '{}') : Object.fromEntries(new URLSearchParams(b));
}

// Miner routes take a JSON object, a form, or (contract route) the plain text itself.
async function minerBody(req, textKey) {
  const b = await readRaw(req);
  const type = req.headers['content-type'] || '';
  if (!b.trim()) return {};
  try { const j = JSON.parse(b); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch {}
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(b));
  return textKey ? { [textKey]: b } : {};
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
    if (result.claim?.quote) {
      const terms = await buyContractTerms(tg, result, { bucket, checkId: id, reuse: (q, m) => db.recentAnswer(q, m) });
      db.db.prepare("UPDATE checks SET result = json_set(result, '$.contract_terms', json(?)) WHERE id = ?").run(JSON.stringify(terms), id);
    }
    jobs.set(id, 'done');
  } catch (e) { jobs.set(id, `Telegraph purchase failed: ${e.message}`); }
}

// ---------- pages (src/pages.js)
function loadRecord() {
  const f = path.join(DATA, 'record.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
const pages = makePages({ db, jobs, loadRecord, ROOT, DEFAULT_REGIONS, REGION_CHOICES });

// ---------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') {
      try { return html(res, 200, renderLanding(landingData(DATA, db), { vendorsOptions: listCards().map((c) => `<option value="${esc(c.vendor)}">${esc(c.name)}</option>`).join('') })); }
      catch (e) { console.error('landing', e); return html(res, 200, pages.checkForm()); }
    }
    if (req.method === 'GET' && p === '/check') return html(res, 200, pages.checkForm(Object.fromEntries(url.searchParams)));
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const rel = path.normalize(p.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '');
      const f = path.join(ROOT, 'static', rel);
      if (!f.startsWith(path.join(ROOT, 'static') + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return html(res, 404, pages.notFound());
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
    if (req.method === 'GET' && (m = /^\/check\/([\w-]+)$/.exec(p))) { const b = pages.checkPage(m[1]); return b ? html(res, 200, b) : html(res, 404, pages.notFound()); }
    if (req.method === 'GET' && (m = /^\/claim\/([\w-]+)$/.exec(p))) { const b = pages.claimPage(m[1]); return b ? html(res, 200, b) : html(res, 404, pages.notFound()); }
    if (req.method === 'POST' && (m = /^\/claim\/([\w-]+)\/status$/.exec(p))) {
      const body = await readBody(req);
      if (!['sent', 'credited', 'refused', 'declined'].includes(body.status)) return json(res, 400, { error: 'bad status' });
      db.setClaim(m[1], body.status, { note: body.note });
      res.writeHead(303, { location: `/claim/${m[1]}` }); return res.end();
    }
    if (req.method === 'GET' && p === '/record') return html(res, 200, pages.recordPage());
    if (req.method === 'GET' && p === '/record.json') { const r = loadRecord(); return r ? json(res, 200, r) : json(res, 404, { error: 'not built' }); }
    if (req.method === 'GET' && p === '/record.csv') {
      const r = loadRecord(); if (!r) return json(res, 404, { error: 'not built' });
      const cols = ['period', 'vendor', 'plan', 'service', 'uptime_pct', 'threshold_pct', 'covered_minutes', 'credit_pct', 'deadline', 'owed'];
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
      return res.end([cols.join(','), ...r.rows.map((x) => cols.map((c) => JSON.stringify(x[c] ?? '')).join(','))].join('\n'));
    }
    if ((p === '/miner/sla' || p === '/sla-compliance') && (req.method === 'GET' || req.method === 'POST')) {
      const t0 = Date.now();
      let q = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') q = { ...q, ...(await minerBody(req)) };
      const fromTelegraph = /telegraph|anjoman|go-http-client/i.test(req.headers['user-agent'] || '');
      const full = String(q.detail || '').toLowerCase() === 'full';
      const send = (body) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(full ? body : shortView(body), null, full ? 1 : 2)); };
      try {
        const a = answerSla(q);
        db.minerCall({ service: q.service || q.question, period: q.period, status: 200, uptime_pct: a.uptime_pct, from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        return send(a);
      } catch (e) {
        const status = ERROR_STATUS[e.code] || 500;
        db.minerCall({ service: q.service || q.question, period: q.period, status, code: e.code || 'ERROR', from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        if (status === 500) { console.error('miner', e); return json(res, 500, { error: { code: 'ERROR', message: 'internal error' } }); }
        return send(abstainSla(q, e));
      }
    }
    if ((p === '/miner/uptime' || p === '/miner/api-health' || p === '/server-uptime' || p === '/api-health') && (req.method === 'GET' || req.method === 'POST')) {
      const t0 = Date.now();
      let q = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') q = { ...q, ...(await minerBody(req)) };
      const fromTelegraph = /telegraph|anjoman|go-http-client/i.test(req.headers['user-agent'] || '');
      const kind = /uptime/.test(p) ? 'uptime' : 'api-health';
      try {
        const a = kind === 'uptime' ? await answerUptime(q) : await answerApiHealth(q);
        db.minerCall({ service: a.url || q.url || q.question, period: kind, status: 200, code: a.status === 'not_checked' ? 'NOT_CHECKED' : null, from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        const full = String(q.detail || '').toLowerCase() === 'full';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify(full ? a : kind === 'uptime' ? uptimeView(a) : apiHealthView(a), null, 2));
      } catch (e) {
        console.error('miner', kind, e);
        db.minerCall({ service: q.url || q.question, period: kind, status: 500, code: 'ERROR', from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        return json(res, 500, { error: { code: 'ERROR', message: 'internal error' } });
      }
    }
    if ((p === '/miner/contract' || p === '/contract-obligations') && (req.method === 'GET' || req.method === 'POST')) {
      const t0 = Date.now();
      let q = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') q = { ...q, ...(await minerBody(req, 'contract')) };
      const fromTelegraph = /telegraph|anjoman|go-http-client/i.test(req.headers['user-agent'] || '');
      try {
        const a = await answerObligations(q);
        db.minerCall({ service: String(q.contract || q.question || '').slice(0, 80), period: 'contract', status: 200, code: a.status === 'not_audited' ? 'NOT_AUDITED' : null, from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        const short = String(q.view || '').toLowerCase() === 'short';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify(short ? obligationsView(a) : a, null, 2));
      } catch (e) {
        console.error('miner contract', e);
        db.minerCall({ service: 'contract', period: 'contract', status: 500, code: 'ERROR', from_telegraph: fromTelegraph, ms: Date.now() - t0 });
        return json(res, 500, { error: { code: 'ERROR', message: 'internal error' } });
      }
    }
    if (req.method === 'GET' && p === '/sample-invoice') return html(res, 200, pages.sampleInvoice());
    if (req.method === 'GET' && p === '/extension.zip') {
      const f = path.join(ROOT, 'static', 'moneyowed-extension.zip');
      if (!fs.existsSync(f)) return html(res, 404, pages.notFound());
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="moneyowed-extension.zip"' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && p === '/miner.yaml') {
      const f = path.join(ROOT, 'miner', 'moneyowed-sla.yaml');
      if (!fs.existsSync(f)) return html(res, 404, pages.notFound());
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'access-control-allow-origin': '*' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && p === '/evidence') return html(res, 200, pages.evidencePage());
    if (req.method === 'GET' && p === '/purchases.json') return json(res, 200, db.allPurchases(500).map(({ answer, ...x }) => x));
    if (req.method === 'GET' && (m = /^\/api\/cards\/([\w-]+)$/.exec(p))) { const c = listCards().find((x) => x.vendor === m[1]); return c ? json(res, 200, c) : json(res, 404, { code: 'VENDOR_NOT_COVERED', error: `no rule card for ${m[1]}` }); }
    if (req.method === 'GET' && p === '/api/vendors') return json(res, 200, listCards().map((c) => ({ vendor: c.vendor, name: c.name, plans: c.plans.map((pl) => ({ plan: pl.plan, label: pl.label, period: pl.period, per_region: Boolean(pl.per_region), services: pl.services.map((s) => s.service) })), regions: REGION_CHOICES[c.vendor] || null })));
    return html(res, 404, pages.notFound());
  } catch (e) {
    if (e instanceof CheckError || e.code) {
      if (p.startsWith('/api/')) return json(res, 400, { code: e.code, error: e.message });
      return html(res, 400, pages.errorPage(e.code, e.message));
    }
    console.error(e);
    return p.startsWith('/api/') ? json(res, 500, { error: 'internal error' }) : html(res, 500, page('Error', '<p>Something went wrong on our side.</p>'));
  }
});

const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`MONEY OWED on http://${process.env.HOST || '127.0.0.1'}:${PORT} (telegraph ${tg ? 'on' : 'off'})`));
export default server;
