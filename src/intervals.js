// Closed-interval helpers shared by the engine and the reference algorithm.

export function inAnyInterval(intervals, t) {
  return intervals.some((iv) => t >= iv.start && t <= iv.end);
}

// Is [start, end] fully covered by the union of closed intervals?
export function coveredBy(intervals, start, end) {
  const relevant = intervals
    .filter((iv) => iv.end >= start && iv.start <= end)
    .sort((a, b) => a.start - b.start);
  let cursor = start;
  for (const iv of relevant) {
    if (iv.start > cursor) return false;
    if (iv.end >= end) return true;
    cursor = iv.end;
  }
  return false;
}
