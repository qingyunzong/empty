// Vector clock comparison for observer edit timestamps.
// Clocks are plain objects: { [authorId: string]: number }.

export function compareClocks(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  let aGreater = false;
  let bGreater = false;
  for (const key of keys) {
    const av = a?.[key] ?? 0;
    const bv = b?.[key] ?? 0;
    if (av > bv) aGreater = true;
    else if (av < bv) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'a-after-b';
  if (bGreater) return 'b-after-a';
  return 'equal';
}
