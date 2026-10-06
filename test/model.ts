/**
 * Independent reference model: the "partial-order maximal operations" model.
 *
 * This file deliberately re-implements happens-before from scratch (it does
 * NOT import the library's vclock) so the randomized checks compare two
 * independent implementations of the same spec:
 *
 *   A grant g of permission p is EFFECTIVE iff for every revoke r of p,
 *   g happens strictly after r.  (remove-wins on concurrency)
 *
 *   The reported sources are the poset-MAXIMAL effective grants; when no
 *   grant survives, the poset-maximal revokes explain the revoked state.
 */
import type { PermissionOp } from '../src/op.js';
import type { VectorClock } from '../src/vclock.js';

/** Independent reimplementation of strict happens-after. */
function strictlyAfter(a: VectorClock, b: VectorClock): boolean {
  let greater = false;
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av < bv) return false;
    if (av > bv) greater = true;
  }
  return greater;
}

function maximal(ops: readonly PermissionOp[]): PermissionOp[] {
  return ops.filter((op) => !ops.some((other) => other.id !== op.id && strictlyAfter(other.clock, op.clock)));
}

export interface ModelEntry {
  granted: boolean;
  sources: string[];
  revokedBy: string[];
}

export function modelEffective(allOps: readonly PermissionOp[]): Map<string, ModelEntry> {
  const perms = [...new Set(allOps.map((op) => op.perm))].sort();
  const out = new Map<string, ModelEntry>();
  for (const perm of perms) {
    const grants = allOps.filter((op) => op.perm === perm && op.kind === 'grant');
    const revokes = allOps.filter((op) => op.perm === perm && op.kind === 'revoke');
    const surviving = grants.filter((g) => revokes.every((r) => strictlyAfter(g.clock, r.clock)));
    const granted = surviving.length > 0;
    out.set(perm, {
      granted,
      sources: granted ? maximal(surviving).map((op) => op.id).sort() : [],
      revokedBy: granted ? [] : maximal(revokes).map((op) => op.id).sort(),
    });
  }
  return out;
}
