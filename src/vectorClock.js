export function increment(clock, node) {
  return { ...clock, [node]: (clock[node] ?? 0) + 1 };
}

export function mergeClocks(a, b) {
  const out = { ...a };
  for (const [node, n] of Object.entries(b)) {
    if (n > (out[node] ?? 0)) out[node] = n;
  }
  return out;
}

// Returns 'lt' (a happened-before b), 'gt', 'eq', or 'concurrent'.
export function compare(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av > bv) aGreater = true;
    else if (bv > av) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'gt';
  if (bGreater) return 'lt';
  return 'eq';
}

export function dominates(a, b) {
  const rel = compare(a, b);
  return rel === 'gt' || rel === 'eq';
}

export function clockSum(clock) {
  let sum = 0;
  for (const n of Object.values(clock)) sum += n;
  return sum;
}
