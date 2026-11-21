// Normalized incidents per vendor, written after each collection. Dates are stored as ISO strings.
import fs from 'node:fs';
import path from 'node:path';

const dir = () => path.resolve(process.env.MONEYOWED_DATA || 'data', 'incidents');

export function writeIncidents(vendor, payload) {
  fs.mkdirSync(dir(), { recursive: true });
  const body = { vendor, collected_at: new Date().toISOString(), ...payload };
  fs.writeFileSync(path.join(dir(), `${vendor}.json`), JSON.stringify(body, null, 1));
  return body;
}

const DATE_KEYS = new Set(['start', 'end']);
function revive(k, v) { return DATE_KEYS.has(k) && typeof v === 'string' ? new Date(v) : v; }

export function readIncidents(vendor) {
  const f = path.join(dir(), `${vendor}.json`);
  if (!fs.existsSync(f)) throw Object.assign(new Error(`no collected history for ${vendor}`), { code: 'NO_HISTORY' });
  return JSON.parse(fs.readFileSync(f, 'utf8'), revive);
}
