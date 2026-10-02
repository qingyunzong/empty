// Vector clocks for causal ordering of plan operations.

export function mergeClocks(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

export function tick(clock, node) {
  return { ...clock, [node]: (clock[node] ?? 0) + 1 };
}

// -1: a happens-before b; 1: b happens-before a; 0: equal; 2: concurrent
export function compareClocks(a, b) {
  let less = false;
  let greater = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  if (less && !greater) return -1;
  if (greater && !less) return 1;
  if (!less && !greater) return 0;
  return 2;
}

export function lamport(clock) {
  let s = 0;
  for (const v of Object.values(clock)) s += v;
  return s;
}

// Deterministic total order extending causality: (lamport, node, id).
// If a happens-before b then causalKeyCompare(a, b) < 0.
export function causalKeyCompare(opA, opB) {
  const la = lamport(opA.clock);
  const lb = lamport(opB.clock);
  if (la !== lb) return la - lb;
  if (opA.node !== opB.node) return opA.node < opB.node ? -1 : 1;
  if (opA.id < opB.id) return -1;
  if (opA.id > opB.id) return 1;
  return 0;
}
