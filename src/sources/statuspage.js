// Atlassian Statuspage public history: /history.json?page=N lists incident codes by month,
// /incidents/<code>.json gives components, impact and every update with component status changes.
import { fetchRaw } from '../archive.js';
import { toDate } from '../lib/time.js';

const OUTAGE = new Set(['partial_outage', 'major_outage']);

export async function collectStatuspage({ vendor, host }, archive, { since, log = () => {} }) {
  const cbuf = await fetchRaw(`https://${host}/api/v2/components.json`);
  archive.save(vendor, 'components.json', cbuf, { url: `https://${host}/api/v2/components.json` });
  const componentList = JSON.parse(cbuf).components.map((c) => ({ id: c.id, name: c.name, group: Boolean(c.group), group_id: c.group_id || null }));
  const codes = [];
  let reachedSince = false;
  for (let page = 1; page <= 40 && !reachedSince; page++) {
    const buf = await fetchRaw(`https://${host}/history.json?page=${page}`);
    archive.save(vendor, `history-page-${page}.json`, buf, { url: `https://${host}/history.json?page=${page}` });
    const d = JSON.parse(buf);
    const months = d.months || [];
    if (!months.length) break;
    for (const m of months) {
      const monthStart = new Date(`${m.name} 1, ${m.year} 00:00:00 UTC`);
      if (monthStart < new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1))) { reachedSince = true; continue; }
      for (const i of m.incidents || []) codes.push(i.code);
    }
  }
  const incidents = [];
  for (const code of [...new Set(codes)]) {
    const url = `https://${host}/incidents/${code}.json`;
    let buf;
    try { buf = await fetchRaw(url); } catch (e) { log(`${vendor}: incident ${code} fetch failed: ${e.message}`); continue; }
    const rec = archive.save(vendor, `incident-${code}.json`, buf, { url });
    const d = JSON.parse(buf);
    incidents.push(normalizeStatuspageIncident(vendor, d.incident || d, rec.sha256, host));
    await new Promise((r) => setTimeout(r, 120));
  }
  return { vendor, coverage_from: since.toISOString(), components: componentList, incidents };
}

export function normalizeStatuspageIncident(vendor, i, sha256 = null, host = '') {
  const start = toDate(i.started_at || i.created_at);
  const end = toDate(i.resolved_at) || null;
  const components = (i.components || []).map((c) => ({ id: c.id, name: c.name, group_id: c.group_id || null }));
  // Per-component outage windows from the update stream, when the page records them.
  const updates = [...(i.incident_updates || [])].sort((a, b) => toDate(a.created_at || a.display_at) - toDate(b.created_at || b.display_at));
  const open = new Map();
  const windows = [];
  for (const u of updates) {
    const t = toDate(u.display_at || u.created_at);
    for (const ac of u.affected_components || []) {
      const key = ac.code || ac.name;
      const now = ac.new_status;
      const cur = open.get(key);
      if (OUTAGE.has(now)) {
        if (!cur) open.set(key, { component: ac.name, start: t, worst: now });
        else if (now === 'major_outage') cur.worst = 'major_outage';
      } else if (cur) {
        windows.push({ component: cur.component, start: cur.start, end: t, status: cur.worst });
        open.delete(key);
      }
    }
  }
  for (const cur of open.values()) windows.push({ component: cur.component, start: cur.start, end: end || cur.start, status: cur.worst, open_at_resolve: true });
  return {
    vendor,
    source: 'statuspage',
    id: i.id || i.code,
    name: i.name,
    impact: i.impact,
    scheduled: Boolean(i.scheduled_for),
    start,
    end,
    components,
    component_windows: windows.filter((w) => w.end > w.start),
    url: i.shortlink || (host ? `https://${host}/incidents/${i.id}` : null),
    sha256,
  };
}
