import { Coupon, OrderSpec, SolveResult } from './types';
import { applyCouponList, isLegalSubset } from './apply';

const UNUSED_RANK = 1 << 20;

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

interface BruteBest {
  total: number;
  count: number;
  vector: number[];
  amounts: number[];
}

function betterThan(total: number, count: number, vector: number[], b: BruteBest): boolean {
  if (total !== b.total) return total < b.total;
  if (count !== b.count) return count < b.count;
  for (let i = 0; i < vector.length; i++) {
    const ra = vector[i] === 0 ? UNUSED_RANK : vector[i];
    const rb = b.vector[i] === 0 ? UNUSED_RANK : b.vector[i];
    if (ra !== rb) return ra < rb;
  }
  return false;
}

/**
 * Independent brute-force verifier. Enumerates every ownership combination
 * recursively with no pruning and no budget, rebuilding each order's coupon
 * list from scratch at every leaf. Only suitable for small instances; used
 * to cross-check the main solver.
 */
export function bruteForceSolve(coupons: Coupon[], orders: OrderSpec[]): SolveResult {
  const n = coupons.length;
  const m = orders.length;
  let space = 1;
  for (const c of coupons) space *= c.shared ? 1 << m : m + 1;
  if (space > 4_000_000) {
    throw new Error(`instance too large for brute force (${space} combinations)`);
  }

  const locked: (number | null)[] = orders.map((o) =>
    o.settled ? (o.lockedAmount !== undefined ? o.lockedAmount : o.amount) : null,
  );
  const owner: number[] = new Array(n).fill(0);
  let leaves = 0;
  let best: BruteBest | null = null;

  function rec(d: number): void {
    if (d === n) {
      leaves++;
      const perOrder: number[][] = [];
      for (let j = 0; j < m; j++) perOrder.push([]);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          if ((owner[i] >> j) & 1) perOrder[j].push(i);
        }
      }
      for (let j = 0; j < m; j++) {
        if (!isLegalSubset(coupons, perOrder[j])) return;
      }
      const amounts: number[] = [];
      for (let j = 0; j < m; j++) {
        amounts.push(applyCouponList(orders[j].amount, perOrder[j].map((i) => coupons[i])));
      }
      for (let j = 0; j < m; j++) {
        if (locked[j] !== null && amounts[j] !== locked[j]) return;
      }
      let total = 0;
      for (const a of amounts) total += a;
      let count = 0;
      for (let i = 0; i < n; i++) count += popcount(owner[i]);
      const vector = owner.slice();
      if (best === null || betterThan(total, count, vector, best)) {
        best = { total, count, vector, amounts };
      }
      return;
    }
    if (coupons[d].shared) {
      for (let s = 0; s < 1 << m; s++) {
        owner[d] = s;
        rec(d + 1);
      }
    } else {
      owner[d] = 0;
      rec(d + 1);
      for (let j = 0; j < m; j++) {
        owner[d] = 1 << j;
        rec(d + 1);
      }
    }
    owner[d] = 0;
  }

  rec(0);

  const ownership: Record<string, string[]> = {};
  const orderAmounts: Record<string, number> = {};
  if (best !== null) {
    const b = best as BruteBest;
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
    status: best === null ? 'infeasible' : 'optimal',
    provenOptimal: best !== null,
    total: best === null ? null : (best as BruteBest).total,
    ownership,
    orderAmounts,
    nodesExplored: leaves,
    budgetExhausted: false,
  };
}
