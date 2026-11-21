// Fetch and archive incident history for every covered vendor (default: last 13 months), then write normalized incidents.
// Usage: node scripts/collect.js [vendor ...]
import { Archive } from '../src/archive.js';
import { VENDORS } from '../src/vendors.js';
import { collectStatuspage } from '../src/sources/statuspage.js';
import { collectAws, collectGcp, collectAzure } from '../src/sources/clouds.js';
import { writeIncidents } from '../src/store.js';

const only = process.argv.slice(2);
const now = new Date();
const since = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() - 1, 1));
const archive = new Archive();
const log = (m) => console.error(m);
let failed = 0;

for (const v of VENDORS) {
  if (only.length && !only.includes(v.vendor)) continue;
  const t0 = Date.now();
  try {
    let res;
    if (v.source === 'statuspage') res = await collectStatuspage(v, archive, { since, log });
    else if (v.source === 'aws') res = await collectAws(v, archive);
    else if (v.source === 'gcp') res = await collectGcp(v, archive);
    else if (v.source === 'azure') res = await collectAzure(v, archive);
    const bad = res.incidents.filter((i) => !i.start || !i.end).length;
    writeIncidents(v.vendor, { source: v.source, coverage_from: res.coverage_from || null, components: res.components || null, incidents: res.incidents });
    console.log(`${v.vendor}: ${res.incidents.length} incidents (${bad} without a usable start/end) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    failed++;
    console.log(`${v.vendor}: FAILED ${e.message}`);
  }
}
const day = now.toISOString().slice(0, 10);
const h = archive.dailyHashList(day);
console.log(`hash list ${day}: ${h.lines.length} files, sha256 ${h.sha256}`);
process.exitCode = failed ? 1 : 0;
