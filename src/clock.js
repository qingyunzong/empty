// Vector clock utilities for causal ordering.

// Compare two vector clocks.
// Returns -1 if a happens-before b, 1 if b happens-before a,
// 0 if equal, and null if the clocks are concurrent.
export function compareClocks(a, b) {
  let less = false;
  let greater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] ?? 0;
    const y = b[key] ?? 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  if (less && greater) return null;
  if (less) return -1;
  if (greater) return 1;
  return 0;
}
