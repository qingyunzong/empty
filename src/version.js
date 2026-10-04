// Version vectors for causality tracking across pack/feedback libraries.

export function tick(vector, node) {
  const next = { ...vector };
  next[node] = (next[node] ?? 0) + 1;
  return next;
}

export function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

// Returns -1 (a<b), 0 (equal), 1 (a>b), or 'concurrent'.
export function compare(a, b) {
  let less = false;
  let greater = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  if (less && greater) return 'concurrent';
  if (less) return -1;
  if (greater) return 1;
  return 0;
}

function canonical(v) {
  return JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
}

// Total, deterministic order over change entries: vector, then node, then value.
// Identical on every machine and every run, so concurrent conflicts resolve
// the same way on both sides of the sync.
export function entryRank(entry) {
  return JSON.stringify([canonical(entry.vector ?? {}), entry.node ?? '', JSON.stringify(entry.value ?? null)]);
}

export function deterministicWinner(a, b) {
  return entryRank(a) >= entryRank(b) ? a : b;
}
