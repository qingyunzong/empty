export type Op = "put" | "delete";

/**
 * A single causal change to one object.
 *
 * `prev` names the predecessor version that MUST be applied before this
 * change becomes applicable. A change is applicable iff
 * `change.prev === engine.cursor(change.key)`. The engine never guesses
 * missing predecessors: anything whose predecessor is not yet applied is
 * buffered, never skipped.
 */
export interface Change<V = unknown> {
  readonly key: string;
  /** New version of the object after this change. Must be > prev. */
  readonly version: number;
  /** Predecessor version that must already be applied (0 = genesis). */
  readonly prev: number;
  readonly op: Op;
  /** Payload for "put"; ignored for "delete". */
  readonly value?: V;
}

export type ReceiveStatus =
  | "applied" // predecessor was ready; applied (and buffered successors cascaded)
  | "buffered" // predecessor missing; stored in the pending buffer
  | "duplicate" // same key+version already sits in the pending buffer
  | "stale" // version <= cursor, already superseded
  | "backpressure" // pending-buffer budget exhausted; NOT accepted, caller must retry
  | "invalid"; // malformed or contradicts applied history

export interface ObjectState<V = unknown> {
  readonly value: V;
  readonly version: number;
}

export interface EngineOptions {
  /** Max number of buffered (pending) changes before backpressure. Default 1024. */
  readonly maxBuffered?: number;
}

/** Plain-data, JSON-serializable snapshot. Pending changes are preserved. */
export interface Snapshot<V = unknown> {
  readonly formatVersion: 1;
  readonly maxBuffered: number;
  readonly state: ReadonlyArray<readonly [string, ObjectState<V>]>;
  /** Cursors for every key ever seen, including deleted keys (tombstones). */
  readonly cursors: ReadonlyArray<readonly [string, number]>;
  /** Out-of-order changes still waiting for their predecessors. */
  readonly pending: ReadonlyArray<Change<V>>;
}
