// Rebuild normalized incidents from the raw archive only (no network). Uses the newest archived copy of each file.
// Proves every stored number can be recomputed from the archived bytes.
// Usage: node scripts/rebuild.js [vendor ...]
import { Archive } from '../src/archive.js';
import { VENDORS } from '../src/vendors.js';
import { normalizeStatuspageIncident } from '../src/sources/statuspage.js';
import { normalizeAws, normalizeGcp, parseAzurePirs, earliestStart } from '../src/sources/clouds.js';
import { writeIncidents, readIncidents } from '../src/store.js';
import fs from 'node:fs';
import zlib from 'node:zlib';

const only = process.argv.slice(2);
const archive = new Archive();
const latest = new Map();
for (const line of fs.readFileSync(archive.indexFile, 'utf8').split('\n')) {
  if (!line) continue;
  const r = JSON.parse(line);
  const k = `${r.vendor}\u0000${r.name}`;
  if (!latest.has(k) || latest.get(k).fetched_at < r.fetched_at) latest.set(k, r);
}
const byVendor = new Map();
for (const r of latest.values()) { if (!byVendor.has(r.vendor)) byVendor.set(r.vendor, []); byVendor.get(r.vendor).push(r); }

for (const v of VENDORS) {
  if (only.length && !only.includes(v.vendor)) continue;
  const recs = byVendor.get(v.vendor) || [];
  if (!recs.length) { console.log(`${v.vendor}: nothing archived`); continue; }
  let prev = null;
  try { prev = readIncidents(v.vendor); } catch { /* first build */ }
  let incidents = [], components = null;
  if (v.source === 'statuspage') {
    const comp = recs.find((r) => r.name === 'components.json');
    if (comp) components = JSON.parse(archive.read(comp)).components.map((c) => ({ id: c.id, name: c.name, group: Boolean(c.group), group_id: c.group_id || null }));
    for (const r of recs.filter((x) => x.name.startsWith('incident-'))) {
      const d = JSON.parse(archive.read(r));
      incidents.push(normalizeStatuspageIncident(v.vendor, d.incident || d, r.sha256, v.host));
    }
  } else if (v.source === 'gcp') {
    const r = recs.find((x) => x.name === 'incidents.json');
    incidents = JSON.parse(archive.read(r)).map((x) => normalizeGcp(v.vendor, x, r.sha256));
  } else if (v.source === 'aws') {
    const r = recs.find((x) => x.name === 'historyevents.json.gz');
    let b = archive.read(r); if (b[0] === 0x1f) b = zlib.gunzipSync(b);
    incidents = normalizeAws(v.vendor, JSON.parse(b.toString('utf8').replace(/^﻿/, '')), r.sha256);
  } else if (v.source === 'azure') {
    const seen = new Set();
    for (const r of recs.filter((x) => x.name.startsWith('pir-page-')).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
      for (const x of parseAzurePirs(archive.read(r).toString('utf8'), r.sha256)) if (!seen.has(x.id)) { seen.add(x.id); incidents.push({ ...x, vendor: v.vendor }); }
    }
  }
  writeIncidents(v.vendor, { source: v.source, coverage_from: v.source === 'statuspage' ? (prev?.coverage_from || new Date(Date.UTC(new Date().getUTCFullYear() - 1, new Date().getUTCMonth() - 1, 1)).toISOString()) : earliestStart(incidents), components: components || prev?.components || null, incidents });
  console.log(`${v.vendor}: ${incidents.length} incidents rebuilt from ${recs.length} archived files${components ? `, ${components.length} components` : ''}`);
}
