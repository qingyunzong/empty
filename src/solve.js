import { propagate } from './propagate.js';

class BudgetExhausted extends Error {}

// Yield every integer tuple of length caps.length summing to `need` with
// 0 <= tuple[i] <= caps[i], pruning against the remaining capacity suffix.
function* compositions(caps, need) {
  const k = caps.length;
  const suffix = new Array(k + 1).fill(0);
  for (let i = k - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + caps[i];
  if (suffix[0] < need) return;
  const current = new Array(k).fill(0);
  function* rec(i, rem) {
    if (i === k) {
      if (rem === 0) yield [...current];
      return;
    }
    const lo = Math.max(0, rem - suffix[i + 1]);
    const hi = Math.min(caps[i], rem);
    for (let v = lo; v <= hi; v += 1) {
      current[i] = v;
      yield* rec(i + 1, rem - v);
    }
  }
  yield* rec(0, need);
}

// Solve the genealogy CSP: propagate finite domains, then backtrack over
// per-batch integer quantity splits. `budget` bounds the number of explored
// assignment nodes; exhausting it yields `unknown` plus the pending choices.
export function solve(store, { budget = 100000 } = {}) {
  const prop = propagate(store);
  if (!prop.ok) {
    const result = { status: 'infeasible', conflict: prop.conflict };
    store.derived = { blocked: [...prop.blocked.keys()], result };
    return result;
  }

  const order = [...store.batches.keys()].sort(
    (a, b) => store.batches.get(a).candidates.length - store.batches.get(b).candidates.length,
  );
  const remaining = new Map(prop.available);
  const assignment = new Map();
  let nodes = 0;
  let deepest = null;

  const search = (index) => {
    if (index === order.length) return true;
    const id = order[index];
    const need = prop.required.get(id);
    const cands = [];
    const caps = [];
    for (const [p, e] of prop.domains.get(id)) {
      const cap = Math.min(e.ub, remaining.get(p) ?? 0);
      if (cap > 0) {
        cands.push(p);
        caps.push(cap);
      }
    }
    for (const combo of compositions(caps, need)) {
      nodes += 1;
      if (nodes > budget) {
        const err = new BudgetExhausted('search budget exhausted');
        err.index = index;
        throw err;
      }
      for (let j = 0; j < cands.length; j += 1) {
        remaining.set(cands[j], remaining.get(cands[j]) - combo[j]);
      }
      assignment.set(id, new Map(cands.map((p, j) => [p, combo[j]]).filter(([, q]) => q > 0)));
      if (search(index + 1)) return true;
      assignment.delete(id);
      for (let j = 0; j < cands.length; j += 1) {
        remaining.set(cands[j], remaining.get(cands[j]) + combo[j]);
      }
    }
    if (!deepest || index > deepest.index) {
      deepest = {
        index,
        batch: id,
        needed: need,
        caps: Object.fromEntries(cands.map((p, j) => [p, caps[j]])),
      };
    }
    return false;
  };

  try {
    if (search(0)) {
      const assignmentObj = {};
      for (const [id, edges] of assignment) {
        assignmentObj[id] = Object.fromEntries([...edges.entries()].sort(([a], [b]) => a.localeCompare(b)));
      }
      const result = { status: 'feasible', assignment: assignmentObj, nodes };
      store.derived = { blocked: [], result };
      return result;
    }
    const conflict = deepest
      ? {
          constraints: ['mass-balance', 'supply-limit'],
          batches: [deepest.batch, ...Object.keys(deepest.caps)],
          chain: [
            { batch: deepest.batch, needed: deepest.needed, remainingParentCaps: deepest.caps },
          ],
        }
      : { constraints: ['mass-balance'], batches: [], chain: [] };
    const result = { status: 'infeasible', conflict };
    store.derived = { blocked: [], result };
    return result;
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    const pending = order.slice(err.index).map((id) => {
      const choices = [];
      for (const [p, e] of prop.domains.get(id)) {
        if (e.ub > 0) {
          choices.push({ parent: p, lb: e.lb, ub: Math.min(e.ub, remaining.get(p) ?? e.ub) });
        }
      }
      return { batch: id, required: prop.required.get(id), choices };
    });
    const result = { status: 'unknown', reason: 'budget-exhausted', nodes, pending };
    store.derived = { blocked: [], result };
    return result;
  }
}
