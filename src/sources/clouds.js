// AWS, Google Cloud and Azure public incident histories, normalized to the same shape as statuspage incidents,
// with services[] and locations[] instead of components.
import zlib from 'node:zlib';
import { fetchRaw } from '../archive.js';
import { toDate } from '../lib/time.js';

// These feeds only reach back so far: the history they give begins at their earliest record.
export function earliestStart(incidents) {
  const t = incidents.filter((i) => i.start).map((i) => +toDate(i.start)).filter(Number.isFinite);
  return t.length ? new Date(Math.min(...t)).toISOString() : null;
}

// ---------- Google Cloud
export async function collectGcp({ vendor }, archive) {
  const url = 'https://status.cloud.google.com/incidents.json';
  const buf = await fetchRaw(url);
  const rec = archive.save(vendor, 'incidents.json', buf, { url });
  const incidents = JSON.parse(buf).map((x) => normalizeGcp(vendor, x, rec.sha256));
  return { vendor, coverage_from: earliestStart(incidents), incidents };
}

export function normalizeGcp(vendor, x, sha256 = null) {
  const locs = [...(x.previously_affected_locations || []), ...(x.currently_affected_locations || [])].map((l) => l.id);
  return {
    vendor, source: 'gcp', id: x.id, name: (x.external_desc || '').slice(0, 200), impact: x.severity, status_impact: x.status_impact || null,
    scheduled: false, start: toDate(x.begin), end: toDate(x.end),
    services: (x.affected_products || []).map((p) => p.title), locations: [...new Set(locs)],
    text: [x.external_desc || '', ...(x.updates || []).map((u) => u.text || '')].join('\n').slice(0, 8000),
    url: x.uri ? `https://status.cloud.google.com/${x.uri}` : null, sha256,
  };
}

// ---------- AWS
export async function collectAws({ vendor }, archive) {
  const url = 'https://history-events-us-west-2-prod.s3.amazonaws.com/historyevents.json';
  const buf = await fetchRaw(url);
  const rec = archive.save(vendor, 'historyevents.json.gz', buf, { url });
  let raw = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) raw = zlib.gunzipSync(buf);
  const text = raw.toString('utf8').replace(/^﻿/, '');
  const incidents = normalizeAws(vendor, JSON.parse(text), rec.sha256);
  return { vendor, coverage_from: earliestStart(incidents), incidents };
}

// One record per (event, impacted service key), with that service's own window when AWS records it.
export function normalizeAws(vendor, data, sha256 = null) {
  const out = [];
  for (const [key, events] of Object.entries(data)) {
    for (const ev of events) {
      const ts = ev.event_log.map((l) => Number(l.timestamp));
      const evStart = toDate(Math.min(...ts)), evEnd = toDate(Math.max(...ts));
      const evRegion = (ev.arn || '').split(':')[3] || '';
      const imp = ev.impacted_services || { [key]: { service_name: key, max: ev.status } };
      for (const [svcKey, info] of Object.entries(imp)) {
        const changes = (ev.impacted_service_status_changes || []).filter((c) => c.service === svcKey).sort((a, b) => a.timestamp - b.timestamp);
        // AWS status: 1 informational, 2 degradation, 3 disruption. Only disruption counts as downtime.
        const windows = [];
        let open = null;
        for (const c of changes) {
          const t = toDate(c.timestamp);
          const st = Number(c.current_status);
          if (st >= 3 && !open) open = t;
          if (st < 3 && open) { windows.push({ start: open, end: t }); open = null; }
        }
        if (open) windows.push({ start: open, end: evEnd });
        if (!changes.length && Number(info.max ?? ev.status) >= 3) windows.push({ start: evStart, end: evEnd });
        const m = /^(.*?)-((?:us|eu|ap|sa|ca|me|af|il|mx)(?:-gov)?-[a-z]+-\d)$/.exec(svcKey);
        out.push({
          vendor, source: 'aws', id: `${ev.arn || key}#${svcKey}`, name: ev.summary, impact: String(info.max ?? ev.status),
          scheduled: false, start: (windows[0] || { start: evStart }).start, end: (windows[windows.length - 1] || { end: evEnd }).end, windows,
          disruption: windows.length > 0, max_status: Math.max(0, ...changes.map((c) => Number(c.current_status)), Number(info.max ?? 0)),
          service_key: m ? m[1] : svcKey, service_name: info.service_name || svcKey,
          locations: [m ? m[2] : 'global'], event_region: evRegion, url: 'https://health.aws.amazon.com/health/status', sha256,
        });
      }
    }
  }
  return out;
}

// ---------- Azure (published Post Incident Reviews)
const MON = Object.fromEntries(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => [m, i]));

export async function collectAzure({ vendor }, archive, { maxPages = 10 } = {}) {
  const pirs = [];
  const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://azure.status.microsoft/en-us/statushistoryapi/?serviceSlug=all&regionSlug=all&startDate=all&shdOnly=false&page=${p}`;
    const buf = await fetchRaw(url);
    if (buf.length < 1000) break;
    const rec = archive.save(vendor, `pir-page-${p}.html`, buf, { url });
    const found = parseAzurePirs(buf.toString('utf8'), rec.sha256).filter((x) => !seen.has(x.id));
    found.forEach((x) => seen.add(x.id));
    pirs.push(...found);
    if (!found.length) break;
  }
  return { vendor, coverage_from: earliestStart(pirs), incidents: pirs.map((x) => ({ ...x, vendor })) };
}

function decode(s) {
  return s.replace(/<[^>]+>/g, '\n').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&#8211;/g, '–');
}

export function parseAzureWindow(text) {
  const re = /Between (?:approximately )?(\d{1,2}):(\d{2})(?: UTC)?(?: on (\d{1,2}) (\w+)(?:,? (\d{4}))?)? and (?:approximately )?(\d{1,2}):(\d{2}) UTC on (\d{1,2}) (\w+),? (\d{4})/;
  const m = re.exec(text);
  if (!m) return null;
  const [, h1, m1, d1, mo1, y1, h2, m2, d2, mo2, y2] = m;
  if (!(mo2 in MON) || (mo1 && !(mo1 in MON))) return null;
  const end = new Date(Date.UTC(+y2, MON[mo2], +d2, +h2, +m2));
  let start = new Date(Date.UTC(+(y1 || y2), MON[mo1 || mo2], +(d1 || d2), +h1, +m1));
  if (start > end) start = new Date(start - 86400000);
  return { start, end };
}

export function parseAzurePirs(htmlText, sha256 = null) {
  const t = decode(htmlText).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const out = [];
  for (const blk of t.split(/\n(?=Post Incident Review \(PIR\))/).slice(1)) {
    const id = (/Tracking ID: ([A-Z0-9_-]+)/.exec(blk) || [])[1];
    const title = blk.split('\n')[0];
    const what = blk.split('What went wrong')[0];
    const win = parseAzureWindow(what);
    out.push({
      source: 'azure', id: id || title.slice(0, 60), name: title, impact: null, scheduled: false,
      start: win ? win.start : null, end: win ? win.end : null, parse_error: win ? null : 'no impact window sentence found',
      text: what.slice(0, 6000), url: id ? `https://aka.ms/air/${id}` : null, sha256,
    });
  }
  return out;
}
