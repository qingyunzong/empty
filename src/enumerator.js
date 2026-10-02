// Independent brute-force enumerator for small histories (<= 6 operations).
// Used to cross-validate the main checker: it tries every permutation that
// respects real-time order and every integer capture allocation, with no
// candidate-set pruning, so it shares no logic with src/linearize.js beyond
// the documented sequential semantics.

export function bruteForceLinearizable(ops) {
  const n = ops.length;
  if (n > 6) throw new Error('brute-force enumerator supports at most 6 operations');

  const indices = Array.from({ length: n }, (_, i) => i);

  function* permutations(items) {
    if (items.length <= 1) {
      yield items;
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const tail of permutations(rest)) yield [items[i], ...tail];
    }
  }

  for (const perm of permutations(indices)) {
    // Real-time order: a later op in the permutation must not have completed
    // before an earlier op was invoked.
    let respectsRealTime = true;
    for (let a = 0; a < n && respectsRealTime; a++) {
      for (let b = a + 1; b < n; b++) {
        if (ops[perm[b]].respond <= ops[perm[a]].invoke) {
          respectsRealTime = false;
          break;
        }
      }
    }
    if (!respectsRealTime) continue;

    const states = new Map();
    const allocation = new Array(n).fill(0);

    const simulate = (k) => {
      if (k === n) return true;
      const op = ops[perm[k]];
      if (op.op === 'hold') {
        states.set(op.holdId, { amount: op.amount, captured: 0, active: true });
        if (simulate(k + 1)) return true;
        states.delete(op.holdId);
        return false;
      }
      if (op.op === 'capture') {
        const st = states.get(op.holdId);
        if (!st || !st.active) return false;
        if (op.captured > st.amount) return false;
        const hi = Math.min(st.amount, st.captured + op.amount, op.captured);
        const before = st.captured;
        for (let total = before; total <= hi; total++) {
          st.captured = total;
          allocation[perm[k]] = total - before;
          if (simulate(k + 1)) return true;
        }
        st.captured = before;
        allocation[perm[k]] = 0;
        return false;
      }
      if (op.op === 'cancel') {
        const st = states.get(op.holdId);
        if (!st || !st.active) return false;
        st.active = false;
        if (simulate(k + 1)) return true;
        st.active = true;
        return false;
      }
      // audit
      const st = states.get(op.holdId);
      if (!st) return false;
      const frozen = st.active ? st.amount - st.captured : 0;
      const available = st.active ? frozen : 0;
      return op.result.frozen === frozen &&
             op.result.captured === st.captured &&
             op.result.available === available &&
             simulate(k + 1);
    };

    if (simulate(0)) {
      return { linearizable: true, order: perm.map((i) => ops[i].id), allocation };
    }
  }
  return { linearizable: false };
}
