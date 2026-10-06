import type { VectorClock } from './vclock.js';

export type OpKind = 'grant' | 'revoke';

/**
 * An immutable permission operation.
 *
 * `clock` is the full causal version at issue time (including the event
 * itself), so any two operations can be ordered — or proven concurrent —
 * without ever consulting a wall clock.
 */
export interface PermissionOp {
  /** Globally unique, stable id: `<replica>#<counter>`. */
  readonly id: string;
  readonly kind: OpKind;
  readonly perm: string;
  readonly replica: string;
  readonly counter: number;
  /** Causal version of this operation (vector clock). */
  readonly clock: VectorClock;
  /**
   * Optional caller-supplied wall-clock metadata. Carried for debugging
   * only — the merge algorithm is forbidden from reading it.
   */
  readonly wallClockMs?: number;
}
