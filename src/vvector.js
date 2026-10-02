// Version vectors: plain objects { nodeId: counter }.

export function vvCompare(a, b) {
  let aGreater = false;
  let bGreater = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    if (av > bv) aGreater = true;
    else if (bv > av) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'gt';
  if (bGreater) return 'lt';
  return 'eq';
}

export function vvMerge(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = Math.max(a[k] || 0, b[k] || 0);
  }
  return out;
}

export function vvBump(vv, nodeId) {
  return { ...vv, [nodeId]: (vv[nodeId] || 0) + 1 };
}
