import { type VectorClock } from './vclock.js';
import type { PermissionOp } from './op.js';
export interface OpSource {
    readonly opId: string;
    readonly replica: string;
    readonly counter: number;
}
export interface EffectivePermission {
    readonly perm: string;
    /** True iff at least one grant survives every revoke. */
    readonly granted: boolean;
    /**
     * Provenance: the poset-maximal surviving grant operations.
     * Empty when the permission is not currently granted.
     */
    readonly sources: readonly OpSource[];
    /**
     * When not granted: the poset-maximal revokes responsible for the
     * current (revoked) state. Empty when granted or never touched.
     */
    readonly revokedBy: readonly OpSource[];
}
/**
 * Remove-wins rule: a grant is effective iff it causally happens strictly
 * after EVERY revoke of the same permission.
 *
 *  - grant concurrent with revoke  -> revoke wins (grant is not > revoke)
 *  - revoke causally after grant   -> revoke wins
 *  - grant causally after revoke   -> grant restores the permission
 */
export declare function grantSurvives(grant: PermissionOp, revokes: readonly PermissionOp[]): boolean;
/** Poset-maximal elements: ops not strictly dominated by any other op. */
export declare function maximalOps(ops: readonly PermissionOp[]): PermissionOp[];
/**
 * A replicated permission store with causal, remove-wins merge semantics.
 *
 * Convergence properties (CRDT): `receive`/`merge` are idempotent,
 * commutative and associative, so messages may be duplicated, reordered or
 * delayed arbitrarily — every replica that has seen the same set of
 * operations computes the same effective permissions.
 */
export declare class PermissionStore {
    readonly replicaId: string;
    private clock;
    private counter;
    private readonly ops;
    constructor(replicaId: string);
    /** Issue a local grant and return the op to broadcast to peers. */
    grant(perm: string, wallClockMs?: number): PermissionOp;
    /** Issue a local revoke and return the op to broadcast to peers. */
    revoke(perm: string, wallClockMs?: number): PermissionOp;
    private localOp;
    /**
     * Apply a remote (or replayed local) operation. Returns true if the op
     * was new. Safe against duplicates and arbitrary delivery order.
     */
    receive(op: PermissionOp): boolean;
    /** Merge a batch of operations (e.g. a peer's snapshot). Returns count of new ops. */
    merge(ops: Iterable<PermissionOp>): number;
    /** All known operations — suitable for anti-entropy exchange with a peer. */
    snapshot(): PermissionOp[];
    /** Current causal version of this replica's knowledge. */
    version(): VectorClock;
    /**
     * Compute every permission ever touched, its effective state, and the
     * provenance (source operations) of that state.
     */
    effective(): EffectivePermission[];
    /** Convenience lookup for a single permission. */
    effectiveFor(perm: string): EffectivePermission | undefined;
}
