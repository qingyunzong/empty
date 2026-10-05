import type { Assignment, Spec, Value } from "./types.js";

/** Total number of partial assignments: product of (domain size + 1) over attributes. */
export function spaceSize(spec: Spec): bigint {
  return spec.attributes.reduce((acc, attr) => acc * BigInt(attr.domain.length + 1), 1n);
}

/**
 * Canonical enumeration order over partial assignments:
 *  1. ascending number of specified attributes k = 0..n;
 *  2. for fixed k, attribute subsets in lexicographic order of declaration indices;
 *  3. for a fixed subset, value tuples in lexicographic order where the
 *     earliest-declared attribute is the most significant digit and values
 *     follow domain declaration order.
 */
export function* enumeratePartial(spec: Spec): Generator<Assignment> {
  const n = spec.attributes.length;
  for (let k = 0; k <= n; k++) {
    yield* pickSubset(spec, n, k, 0, []);
  }
}

function* pickSubset(spec: Spec, n: number, k: number, start: number, picked: number[]): Generator<Assignment> {
  if (picked.length === k) {
    yield* pickValues(spec, picked, 0, new Map<string, Value>());
    return;
  }
  const remaining = k - picked.length;
  for (let i = start; i <= n - remaining; i++) {
    picked.push(i);
    yield* pickSubset(spec, n, k, i + 1, picked);
    picked.pop();
  }
}

function* pickValues(spec: Spec, picked: number[], pos: number, acc: Map<string, Value>): Generator<Assignment> {
  if (pos === picked.length) {
    yield new Map(acc);
    return;
  }
  const attr = spec.attributes[picked[pos]!]!;
  for (const value of attr.domain) {
    acc.set(attr.name, value);
    yield* pickValues(spec, picked, pos + 1, acc);
  }
  acc.delete(attr.name);
}
