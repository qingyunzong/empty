// Normalizes a set of weighted half-open intervals [start, end) into a
// sorted, disjoint, coalesced segment list with summed occupancy.
export function normalizeOccupancy(fragments) {
  const points = new Set();
  for (const f of fragments) {
    points.add(f.start);
    points.add(f.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const active = fragments.filter((f) => f.start <= start && f.end >= end);
    if (active.length === 0) continue;
    const occupancy = active.reduce((acc, f) => acc + f.amount, 0);
    const contributors = active.map((f) => f.id).sort();
    segments.push({ start, end, occupancy, contributors });
  }
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (
      last &&
      last.end === seg.start &&
      last.occupancy === seg.occupancy &&
      last.contributors.join(',') === seg.contributors.join(',')
    ) {
      last.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}
