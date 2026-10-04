import { join, tick, format, type VectorClock } from './vectorClock.js';
import { kills, type Operation } from './ops.js';

/** Provenance of an effective permission: the grant(s) that keep it alive. */
export interface GrantSource {
  readonly opId: string;
  readonly actor: string;
  readonly clock: VectorClock;
}

export interface EffectivePermission {
  readonly perm: string;
  readonly sources: readonly GrantSource[];
}

/**
 * Op-based CRDT permission store with remove-wins semantics:
 *
 *  - concurrent grant + revoke of the same permission  -> revoke wins;
 *  - a grant that causally follows a revoke re-establishes the permission;
 *  - every operation carries a vector clock (causal version); ordering
 *    never depends on wall-clock time;
 *  - delivery may be out of order, duplicated, or via state merge:
 *    the resulting effective permission set is always the same.
 */
export class PermissionStore {
  readonly actor: string;
  private clock: VectorClock = {};
  private readonly ops = new Map<string, Operation>();

  constructor(actor: string) {
    this.actor = actor;
  }

  private issue(kind: Operation['kind'], perm: string, wallClockMs?: number): Operation {
    this.clock = tick(this.clock, this.actor);
    const seq = this.clock[this.actor]!;
    const op: Operation = {
      id: `${this.actor}#${seq}`,
      actor: this.actor,
      seq,
      kind,
      perm,
      clock: this.clock,
      ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    };
    this.ops.set(op.id, op);
    return op;
  }

  grant(perm: string, wallClockMs?: number): Operation {
    return this.issue('grant', perm, wallClockMs);
  }

  revoke(perm: string, wallClockMs?: number): Operation {
    return this.issue('revoke', perm, wallClockMs);
  }

  /**
   * Apply a remotely received operation. Idempotent: returns false for
   * duplicates. Safe for out-of-order delivery because the effective
   * state is a pure function of the operation set.
   */
  apply(op: Operation): boolean {
    if (this.ops.has(op.id)) return false;
    this.ops.set(op.id, op);
    this.clock = join(this.clock, op.clock);
    return true;
  }

  /** State-based merge; returns the operations that were new. */
  mergeFrom(other: PermissionStore): Operation[] {
    return this.applyAll(other.operations());
  }

  applyAll(ops: Iterable<Operation>): Operation[] {
    const added: Operation[] = [];
    for (const op of ops) {
      if (this.apply(op)) added.push(op);
    }
    return added;
  }

  operations(): Operation[] {
    return [...this.ops.values()];
  }

  /** Causal version of everything this replica has seen. */
  version(): VectorClock {
    return this.clock;
  }

  /**
   * Effective permissions with provenance. A grant survives iff every
   * revoke of the same permission happens strictly before it
   * (concurrent revokes kill it: remove-wins).
   */
  effective(): Map<string, EffectivePermission> {
    const grants = new Map<string, Operation[]>();
    const revokes = new Map<string, Operation[]>();
    for (const op of this.ops.values()) {
      const bucket = op.kind === 'grant' ? grants : revokes;
      const list = bucket.get(op.perm);
      if (list) list.push(op);
      else bucket.set(op.perm, [op]);
    }
    const out = new Map<string, EffectivePermission>();
    for (const [perm, permGrants] of grants) {
      const permRevokes = revokes.get(perm) ?? [];
      const sources: GrantSource[] = [];
      for (const g of permGrants) {
        if (permRevokes.every((r) => !kills(r, g))) {
          sources.push({ opId: g.id, actor: g.actor, clock: g.clock });
        }
      }
      // Canonical order so the result is independent of delivery order.
      sources.sort((x, y) => x.opId.localeCompare(y.opId));
      if (sources.length > 0) out.set(perm, { perm, sources });
    }
    return out;
  }

  isEffective(perm: string): boolean {
    return this.effective().has(perm);
  }

  /** Human-readable dump: effective permission <- source grants. */
  describe(): string {
    const lines: string[] = [];
    for (const { perm, sources } of this.effective().values()) {
      const src = sources
        .map((s) => `${s.opId}@${format(s.clock)}`)
        .join(', ');
      lines.push(`${perm} <= ${src}`);
    }
    return lines.sort().join('\n');
  }
}
