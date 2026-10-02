// Vector clock comparison. Missing keys are treated as 0.
// Returns 'lt' | 'gt' | 'eq' | 'concurrent'.
export function compareVC(a, b) {
  let less = false;
  let greater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] ?? 0;
    const y = b[key] ?? 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
    if (less && greater) return 'concurrent';
  }
  if (less) return 'lt';
  if (greater) return 'gt';
  return 'eq';
}
