import { ClearingError } from './errors.js';
import { normalizeScenario } from './scenario.js';

// Exact minimum-rounds bin packing for small instances (n <= 9), used to
// cross-check the scheduler. Constraints modelled: window capacity,
// per-institution round quotas for atomic groups, atomic groups kept whole,
// non-atomic batches arbitrarily splittable. Fluid (non-atomic) amounts are
// fungible, so every fluid batch must sit in an institution whose quota is
// non-binding (>= capacity); all batches must arrive in round 1.
export function minRounds(input) {
  const sc = normalizeScenario(input);
  for (const b of sc.batches) {
    if (b.arrivalRound !== 1) {
      throw new ClearingError('INVALID', 'enumerator requires arrivalRound 1 for all batches');
    }
    if (b.group === null && sc.institutions.get(b.institution).quota < sc.capacity) {
      throw new ClearingError('INVALID', 'enumerator requires non-binding quotas for fluid batches');
    }
  }
  const groups = [...sc.groups.values()].map((g) => ({ amount: g.total, inst: g.institution }));
  if (groups.length > 20) throw new ClearingError('INVALID', 'too many atomic groups to enumerate');
  const fluidTotal = sc.batches.filter((b) => b.group === null).reduce((s, b) => s + b.amount, 0);
  const capacity = sc.capacity;
  const quotaOf = (name) => sc.institutions.get(name).quota;

  const memo = new Map();
  function dfs(mask, fluid) {
    if (mask === 0 && fluid === 0) return 0;
    const key = `${mask}|${fluid}`;
    if (memo.has(key)) return memo.get(key);
    let best = Infinity;
    const rest = [];
    for (let i = 0; i < groups.length; i += 1) if (mask & (1 << i)) rest.push(i);
    const m = rest.length;
    for (let s = 0; s < (1 << m); s += 1) {
      let sum = 0;
      let sub = 0;
      const perInst = new Map();
      for (let j = 0; j < m; j += 1) {
        if (!(s & (1 << j))) continue;
        const g = groups[rest[j]];
        sum += g.amount;
        sub |= 1 << rest[j];
        perInst.set(g.inst, (perInst.get(g.inst) ?? 0) + g.amount);
      }
      if (sum > capacity) continue;
      let ok = true;
      for (const [inst, amount] of perInst) {
        if (amount > quotaOf(inst)) { ok = false; break; }
      }
      if (!ok) continue;
      const placed = Math.min(fluid, capacity - sum);
      if (sub === 0 && placed === 0) continue;
      const next = dfs(mask & ~sub, fluid - placed);
      if (next !== Infinity && 1 + next < best) best = 1 + next;
    }
    memo.set(key, best);
    return best;
  }

  const result = dfs((1 << groups.length) - 1, fluidTotal);
  if (result === Infinity) throw new ClearingError('WINDOW_FULL', 'instance is infeasible');
  return result;
}
