import { createState, runOp } from './vm.js';
import { buildPredecessors } from './linearize.js';

// Independent brute-force reference: tries every subset of PENDING
// operations and every permutation of the remaining operations, filters by
// the real-time order, and replays each permutation from a fresh state.
// Used by the randomized tests to cross-check the pruning enumerator.
export function bruteCheck(model, ops) {
  const n = ops.length;
  const pendingIdx = [];
  const completedIdx = [];
  ops.forEach((o, i) => (o.response === null ? pendingIdx : completedIdx).push(i));
  const preds = buildPredecessors(ops);
  const found = [];
  const seen = new Set();

  const permute = (items, cb, prefix = []) => {
    if (items.length === 0) { cb(prefix); return; }
    for (let k = 0; k < items.length; k += 1) {
      const rest = items.slice(0, k).concat(items.slice(k + 1));
      permute(rest, cb, prefix.concat(items[k]));
    }
  };

  for (let mask = 0; mask < (1 << pendingIdx.length); mask += 1) {
    const active = completedIdx.concat(pendingIdx.filter((_, b) => (mask >> b) & 1));
    const activeSet = new Set(active);
    permute(active, (perm) => {
      const pos = new Map(perm.map((v, k) => [v, k]));
      for (const j of active) {
        for (const p of preds[j]) {
          if (activeSet.has(p) && pos.get(p) >= pos.get(j)) return;
        }
      }
      const state = createState(model);
      for (const i of perm) {
        const ok = runOp(model, state, ops[i]);
        const expected = ops[i].response === null ? true : ops[i].result === 'ok';
        if (ok !== expected) return;
      }
      const ids = perm.map((i) => ops[i].id);
      const key = ids.join('\u0001');
      if (!seen.has(key)) { seen.add(key); found.push(ids); }
    });
  }

  found.sort((a, b) => {
    for (let k = 0; k < Math.min(a.length, b.length); k += 1) {
      if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    }
    return a.length - b.length;
  });
  return { linearizable: found.length > 0, orders: found };
}
