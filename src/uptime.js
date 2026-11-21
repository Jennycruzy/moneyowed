// Uptime for one vendor over one period. A selector decides, per incident, whether it counts and which time windows count.
import { periodBounds } from './lib/time.js';
import { mergeClip } from './lib/intervals.js';

export function evaluatePeriod(incidents, periodKey, selector) {
  const { start, end } = periodBounds(periodKey);
  const periodMinutes = (end - start) / 60000;
  const rows = [];
  const counted = [];
  for (const inc of incidents) {
    if (!inc.start) continue;
    const incEnd = inc.end || new Date(Math.min(Date.now(), +end));
    if (incEnd <= start || inc.start >= end) continue;
    const sel = selector(inc);
    const windows = (sel.windows || [{ start: inc.start, end: incEnd }]).filter((w) => w.end > w.start);
    const own = mergeClip(windows, start, end).minutes;
    rows.push({ id: inc.id, name: inc.name, url: inc.url || null, start: inc.start, end: inc.end, in_scope: Boolean(sel.in_scope), reason: sel.reason, minutes: round(own), ongoing: !inc.end });
    if (sel.in_scope) counted.push(...windows);
  }
  const merged = mergeClip(counted, start, end);
  const uptime = 100 * (1 - merged.minutes / periodMinutes);
  return {
    period: periodKey,
    period_start: start,
    period_end: end,
    period_minutes: periodMinutes,
    covered_minutes: round(merged.minutes),
    uptime_pct: Math.round(uptime * 10000) / 10000,
    incidents: rows.sort((a, b) => a.start - b.start),
  };
}

const round = (x) => Math.round(x * 10) / 10;

// Vendor-wide selector (no contract scope yet): unplanned incidents at or above a severity level.
export function vendorWideSelector({ levels }) {
  return (inc) => {
    if (inc.scheduled) return { in_scope: false, reason: 'scheduled maintenance' };
    if (!levels.includes(String(inc.impact))) return { in_scope: false, reason: `impact "${inc.impact}" below the counted level` };
    return { in_scope: true, reason: `impact "${inc.impact}"`, windows: inc.windows };
  };
}
