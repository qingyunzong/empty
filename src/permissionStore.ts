import { compare, join, tick, type VectorClock } from './vclock.js';
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

function sourceOf(op: PermissionOp): OpSource {
  return { opId: op.id, replica: op.replica, counter: op.counter };
}

function byOpId(a: OpSource, b: OpSource): number {
  return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
}

/**
 * Remove-wins rule: a grant is effective iff it causally happens strictly
 * after EVERY revoke of the same permission.
 *
 *  - grant concurrent with revoke  -> revoke wins (grant is not > revoke)
 *  - revoke causally after grant   -> revoke wins
 *  - grant causally after revoke   -> grant restores the permission
 */
export function grantSurvives(grant: PermissionOp, revokes: readonly PermissionOp[]): boolean {
  return revokes.every((r) => compare(grant.clock, r.clock) === 'gt');
}

/** Poset-maximal elements: ops not strictly dominated by any other op. */
export function maximalOps(ops: readonly PermissionOp[]): PermissionOp[] {
  return ops.filter((op) => !ops.some((other) => compare(other.clock, op.clock) === 'gt'));
}

/**
 * A replicated permission store with causal, remove-wins merge semantics.
 *
 * Convergence properties (CRDT): `receive`/`merge` are idempotent,
 * commutative and associative, so messages may be duplicated, reordered or
 * delayed arbitrarily — every replica that has seen the same set of
 * operations computes the same effective permissions.
 */
export class PermissionStore {
  private clock: VectorClock = {};
  private counter = 0;
  private readonly ops = new Map<string, PermissionOp>();

  constructor(readonly replicaId: string) {
    if (!replicaId) throw new Error('replicaId must be non-empty');
  }

  /** Issue a local grant and return the op to broadcast to peers. */
  grant(perm: string, wallClockMs?: number): PermissionOp {
    return this.localOp('grant', perm, wallClockMs);
  }

  /** Issue a local revoke and return the op to broadcast to peers. */
  revoke(perm: string, wallClockMs?: number): PermissionOp {
    return this.localOp('revoke', perm, wallClockMs);
  }

  private localOp(kind: PermissionOp['kind'], perm: string, wallClockMs?: number): PermissionOp {
    this.counter += 1;
    this.clock = tick(this.clock, this.replicaId);
    const op: PermissionOp = {
      id: `${this.replicaId}#${this.counter}`,
      kind,
      perm,
      replica: this.replicaId,
      counter: this.counter,
      clock: this.clock,
      ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    };
    this.ops.set(op.id, op);
    return op;
  }

  /**
   * Apply a remote (or replayed local) operation. Returns true if the op
   * was new. Safe against duplicates and arbitrary delivery order.
   */
  receive(op: PermissionOp): boolean {
    if (this.ops.has(op.id)) return false;
    this.ops.set(op.id, op);
    this.clock = join(this.clock, op.clock);
    return true;
  }

  /** Merge a batch of operations (e.g. a peer's snapshot). Returns count of new ops. */
  merge(ops: Iterable<PermissionOp>): number {
    let added = 0;
    for (const op of ops) {
      if (this.receive(op)) added += 1;
    }
    return added;
  }

  /** All known operations — suitable for anti-entropy exchange with a peer. */
  snapshot(): PermissionOp[] {
    return [...this.ops.values()];
  }

  /** Current causal version of this replica's knowledge. */
  version(): VectorClock {
    return this.clock;
  }

  /**
   * Compute every permission ever touched, its effective state, and the
   * provenance (source operations) of that state.
   */
  effective(): EffectivePermission[] {
    const byPerm = new Map<string, { grants: PermissionOp[]; revokes: PermissionOp[] }>();
    for (const op of this.ops.values()) {
      let entry = byPerm.get(op.perm);
      if (!entry) {
        entry = { grants: [], revokes: [] };
        byPerm.set(op.perm, entry);
      }
      (op.kind === 'grant' ? entry.grants : entry.revokes).push(op);
    }

    const result: EffectivePermission[] = [];
    for (const [perm, { grants, revokes }] of byPerm) {
      const surviving = grants.filter((g) => grantSurvives(g, revokes));
      const granted = surviving.length > 0;
      result.push({
        perm,
        granted,
        sources: granted ? maximalOps(surviving).map(sourceOf).sort(byOpId) : [],
        revokedBy: granted ? [] : maximalOps(revokes).map(sourceOf).sort(byOpId),
      });
    }
    return result.sort((a, b) => (a.perm < b.perm ? -1 : a.perm > b.perm ? 1 : 0));
  }

  /** Convenience lookup for a single permission. */
  effectiveFor(perm: string): EffectivePermission | undefined {
    return this.effective().find((e) => e.perm === perm);
  }
}
