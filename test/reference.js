// Independent brute-force reference implementation used only by tests.
// It shares no code with src/: plain permutations + a direct interpreter.

export function* permutations(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  yield [...idx];
  for (;;) {
    let i = n - 2;
    while (i >= 0 && idx[i] > idx[i + 1]) i--;
    if (i < 0) return;
    let j = n - 1;
    while (idx[j] < idx[i]) j--;
    [idx[i], idx[j]] = [idx[j], idx[i]];
    for (let a = i + 1, b = n - 1; a < b; a++, b--) [idx[a], idx[b]] = [idx[b], idx[a]];
    yield [...idx];
  }
}

function refPrecedes(a, b) {
  if (a.response !== null && a.response <= b.invoke) return true;
  if (a.clock !== null && b.clock !== null && a.clock < b.clock) return true;
  return false;
}

function refRun(specData, ops, order) {
  const used = new Map(Object.keys(specData.quotas).map(s => [s, 0]));
  let total = 0;
  const reserves = new Map();
  const results = new Map();
  for (const i of order) {
    const op = ops[i];
    let ok = false;
    if (op.kind === 'reserve') {
      const newUsed = new Map(used);
      newUsed.set(op.strategy, newUsed.get(op.strategy) + op.amount);
      if (total + op.amount <= specData.capacity
          && newUsed.get(op.strategy) <= specData.quotas[op.strategy]
          && specData.constraint(newUsed)) {
        used.set(op.strategy, newUsed.get(op.strategy));
        total += op.amount;
        reserves.set(op.id, { strategy: op.strategy, amount: op.amount, state: 'active' });
        ok = true;
      }
    } else {
      const r = reserves.get(op.target);
      if (r && r.state === 'active') {
        used.set(r.strategy, used.get(r.strategy) - r.amount);
        total -= r.amount;
        r.state = op.kind === 'confirm' ? 'confirmed' : 'released';
        ok = true;
      }
    }
    results.set(op.id, ok ? 'ok' : 'fail');
  }
  return results;
}

// specData: { capacity, quotas: {name: q}, constraint: (usedMap) => bool }
export function refValidOrders(specData, ops) {
  const n = ops.length;
  const valid = [];
  for (const order of permutations(n)) {
    let respectsOrder = true;
    for (let a = 0; a < n && respectsOrder; a++) {
      for (let b = 0; b < n; b++) {
        if (a !== b && refPrecedes(ops[a], ops[b])) {
          if (order.indexOf(a) > order.indexOf(b)) { respectsOrder = false; break; }
        }
      }
    }
    if (!respectsOrder) continue;
    const results = refRun(specData, ops, order);
    let match = true;
    for (const op of ops) {
      if (op.result === 'pending') continue;
      if (results.get(op.id) !== op.result) { match = false; break; }
    }
    if (match) valid.push(order.map(i => ops[i].id));
  }
  valid.sort();
  return valid;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
