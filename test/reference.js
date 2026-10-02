// Independent reference implementation: brute-force enumeration of ALL
// permutations of the operations, filtering by the ordering constraints
// and validating register semantics. Used to cross-check the optimized
// memoized checker on small histories (<= 8 operations).

import { buildConstraints } from '../src/checker.js';

function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function* permutations(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  yield a.slice();
  // Heap's algorithm
  const c = new Array(n).fill(0);
  let i = 1;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [a[i], a[j]] = [a[j], a[i]];
      yield a.slice();
      c[i] += 1;
      i = 1;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

function respectsConstraints(perm, preds) {
  const pos = new Array(perm.length);
  perm.forEach((op, idx) => { pos[op] = idx; });
  for (let j = 0; j < perm.length; j += 1) {
    for (const i of preds[j]) {
      if (pos[i] >= pos[j]) return false;
    }
  }
  return true;
}

function validRegisterSemantics(perm, ops) {
  const lastVal = new Map();
  for (const idx of perm) {
    const o = ops[idx];
    if (o.op === 'read') {
      const cur = lastVal.has(o.key) ? lastVal.get(o.key) : null;
      if (!deepEq(cur, o.value)) return false;
    } else if (o.op === 'write') {
      lastVal.set(o.key, o.value);
    }
  }
  return true;
}

// Returns true iff some permutation satisfies all constraints and the
// register semantics. Assumes all operations are complete (have responses)
// and the constraint graph is acyclic.
export function referenceLinearizable(ops, compiled) {
  const { preds } = buildConstraints(ops, compiled);
  for (const perm of permutations(ops.length)) {
    if (respectsConstraints(perm, preds) && validRegisterSemantics(perm, ops)) {
      return true;
    }
  }
  return false;
}
