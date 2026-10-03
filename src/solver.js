// Exact solver: enumerates every subset of tasks, keeps those closed under
// precedence whose worst-case cost/duration sums fit the limits, and picks
// the one with maximum total priority. Ties are broken by the
// lexicographically smallest sorted id sequence.

import { Rational } from './rational.js';

export class UnsatError extends Error {
  constructor(message = 'No feasible selection exists') {
    super(message);
    this.name = 'UnsatError';
    this.code = 'E_UNSAT';
  }
}

// Numbers sort numerically before strings; strings sort by code units.
export function idCompare(a, b) {
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return ta === 'number' ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function seqCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = idCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

// tasks: [{ id, priority:Rational, cl,ch,dl,dh:Rational, deps:[id,...] }]
// Ids must be unique and the precedence graph acyclic (Store guarantees this).
export function solve(tasks, budget, limit) {
  const n = tasks.length;
  if (n > 53) {
    throw new Error(`Exact enumeration supports at most 53 tasks, got ${n}`);
  }
  const indexOf = new Map(tasks.map((t, i) => [t.id, i]));

  // ancestorMask[i]: bitmask of every task that must be present when i is.
  const ancestorMask = new Array(n).fill(0n);
  const visiting = new Array(n).fill(false);
  const computeClosure = (i) => {
    if (ancestorMask[i] !== 0n) return ancestorMask[i];
    if (visiting[i]) throw new Error('Precedence cycle detected');
    visiting[i] = true;
    let mask = 1n << BigInt(i);
    for (const dep of tasks[i].deps) {
      mask |= computeClosure(indexOf.get(dep));
    }
    visiting[i] = false;
    ancestorMask[i] = mask;
    return mask;
  };
  for (let i = 0; i < n; i++) computeClosure(i);

  const total = 1n << BigInt(n);
  let evaluated = 0;
  let feasibleCount = 0;
  const feasibleList = [];
  let best = null; // { mask, priority, ids }

  for (let mask = 0n; mask < total; mask++) {
    evaluated++;
    let closed = true;
    let m = mask;
    while (m !== 0n) {
      const bit = m & (-m);
      const i = bit.toString(2).length - 1;
      if ((ancestorMask[i] & mask) !== ancestorMask[i]) {
        closed = false;
        break;
      }
      m ^= bit;
    }
    if (!closed) continue;

    let priority = Rational.zero();
    let sumCl = Rational.zero();
    let sumCh = Rational.zero();
    let sumDl = Rational.zero();
    let sumDh = Rational.zero();
    const ids = [];
    for (let i = 0; i < n; i++) {
      if ((mask >> BigInt(i)) & 1n) {
        const t = tasks[i];
        priority = priority.add(t.priority);
        sumCl = sumCl.add(t.cl);
        sumCh = sumCh.add(t.ch);
        sumDl = sumDl.add(t.dl);
        sumDh = sumDh.add(t.dh);
        ids.push(t.id);
      }
    }
    if (sumCh.gt(budget) || sumDh.gt(limit)) continue; // boundary: equal is accepted
    feasibleCount++;
    ids.sort(idCompare);
    if (feasibleList.length < 512) {
      feasibleList.push({
        ids,
        priority: priority.toString(),
        cost: [sumCl.toString(), sumCh.toString()],
        duration: [sumDl.toString(), sumDh.toString()],
      });
    }
    if (
      best === null ||
      priority.gt(best.priority) ||
      (priority.cmp(best.priority) === 0 && seqCompare(ids, best.ids) < 0)
    ) {
      best = { mask, priority, ids };
    }
  }

  if (best === null) throw new UnsatError();

  const selectedSet = new Set(best.ids);
  let sumCl = Rational.zero();
  let sumCh = Rational.zero();
  let sumDl = Rational.zero();
  let sumDh = Rational.zero();
  for (const t of tasks) {
    if (selectedSet.has(t.id)) {
      sumCl = sumCl.add(t.cl);
      sumCh = sumCh.add(t.ch);
      sumDl = sumDl.add(t.dl);
      sumDh = sumDh.add(t.dh);
    }
  }

  const unselected = {};
  for (let i = 0; i < n; i++) {
    const t = tasks[i];
    if (selectedSet.has(t.id)) continue;
    // What would it cost to also bring in this task and its missing ancestors?
    let addCh = Rational.zero();
    let addDh = Rational.zero();
    let closureMask = ancestorMask[i];
    for (let j = 0; j < n; j++) {
      if (((closureMask >> BigInt(j)) & 1n) && !selectedSet.has(tasks[j].id)) {
        addCh = addCh.add(tasks[j].ch);
        addDh = addDh.add(tasks[j].dh);
      }
    }
    if (sumCh.add(addCh).gt(budget)) {
      unselected[t.id] = {
        reason: 'cost_budget',
        detail: 'adding this task (with required ancestors) would exceed the cost budget',
      };
    } else if (sumDh.add(addDh).gt(limit)) {
      unselected[t.id] = {
        reason: 'duration_limit',
        detail: 'adding this task (with required ancestors) would exceed the duration limit',
      };
    } else {
      unselected[t.id] = {
        reason: 'priority_tradeoff',
        detail: 'feasible but excluded: no optimal solution contains this task',
      };
    }
  }

  return {
    selected: best.ids,
    priority: best.priority.toString(),
    costInterval: [sumCl.toString(), sumCh.toString()],
    durationInterval: [sumDl.toString(), sumDh.toString()],
    unselected,
    certificate: {
      method: 'exact-enumeration',
      taskCount: n,
      subsetsEvaluated: evaluated,
      feasibleCount,
      budget: budget.toString(),
      durationLimit: limit.toString(),
      bestPriority: best.priority.toString(),
      feasibleSubsets: feasibleList,
    },
  };
}
