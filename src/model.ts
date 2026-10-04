import { compare } from './vectorClock.js';
import type { Operation } from './ops.js';

/**
 * Reference model ("partial-order maximal operations", remove-wins):
 *
 * For a permission P, consider the partial order (causal order) over
 * all of P's operations. A grant g is EFFECTIVE iff no revoke r of P
 * satisfies (g < r) or (g || r) — i.e. every revoke of P lies strictly
 * below g in the partial order. Equivalently: take the maximal
 * operations of the partial order; if any maximal op is a revoke, all
 * grants it covers or races with are dead; a grant is effective exactly
 * when it is not dominated-or-raced by any revoke.
 *
 * This module is the specification; PermissionStore is the
 * implementation. Randomized tests cross-check them.
 */
export function modelEffective(ops: readonly Operation[]): Map<string, string[]> {
  const byPerm = new Map<string, Operation[]>();
  for (const op of ops) {
    const list = byPerm.get(op.perm);
    if (list) list.push(op);
    else byPerm.set(op.perm, [op]);
  }
  const out = new Map<string, string[]>();
  for (const [perm, permOps] of byPerm) {
    const grants = permOps.filter((o) => o.kind === 'grant');
    const revokes = permOps.filter((o) => o.kind === 'revoke');
    const alive: string[] = [];
    for (const g of grants) {
      const killed = revokes.some((r) => {
        const order = compare(r.clock, g.clock);
        return order === 'after' || order === 'concurrent';
      });
      if (!killed) alive.push(g.id);
    }
    if (alive.length > 0) out.set(perm, alive.sort());
  }
  return out;
}
