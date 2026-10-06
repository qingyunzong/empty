/**
 * Vector clocks: the causal version of every operation.
 *
 * Merging NEVER uses wall-clock time. Causality is decided purely by the
 * pointwise partial order over per-replica logical counters.
 */
export type VectorClock = Readonly<Record<string, number>>;
export type CausalOrder = 'lt' | 'eq' | 'gt' | 'concurrent';
/** Compare two causal versions under the happens-before partial order. */
export declare function compare(a: VectorClock, b: VectorClock): CausalOrder;
/** True iff `a` happens strictly after `b` (a causally supersedes b). */
export declare function happensAfter(a: VectorClock, b: VectorClock): boolean;
/** Lattice join: pointwise max. Used to advance a replica's knowledge. */
export declare function join(a: VectorClock, b: VectorClock): VectorClock;
/** Advance the clock with a fresh local event for `replica`. */
export declare function tick(clock: VectorClock, replica: string): VectorClock;
