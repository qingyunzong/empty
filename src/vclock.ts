/**
 * Vector clocks: the causal version of every operation.
 *
 * Merging NEVER uses wall-clock time. Causality is decided purely by the
 * pointwise partial order over per-replica logical counters.
 */
export type VectorClock = Readonly<Record<string, number>>;

export type CausalOrder = 'lt' | 'eq' | 'gt' | 'concurrent';

/** Compare two causal versions under the happens-before partial order. */
export function compare(a: VectorClock, b: VectorClock): CausalOrder {
  let aGreater = false;
  let bGreater = false;
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av > bv) aGreater = true;
    else if (bv > av) bGreater = true;
    if (aGreater && bGreater) return 'concurrent';
  }
  if (aGreater) return 'gt';
  if (bGreater) return 'lt';
  return 'eq';
}

/** True iff `a` happens strictly after `b` (a causally supersedes b). */
export function happensAfter(a: VectorClock, b: VectorClock): boolean {
  return compare(a, b) === 'gt';
}

/** Lattice join: pointwise max. Used to advance a replica's knowledge. */
export function join(a: VectorClock, b: VectorClock): VectorClock {
  const out: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = Math.max(out[key] ?? 0, value);
  }
  return out;
}

/** Advance the clock with a fresh local event for `replica`. */
export function tick(clock: VectorClock, replica: string): VectorClock {
  return { ...clock, [replica]: (clock[replica] ?? 0) + 1 };
}
