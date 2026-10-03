// Vector-clock helpers. Vectors are plain objects {site: nonNegativeInteger}.

export function vecLeq(a, b) {
  for (const k of Object.keys(a)) {
    if ((a[k] ?? 0) > (b[k] ?? 0)) return false;
  }
  return true;
}

export function vecEq(a, b) {
  return vecLeq(a, b) && vecLeq(b, a);
}

// a is strictly dominated by b (a happened-before b)
export function vecStrict(a, b) {
  return vecLeq(a, b) && !vecEq(a, b);
}

export function vecMax(...vs) {
  const r = {};
  for (const v of vs) {
    for (const [k, x] of Object.entries(v)) r[k] = Math.max(r[k] ?? 0, x);
  }
  return r;
}

// component-wise minimum of a non-empty array of vectors
export function vecMin(vs) {
  if (vs.length === 0) return {};
  const keys = new Set();
  for (const v of vs) for (const k of Object.keys(v)) keys.add(k);
  const r = {};
  for (const k of keys) r[k] = Math.min(...vs.map((v) => v[k] ?? 0));
  return r;
}
