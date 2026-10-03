import { canonical } from './canon.js';

// Deterministic total order over history ops: (clock, agentId, canonical op).
// The final canonical tie-break makes the result independent of input file
// or branch ordering; identical duplicate ops are interchangeable anyway.
export function compareOps(a, b) {
  const ca = Number.isFinite(a.clock) ? a.clock : 0;
  const cb = Number.isFinite(b.clock) ? b.clock : 0;
  if (ca !== cb) return ca - cb;
  const aa = String(a.agentId ?? '');
  const ab = String(b.agentId ?? '');
  if (aa !== ab) return aa < ab ? -1 : 1;
  const ka = canonical(a);
  const kb = canonical(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return 0;
}

export function totalOrder(ops) {
  return ops
    .map((op, index) => ({ op, index }))
    .sort((x, y) => compareOps(x.op, y.op) || x.index - y.index)
    .map((e) => e.op);
}
