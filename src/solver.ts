import { Coupon, OrderSpec, SolveResult } from './types';
import { applyCoupon } from './apply';

const UNUSED_RANK = 1 << 20;

class BudgetExceeded extends Error {}

interface Best {
  total: number;
  count: number;
  /** per coupon (input order): bitmask of owning orders, 0 = unused */
  vector: number[];
  /** final amount per order */
  amounts: number[];
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/**
 * Multi-order solver: depth-first search over coupons in input order.
 * A normal coupon branches over {unused, order 1..m}; a shared coupon
 * branches over every subset of orders. Branch-and-bound prunes against
 * the best solution found so far; the search stops when the node budget
 * is exhausted, in which case the result is reported as feasible but not
 * proven optimal.
 *
 * Objective: minimize total payable, then total assignment count, then the
 * ownership vector in input order (used before unused, smaller order
 * bitmasks first).
 *
 * Settled orders are constrained to keep their locked amount exactly.
 */
export function solveMultiOrder(
  coupons: Coupon[],
  orders: OrderSpec[],
  maxNodes: number,
): SolveResult {
  const n = coupons.length;
  const m = orders.length;
  if (n > 18) throw new Error(`at most 18 coupons supported, got ${n}`);
  if (m > 8) throw new Error(`at most 8 orders supported, got ${m}`);
  if (m === 0) throw new Error('at least one order is required');

  // prereq index per coupon: -1 none, -2 dangling (coupon can never be used)
  const prereqIdx: number[] = coupons.map((c) => {
    if (c.prereq === undefined) return -1;
    const idx = coupons.findIndex((x) => x.id === c.prereq);
    return idx >= 0 ? idx : -2;
  });
  const groupId = new Map<string, number>();
  const groupOf: number[] = coupons.map((c) => {
    if (c.mutexGroup === undefined) return -1;
    let g = groupId.get(c.mutexGroup);
    if (g === undefined) {
      g = groupId.size;
      groupId.set(c.mutexGroup, g);
    }
    return g;
  });

  const locked: (number | null)[] = orders.map((o) =>
    o.settled ? (o.lockedAmount !== undefined ? o.lockedAmount : o.amount) : null,
  );

  const curAmount: number[] = orders.map((o) => o.amount);
  const groupMask: number[] = new Array(m).fill(0);
  const ownerMask: number[] = new Array(n).fill(0);
  let assignCount = 0;
  let nodes = 0;
  let budgetExhausted = false;
  let best: Best | null = null;

  /** optimistic lower bound for order j at depth d: apply all remaining coupons */
  function optimistic(j: number, d: number): number {
    let amt = curAmount[j];
    for (let k = d; k < n; k++) amt = applyCoupon(amt, coupons[k]);
    return amt;
  }

  function better(total: number, count: number, vector: number[], b: Best): boolean {
    if (total !== b.total) return total < b.total;
    if (count !== b.count) return count < b.count;
    for (let i = 0; i < n; i++) {
      const ra = vector[i] === 0 ? UNUSED_RANK : vector[i];
      const rb = b.vector[i] === 0 ? UNUSED_RANK : b.vector[i];
      if (ra !== rb) return ra < rb;
    }
    return false;
  }

  /** settled orders must be able to end exactly at their locked amount */
  function settledReachable(d: number): boolean {
    for (let j = 0; j < m; j++) {
      const lk = locked[j];
      if (lk === null) continue;
      if (curAmount[j] < lk) return false; // already dropped below the lock
      if (optimistic(j, d) > lk) return false; // cannot reach the lock any more
    }
    return true;
  }

  function lowerBound(d: number): number {
    let lb = 0;
    for (let j = 0; j < m; j++) {
      lb += locked[j] !== null ? (locked[j] as number) : optimistic(j, d);
    }
    return lb;
  }

  /** every owner of a coupon must also own its prereq */
  function prereqsOk(): boolean {
    for (let i = 0; i < n; i++) {
      const p = prereqIdx[i];
      if (p < 0 || ownerMask[i] === 0) continue;
      if ((ownerMask[i] & ownerMask[p]) !== ownerMask[i]) return false;
    }
    return true;
  }

  const saved: number[] = [];

  function canAssign(d: number, mask: number): boolean {
    const p = prereqIdx[d];
    if (p === -2) return false; // dangling prereq: coupon is unusable
    const g = groupOf[d];
    for (let j = 0; j < m; j++) {
      if (!((mask >> j) & 1)) continue;
      if (g >= 0 && ((groupMask[j] >> g) & 1)) return false;
      if (p >= 0 && p < d && !((ownerMask[p] >> j) & 1)) return false;
    }
    return true;
  }

  function apply(d: number, mask: number): void {
    ownerMask[d] = mask;
    const g = groupOf[d];
    for (let j = 0; j < m; j++) {
      if (!((mask >> j) & 1)) continue;
      saved.push(curAmount[j]);
      curAmount[j] = applyCoupon(curAmount[j], coupons[d]);
      if (g >= 0) groupMask[j] |= 1 << g;
    }
    assignCount += popcount(mask);
  }

  function undo(d: number, mask: number): void {
    ownerMask[d] = 0;
    assignCount -= popcount(mask);
    const g = groupOf[d];
    for (let j = m - 1; j >= 0; j--) {
      if (!((mask >> j) & 1)) continue;
      if (g >= 0) groupMask[j] &= ~(1 << g);
      curAmount[j] = saved.pop() as number;
    }
  }

  function dfs(d: number): void {
    if (++nodes > maxNodes) {
      budgetExhausted = true;
      throw new BudgetExceeded();
    }
    if (!settledReachable(d)) return;
    if (best !== null) {
      const lb = lowerBound(d);
      if (lb > best.total) return;
      if (lb === best.total && assignCount > best.count) return;
    }
    if (d === n) {
      if (!prereqsOk()) return;
      let total = 0;
      for (let j = 0; j < m; j++) total += curAmount[j];
      if (best === null || better(total, assignCount, ownerMask, best)) {
        best = {
          total,
          count: assignCount,
          vector: ownerMask.slice(),
          amounts: curAmount.slice(),
        };
      }
      return;
    }

    const coupon = coupons[d];
    if (coupon.shared) {
      // every subset of orders, larger masks first, unused last
      const full = (1 << m) - 1;
      for (let s = full; s >= 0; s--) {
        if (!canAssign(d, s)) continue;
        apply(d, s);
        dfs(d + 1);
        undo(d, s);
      }
    } else {
      // orders by immediate gain (desc), then unused
      const options: number[] = [];
      for (let j = 0; j < m; j++) options.push(j);
      options.sort(
        (a, b) =>
          curAmount[b] - applyCoupon(curAmount[b], coupon) -
          (curAmount[a] - applyCoupon(curAmount[a], coupon)),
      );
      for (const j of options) {
        const mask = 1 << j;
        if (!canAssign(d, mask)) continue;
        apply(d, mask);
        dfs(d + 1);
        undo(d, mask);
      }
      dfs(d + 1); // unused
    }
  }

  try {
    dfs(0);
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
  }

  const ownership: Record<string, string[]> = {};
  const orderAmounts: Record<string, number> = {};
  if (best !== null) {
    const b = best as Best;
    for (let i = 0; i < n; i++) {
      const owners: string[] = [];
      for (let j = 0; j < m; j++) {
        if ((b.vector[i] >> j) & 1) owners.push(orders[j].id);
      }
      ownership[coupons[i].id] = owners;
    }
    for (let j = 0; j < m; j++) orderAmounts[orders[j].id] = b.amounts[j];
  } else {
    for (const c of coupons) ownership[c.id] = [];
  }

  return {
    status: best === null ? 'infeasible' : budgetExhausted ? 'feasible' : 'optimal',
    provenOptimal: best !== null && !budgetExhausted,
    total: best === null ? null : (best as Best).total,
    ownership,
    orderAmounts,
    nodesExplored: nodes,
    budgetExhausted,
  };
}
