import { compare, type VectorClock } from './vectorClock.js';

export type OpKind = 'grant' | 'revoke';

/**
 * A single permission operation, stamped with the causal version
 * (vector clock) of the issuing replica at issue time.
 *
 * `wallClockMs` is recorded purely as evidence that wall-clock time is
 * NOT used for ordering: tests deliberately skew it and the merge
 * result must remain unchanged.
 */
export interface Operation {
  readonly id: string; // `${actor}#${seq}`, globally unique
  readonly actor: string;
  readonly seq: number;
  readonly kind: OpKind;
  readonly perm: string;
  readonly clock: VectorClock;
  readonly wallClockMs?: number;
}

export type CausalRelation = 'before' | 'after' | 'concurrent';

/** Causal relation between two distinct operations (never 'equal'). */
export function relate(a: Operation, b: Operation): CausalRelation {
  const order = compare(a.clock, b.clock);
  if (order === 'equal') {
    throw new Error(`distinct operations share a causal version: ${a.id} vs ${b.id}`);
  }
  return order;
}

/**
 * Remove-wins arbitration: does revoke `r` kill grant `g`?
 * A revoke kills every grant that happened before it OR is concurrent
 * with it. Only a grant that happens strictly after the revoke survives.
 */
export function kills(r: Operation, g: Operation): boolean {
  if (r.kind !== 'revoke' || g.kind !== 'grant' || r.perm !== g.perm) return false;
  return relate(r, g) !== 'before';
}
