import { LimError, E_BOUND } from './errors.js';
import { createState, cloneState, runOp } from './vm.js';

export const DEFAULT_MAX = 8;
export const DEFAULT_WORK_CAP = 5_000_000;

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i += 1) f *= i;
  return f;
}

// Real-time precedence: a completed operation i (with a recorded response)
// must precede j whenever i responded no later than j's invoke tick.
export function buildPredecessors(ops) {
  const n = ops.length;
  const preds = ops.map(() => new Set());
  for (let i = 0; i < n; i += 1) {
    if (ops[i].response === null) continue;
    for (let j = 0; j < n; j += 1) {
      if (i !== j && ops[i].response <= ops[j].invoke) preds[j].add(i);
    }
  }
  return preds;
}

function sortOrders(orders) {
  orders.sort((a, b) => {
    for (let k = 0; k < Math.min(a.length, b.length); k += 1) {
      if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    }
    return a.length - b.length;
  });
  return orders;
}

// The VM never runs operations truly concurrently: it enumerates every
// finite interleaving (linear extension of the real-time order, over every
// subset of PENDING operations treated as successful) and replays each
// candidate sequentially, pruning prefixes whose recorded responses do not
// match the semantics. A history is linearizable iff at least one
// interleaving satisfies both the capacity constraints and the real-time
// order. All valid interleavings are returned in lexicographic order.
export function check(model, ops, { max = DEFAULT_MAX, workCap = DEFAULT_WORK_CAP } = {}) {
  const n = ops.length;
  if (n > max) {
    throw new LimError(E_BOUND, `history has ${n} operations, above the configured maximum of ${max}`);
  }
  const pendingIdx = [];
  const completedIdx = [];
  ops.forEach((o, i) => (o.response === null ? pendingIdx : completedIdx).push(i));
  const estimate = factorial(Math.max(n, 1)) * 2 ** pendingIdx.length;
  if (estimate > workCap) {
    throw new LimError(E_BOUND,
      `worst-case enumeration ${estimate} (n=${n}, pending=${pendingIdx.length}) exceeds work cap ${workCap}`);
  }

  const preds = buildPredecessors(ops);
  const byId = (a, b) => (ops[a].id < ops[b].id ? -1 : ops[a].id > ops[b].id ? 1 : 0);
  const found = [];
  const seen = new Set();
  let explored = 0;

  for (let mask = 0; mask < (1 << pendingIdx.length); mask += 1) {
    const active = completedIdx
      .concat(pendingIdx.filter((_, b) => (mask >> b) & 1))
      .sort(byId);
    const activeSet = new Set(active);
    const indeg = new Map();
    for (const j of active) {
      let d = 0;
      for (const p of preds[j]) if (activeSet.has(p)) d += 1;
      indeg.set(j, d);
    }
    const state = createState(model);
    const seq = [];
    const rec = () => {
      if (seq.length === active.length) {
        const ids = seq.map((i) => ops[i].id);
        const key = ids.join('');
        if (!seen.has(key)) { seen.add(key); found.push(ids); }
        return;
      }
      for (const i of active) {
        if (indeg.get(i) !== 0) continue;
        explored += 1;
        const saved = cloneState(state);
        const ok = runOp(model, state, ops[i]);
        // A PENDING operation included in the subset is taken as successful;
        // a completed operation must match its recorded result.
        const expected = ops[i].response === null ? true : ops[i].result === 'ok';
        if (ok === expected) {
          seq.push(i);
          indeg.set(i, -1);
          for (const j of active) if (preds[j].has(i)) indeg.set(j, indeg.get(j) - 1);
          rec();
          for (const j of active) if (preds[j].has(i)) indeg.set(j, indeg.get(j) + 1);
          indeg.set(i, 0);
          seq.pop();
        }
        state.orderState = saved.orderState;
        state.acctUsed = saved.acctUsed;
        state.stratUsed = saved.stratUsed;
      }
    };
    rec();
  }

  sortOrders(found);
  return {
    linearizable: found.length > 0,
    orders: found,
    pending: pendingIdx.map((i) => ops[i].id),
    explored,
  };
}
