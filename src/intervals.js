// Interval algebra: turn a set of (possibly out-of-order, overlapping) events
// into a normalized timeline of atomic, non-overlapping intervals.
// Every atomic interval records the ids of the events that cover it.

// Main implementation: sweep-line over sorted boundary points.
export function normalizeSweep(events) {
  if (events.length === 0) return [];
  const points = new Set();
  const byStart = new Map();
  for (const e of events) {
    points.add(e.start);
    points.add(e.end);
    const list = byStart.get(e.start);
    if (list) list.push(e);
    else byStart.set(e.start, [e]);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const intervals = [];
  let active = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const starting = byStart.get(a);
    if (starting) active.push(...starting);
    if (active.length) active = active.filter((e) => e.end > a);
    if (b === a) continue; // degenerate point, no width
    intervals.push({ start: a, end: b, covering: active.map((e) => e.id) });
  }
  return intervals;
}

// Reference implementation: enumerate every legal atomic interval defined by
// the boundary points and scan all events for coverage. Obviously correct,
// O(boundaries * events); used to cross-check the sweep-line.
export function normalizeReference(events) {
  if (events.length === 0) return [];
  const points = [...new Set(events.flatMap((e) => [e.start, e.end]))].sort((a, b) => a - b);
  const intervals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === b) continue;
    const covering = events.filter((e) => e.start <= a && e.end >= b).map((e) => e.id);
    intervals.push({ start: a, end: b, covering });
  }
  return intervals;
}
