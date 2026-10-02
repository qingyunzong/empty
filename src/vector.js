// Vector clock primitives. Clocks are plain objects: { nodeId: counter }.

// Returns -1 (a < b), 0 (equal), 1 (a > b), 2 (concurrent / incomparable).
export function compare(a, b) {
  let aGreater = false;
  let bGreater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] || 0;
    const y = b[k] || 0;
    if (x > y) aGreater = true;
    else if (y > x) bGreater = true;
  }
  if (aGreater && bGreater) return 2;
  if (aGreater) return 1;
  if (bGreater) return -1;
  return 0;
}

export function tick(clock, node) {
  return { ...clock, [node]: (clock[node] || 0) + 1 };
}

export function join(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) out[k] = Math.max(a[k] || 0, b[k] || 0);
  return out;
}
