/**
 * Vector clock: the causal version of an operation or a replica.
 * Causality is derived exclusively from these clocks; wall-clock time
 * is never consulted when ordering operations.
 */
export type VectorClock = Readonly<Record<string, number>>;

export type CausalOrder = 'before' | 'after' | 'concurrent' | 'equal';

export function tick(clock: VectorClock, actor: string): VectorClock {
  return { ...clock, [actor]: (clock[actor] ?? 0) + 1 };
}

export function join(a: VectorClock, b: VectorClock): VectorClock {
  const out: Record<string, number> = { ...a };
  for (const [actor, seq] of Object.entries(b)) {
    out[actor] = Math.max(out[actor] ?? 0, seq);
  }
  return out;
}

/** a <= b componentwise. */
export function leq(a: VectorClock, b: VectorClock): boolean {
  for (const [actor, seq] of Object.entries(a)) {
    if ((b[actor] ?? 0) < seq) return false;
  }
  return true;
}

export function compare(a: VectorClock, b: VectorClock): CausalOrder {
  const ab = leq(a, b);
  const ba = leq(b, a);
  if (ab && ba) return 'equal';
  if (ab) return 'before';
  if (ba) return 'after';
  return 'concurrent';
}

/** a happens strictly before b. */
export function happensBefore(a: VectorClock, b: VectorClock): boolean {
  return compare(a, b) === 'before';
}

export function format(clock: VectorClock): string {
  const entries = Object.entries(clock).sort(([x], [y]) => x.localeCompare(y));
  return `{${entries.map(([a, s]) => `${a}:${s}`).join(',')}}`;
}
