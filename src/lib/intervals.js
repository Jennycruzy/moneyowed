// Merge [start, end) intervals clipped to a window and return total minutes plus the merged spans.

export function mergeClip(intervals, winStart, winEnd) {
  const clipped = [];
  for (const iv of intervals) {
    const s = Math.max(+iv.start, +winStart);
    const e = Math.min(+iv.end, +winEnd);
    if (e > s) clipped.push([s, e]);
  }
  clipped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const spans = [];
  for (const [s, e] of clipped) {
    const last = spans[spans.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else spans.push([s, e]);
  }
  const minutes = spans.reduce((t, [s, e]) => t + (e - s) / 60000, 0);
  return { minutes, spans: spans.map(([s, e]) => ({ start: new Date(s), end: new Date(e) })) };
}
