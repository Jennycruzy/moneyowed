// All times are UTC. A period key is "YYYY-MM" (month) or "YYYY-Qn" (quarter).

export function periodBounds(key) {
  let m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) {
    const y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12) throw new Error(`bad month in period ${key}`);
    return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)), kind: 'month' };
  }
  m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (m) {
    const y = +m[1], q = +m[2];
    return { start: new Date(Date.UTC(y, (q - 1) * 3, 1)), end: new Date(Date.UTC(y, q * 3, 1)), kind: 'quarter' };
  }
  throw new Error(`period must be YYYY-MM or YYYY-Qn, got "${key}"`);
}

export function periodMinutes(key) {
  const { start, end } = periodBounds(key);
  return (end - start) / 60000;
}

export function periodOf(date, kind) {
  const y = date.getUTCFullYear(), mo = date.getUTCMonth();
  if (kind === 'quarter') return `${y}-Q${Math.floor(mo / 3) + 1}`;
  return `${y}-${String(mo + 1).padStart(2, '0')}`;
}

// Every period of `kind` that overlaps [from, to).
export function periodsBetween(from, to, kind) {
  const out = [];
  let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (d < to) {
    const k = periodOf(d, kind);
    if (out[out.length - 1] !== k) out.push(k);
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return out;
}

export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${v}`);
  return d;
}
