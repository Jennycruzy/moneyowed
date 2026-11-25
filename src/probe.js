// Live checks for SERVER_UPTIME_MONITOR and API_HEALTH_CHECK: probe the address now, and when it belongs to a
// vendor we track, add that vendor's own open incidents and its last-30-days uptime from the same history the
// SLA answers use. Private and internal addresses are refused before any connection is made.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { readIncidents } from './store.js';
import { VENDORS } from './vendors.js';
import { answerSla } from './miner.js';

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_BODY = 64 * 1024;
const SLOW_MS = 2000;

// ---------- address safety
function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const x = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return privateV4(mapped[1]);
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
}
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) { const e = new Error(`refused: ${hostname} resolves to a private or internal address`); e.code = 'PRIVATE_ADDRESS'; return cb(e); }
    if (opts && opts.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

// ---------- the question -> an address
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/i;
const HOST_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::\d{2,5})?(\/[^\s"'<>)]*)?/i;
export function targetFrom(q) {
  const text = String(q.url || q.endpoint || q.target || q.host || q.service || q.question || q.query || '').trim();
  let m = URL_RE.exec(text);
  if (m) return { url: m[0].replace(/[.,;]+$/, ''), text };
  m = HOST_RE.exec(text);
  if (m) return { url: `https://${m[0].replace(/[.,;]+$/, '')}`, text };
  return { url: null, text };
}

// ---------- one request, redirects followed by hand so each hop is checked
function once(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ error: 'not a valid URL' }); }
    if (!/^https?:$/.test(u.protocol)) return resolve({ error: 'only http and https addresses are checked' });
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) return resolve({ error: 'refused: private or internal address', refused: true });
    const t0 = process.hrtime.bigint();
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { 'user-agent': 'moneyowed-uptime/1 (+https://moneyowed.38-49-216-59.sslip.io)', accept: '*/*', ...headers }, lookup: safeLookup, timeout: TIMEOUT_MS }, (res) => {
      const ttfb = Number(process.hrtime.bigint() - t0) / 1e6;
      const chunks = []; let size = 0;
      res.on('data', (c) => { if (size < MAX_BODY) { chunks.push(c); size += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, ttfb_ms: Math.round(ttfb), latency_ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), body: Buffer.concat(chunks).subarray(0, MAX_BODY).toString('utf8'), bytes: size }));
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: `no response within ${TIMEOUT_MS / 1000} s`, timeout: true }); });
    req.on('error', (e) => resolve({ error: e.code === 'PRIVATE_ADDRESS' ? e.message : (e.code === 'ENOTFOUND' ? 'the host name does not resolve' : e.message), refused: e.code === 'PRIVATE_ADDRESS', dns: e.code === 'ENOTFOUND' }));
    req.end();
  });
}

export async function probe(url, opts = {}) {
  const hops = [];
  let cur = url, r;
  const t0 = Date.now();
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    r = await once(cur, opts);
    hops.push({ url: cur, status: r.status ?? null });
    if (r.status >= 300 && r.status < 400 && r.headers?.location) { cur = new URL(r.headers.location, cur).toString(); continue; }
    break;
  }
  return { ...r, final_url: cur, redirects: hops.length - 1, total_ms: Date.now() - t0, checked_at: new Date().toISOString() };
}

// ---------- the vendor behind an address, and its own status
const HOST_VENDOR = [
  ['github', /(^|\.)github(usercontent)?\.com$|(^|\.)githubstatus\.com$/], ['bitbucket', /(^|\.)bitbucket\.org$/],
  ['jira', /(^|\.)atlassian\.net$/], ['vercel', /(^|\.)vercel\.(com|app)$|vercel-status\.com$/], ['digitalocean', /(^|\.)digitalocean\.com$/],
  ['twilio', /(^|\.)twilio\.com$/], ['linode', /(^|\.)linode\.com$/], ['mailgun', /(^|\.)mailgun\.(net|com)$/], ['sanity', /(^|\.)sanity\.io$|sanity-status\.com$/],
  ['prisma', /(^|\.)prisma\.io$|prisma-status\.com$/], ['mapbox', /(^|\.)mapbox\.com$/], ['buildkite', /(^|\.)buildkite\.com$|buildkitestatus\.com$/],
  ['aws', /(^|\.)amazonaws\.com$|(^|\.)aws\.amazon\.com$/], ['gcp', /(^|\.)googleapis\.com$|(^|\.)cloud\.google\.com$/], ['azure', /(^|\.)azure\.com$|(^|\.)windows\.net$|(^|\.)azurewebsites\.net$/],
];
export function vendorFor(url, text = '') {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* no url */ }
  const byHost = HOST_VENDOR.find(([, re]) => host && re.test(host));
  if (byHost) return byHost[0];
  const t = text.toLowerCase();
  const byName = VENDORS.find((v) => new RegExp(`\\b${v.name.toLowerCase().split(' ')[0].replace(/[^a-z]/g, '')}\\b`).test(t));
  return byName ? byName.vendor : null;
}

export function vendorStatus(vendor, now = new Date()) {
  const v = VENDORS.find((x) => x.vendor === vendor);
  if (!v) return null;
  let store;
  try { store = readIncidents(vendor); } catch { return null; }
  const open = (store.incidents || []).filter((i) => i.start && !i.end && !i.scheduled && new Date(i.start) <= now)
    .map((i) => ({ name: i.name, since: new Date(i.start).toISOString(), url: i.url || null }));
  let uptime = null;
  try {
    const a = answerSla({ service: v.name, period: 'last 30 days' }, { now });
    uptime = { uptime_pct: a.uptime_pct, sla_target_pct: a.sla_target_pct, period: a.period, covered_service: a.covered_service, downtime_minutes: a.downtime_minutes };
  } catch { /* per-region clouds need a region: open incidents only */ }
  return { vendor: v.name, status_page: `https://${v.host}`, open_incidents: open, last_30_days: uptime, history_collected_at: store.collected_at || null };
}

// The vendor's own status page, read live: hourly history can miss an incident opened minutes ago.
// Hosts come from our own vendor list, never from the question. Cached for 60 s; on any failure the stored history stands.
const LIVE_TTL_MS = 60000;
const liveCache = new Map();
export async function liveOpenIncidents(vendor, { fetchImpl = globalThis.fetch } = {}) {
  const v = VENDORS.find((x) => x.vendor === vendor);
  if (!v || v.source !== 'statuspage' || !v.host) return null;
  const hit = liveCache.get(vendor);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.value;
  let value = null;
  try {
    const res = await fetchImpl(`https://${v.host}/api/v2/incidents/unresolved.json`, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
    if (res.ok) {
      const j = await res.json();
      value = (j.incidents || []).filter((i) => i.status !== 'scheduled')
        .map((i) => ({ name: i.name, since: i.started_at || i.created_at || null, impact: i.impact || null, url: i.shortlink || null }));
    }
  } catch { value = null; }
  liveCache.set(vendor, { at: Date.now(), value });
  return value;
}
async function withLive(vs, vendor) {
  if (!vs) return vs;
  const live = await liveOpenIncidents(vendor);
  if (live == null) return { ...vs, open_incidents_source: 'stored history' };
  return { ...vs, open_incidents: live, open_incidents_source: 'live status page' };
}

// ---------- answers
const up = (r) => r.status != null && r.status < 500;

function notChecked(kind, q, why) {
  const label = String(q.url || q.service || q.question || q.query || '').slice(0, 200) || 'the service';
  return {
    summary: `${label}: ${kind} NOT CHECKED. ${why[0].toUpperCase() + why.slice(1)}.`,
    check: { result: null, reasons: [why], summary: `NOT CHECKED: ${why}` },
    service: label, url: q.url || null, is_up: null, status_code: null, latency_ms: null,
    answer: `Not checked: ${why}. No status is guessed.`,
    status: 'not_checked',
    how_to_check: 'Give the full address of the service or endpoint, for example https://api.example.com/health.',
  };
}

export async function answerUptime(q, { now = new Date() } = {}) {
  const { url, text } = targetFrom(q);
  if (!url) return notChecked('UPTIME', q, 'no address was given to check');
  const a = await probe(url);
  if (a.refused) return notChecked('UPTIME', { url }, 'the address is private or internal');
  const b = a.error && !a.dns ? await probe(url) : null;
  const probes = [a, b].filter(Boolean);
  const isUp = probes.some(up);
  const best = probes.find(up) || a;
  const vendor = vendorFor(best.final_url || url, text);
  const vs = vendor ? await withLive(vendorStatus(vendor, now), vendor) : null;
  const slow = isUp && best.latency_ms > SLOW_MS;
  const reasons = [];
  if (!isUp) reasons.push(a.error ? a.error : `HTTP ${a.status}`);
  if (slow) reasons.push(`slow: ${best.latency_ms} ms (over ${SLOW_MS} ms)`);
  if (vs && vs.open_incidents.length) reasons.push(`${vs.vendor} reports ${vs.open_incidents.length} open incident${vs.open_incidents.length === 1 ? '' : 's'}`);
  const state = isUp ? (slow || (vs && vs.open_incidents.length) ? 'UP, DEGRADED' : 'UP') : 'DOWN';
  const line = isUp ? `HTTP ${best.status} in ${best.latency_ms} ms` : (a.error || `HTTP ${a.status}`);
  const hist = vs && vs.last_30_days ? ` ${vs.vendor}'s own status history gives ${vs.last_30_days.uptime_pct}% uptime over the last 30 days against a ${vs.last_30_days.sla_target_pct}% SLA target.` : '';
  return {
    summary: `${url} is ${state}: ${line}, checked ${best.checked_at}.${hist}`,
    check: { result: isUp ? 'up' : 'down', reasons, summary: `${state}: ${line}` },
    service: vs ? vs.vendor : new URL(url).hostname, url, is_up: isUp, status_code: best.status ?? null, latency_ms: best.latency_ms ?? null,
    ...(vs && vs.last_30_days ? { uptime_pct: vs.last_30_days.uptime_pct, uptime_period: 'last 30 days (vendor status history)', sla_target_pct: vs.last_30_days.sla_target_pct } : {}),
    answer: `${url} answered ${line} at ${best.checked_at}${probes.length > 1 ? ` (second probe: ${b.error || `HTTP ${b.status} in ${b.latency_ms} ms`})` : ''}.${vs ? ` ${vs.vendor} status page: ${vs.open_incidents.length ? vs.open_incidents.map((i) => i.name).join('; ') : 'no open incidents'}.` : ''}${hist}`,
    final_url: best.final_url, redirects: best.redirects,
    ...(vs ? { vendor_status: { status_page: vs.status_page, open_incidents: vs.open_incidents.slice(0, 5) } } : {}),
    status: 'checked', data_source: vs ? 'live HTTP probe plus the vendor\'s own public status page history' : 'live HTTP probe from one location',
    method: 'GET with redirects followed; up = any HTTP status below 500 within 8 s; one retry on a network error',
  };
}

// The default uptime answer: verdict first, an sla block that agrees with every field, the five numbers.
// The full answer above stays available behind ?detail=full.
export function uptimeView(a) {
  if (a.status === 'not_checked') {
    const why = a.check.reasons[0];
    return {
      url: a.url, is_up: null, status_code: null, latency_ms: null, error: why,
      summary: a.summary,
      sla: { breached: null, max_latency_ms: SLOW_MS, reasons: [why], summary: `NOT CHECKED: ${why}` },
      service: a.service, period: null, uptime_pct: null, sla_target_pct: null, compliant: null, data_source: null,
    };
  }
  const hist = a.uptime_pct != null;
  const reasons = [];
  if (!a.is_up) reasons.push(`service down (${a.check.reasons[0]})`);
  else if (a.latency_ms > SLOW_MS) reasons.push(`slow: ${a.latency_ms} ms (over ${SLOW_MS} ms)`);
  const compliant = hist ? a.uptime_pct >= a.sla_target_pct : a.is_up && !(a.latency_ms > SLOW_MS);
  if (hist && !compliant) reasons.push(`30-day uptime ${a.uptime_pct}% below the ${a.sla_target_pct}% target`);
  const open = a.vendor_status ? a.vendor_status.open_incidents.length : 0;
  if (open) reasons.push(`${a.service} reports ${open} open incident${open === 1 ? '' : 's'}`);
  const state = a.is_up ? (a.latency_ms > SLOW_MS || open ? 'UP, DEGRADED' : 'UP') : 'DOWN';
  return {
    url: a.url, is_up: a.is_up, status_code: a.status_code, latency_ms: a.latency_ms, error: a.is_up ? null : a.check.reasons[0],
    summary: `${a.url} is ${state}: ${a.is_up ? `HTTP ${a.status_code} in ${a.latency_ms} ms` : a.check.reasons[0]}`,
    sla: { breached: reasons.length > 0, max_latency_ms: SLOW_MS, reasons, summary: reasons.length ? `SLA BREACHED: ${reasons.join('; ')}` : 'SLA MET: service within agreed limits' },
    service: a.service,
    period: hist ? 'last 30 days (vendor status history)' : 'instant (single live check)',
    uptime_pct: hist ? a.uptime_pct : (a.is_up ? 100 : 0),
    sla_target_pct: hist ? a.sla_target_pct : 99.9,
    compliant,
    data_source: a.data_source,
  };
}

export async function answerApiHealth(q, { now = new Date() } = {}) {
  const { url, text } = targetFrom(q);
  if (!url) return notChecked('API HEALTH', q, 'no endpoint address was given to check');
  const r = await probe(url, { headers: { accept: 'application/json, */*;q=0.5' } });
  if (r.refused) return notChecked('API HEALTH', { url }, 'the address is private or internal');
  const ctype = String(r.headers?.['content-type'] || '').split(';')[0] || null;
  let json = null;
  if (r.body && /json/.test(ctype || '')) { try { const v = JSON.parse(r.body); json = { valid: true, type: Array.isArray(v) ? 'array' : typeof v, keys: v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).slice(0, 8) : undefined }; } catch { json = { valid: false }; } }
  const vendor = vendorFor(r.final_url || url, text);
  const vs = vendor ? await withLive(vendorStatus(vendor, now), vendor) : null;
  const reasons = [];
  if (r.error) reasons.push(r.error);
  else if (r.status >= 500) reasons.push(`server error HTTP ${r.status}`);
  else if (r.status >= 400) reasons.push(`client error HTTP ${r.status} (the endpoint answers; the request was refused)`);
  if (r.latency_ms > SLOW_MS) reasons.push(`slow: ${r.latency_ms} ms (over ${SLOW_MS} ms)`);
  if (json && !json.valid) reasons.push('content-type says JSON but the body does not parse');
  if (vs && vs.open_incidents.length) reasons.push(`${vs.vendor} reports ${vs.open_incidents.length} open incident${vs.open_incidents.length === 1 ? '' : 's'}`);
  const reachable = r.status != null && r.status < 500;
  const healthy = reachable && r.status < 400 && !(json && !json.valid) && !(r.latency_ms > SLOW_MS) && !(vs && vs.open_incidents.length);
  const state = healthy ? 'HEALTHY' : reachable ? 'DEGRADED' : 'UNHEALTHY';
  const line = r.error ? r.error : `HTTP ${r.status} in ${r.latency_ms} ms${ctype ? `, ${ctype}` : ''}${json ? (json.valid ? ', valid JSON' : ', invalid JSON') : ''}`;
  return {
    summary: `${url} is ${state}: ${line}, checked ${r.checked_at}.${vs ? ` ${vs.vendor} status page: ${vs.open_incidents.length ? `${vs.open_incidents.length} open incident(s)` : 'no open incidents'}.` : ''}`,
    check: { result: healthy ? 'healthy' : reachable ? 'degraded' : 'unhealthy', reasons, summary: `${state}: ${line}` },
    service: vs ? vs.vendor : (() => { try { return new URL(url).hostname; } catch { return url; } })(), url,
    healthy, is_up: reachable, status_code: r.status ?? null, latency_ms: r.error ? null : r.latency_ms, ttfb_ms: r.ttfb_ms ?? null,
    content_type: ctype, ...(json ? { json } : {}),
    answer: `${url}: ${line} at ${r.checked_at}.${reasons.length ? ` ${reasons.join('; ')}.` : ' No problems found.'}`,
    final_url: r.final_url, redirects: r.redirects,
    ...(vs ? { vendor_status: { status_page: vs.status_page, open_incidents: vs.open_incidents.slice(0, 5), ...(vs.last_30_days ? { uptime_pct_last_30_days: vs.last_30_days.uptime_pct } : {}) } } : {}),
    status: 'checked', data_source: vs ? 'live HTTP request plus the vendor\'s own public status page' : 'live HTTP request from one location',
    method: 'GET with Accept: application/json, redirects followed; healthy = HTTP 2xx/3xx under 2 s with a parseable body and no open vendor incident',
  };
}
