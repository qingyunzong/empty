export type VersionVector = Readonly<Record<string, number>>;

export function increment(vv: VersionVector, nodeId: string): VersionVector {
  const next: Record<string, number> = { ...vv };
  next[nodeId] = (next[nodeId] ?? 0) + 1;
  return next;
}

export function merge(a: VersionVector, b: VersionVector): VersionVector {
  const out: Record<string, number> = { ...a };
  for (const key of Object.keys(b)) {
    const max = Math.max(out[key] ?? 0, b[key] ?? 0);
    if (max > 0) out[key] = max;
    else delete out[key];
  }
  return out;
}

export type Ordering = "equal" | "dominates" | "dominated" | "concurrent";

export function compare(a: VersionVector, b: VersionVector): Ordering {
  let aGreater = false;
  let bGreater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av > bv) aGreater = true;
    else if (bv > av) bGreater = true;
  }
  if (aGreater && bGreater) return "concurrent";
  if (aGreater) return "dominates";
  if (bGreater) return "dominated";
  return "equal";
}

export function dominates(a: VersionVector, b: VersionVector): boolean {
  return compare(a, b) === "dominates";
}

export function format(vv: VersionVector): string {
  const keys = Object.keys(vv)
    .filter((key) => (vv[key] ?? 0) > 0)
    .sort();
  if (keys.length === 0) return "{}";
  return "{" + keys.map((key) => `${key}:${vv[key]}`).join(",") + "}";
}
