export function tick(clock, node) {
  return { ...clock, [node]: (clock[node] ?? 0) + 1 };
}

export function compare(a, b) {
  let less = false, greater = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0, y = b[k] ?? 0;
    if (x < y) less = true; else if (x > y) greater = true;
  }
  if (less && greater) return 'concurrent';
  if (less) return -1;
  if (greater) return 1;
  return 0;
}

export function mergeClocks(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}
