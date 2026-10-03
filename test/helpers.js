import { kahn } from '../src/derive.js';

export function ev(id, ts, over = {}) {
  return {
    id, ts, source: 'terminal', type: 'reading',
    ackBy: null, note: null, deleted: false, dependsOn: [],
    ...over,
  };
}

// Deterministic PRNG (LCG) for reproducible randomized tests.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function randomDag(n, rand, edgeProb = 0.35) {
  const ids = Array.from({ length: n }, (_, i) => `e${i}`);
  // Random causal order; edges only point forward in that order.
  const perm = [...ids];
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const events = {};
  for (const id of ids) {
    events[id] = ev(id, Math.floor(rand() * 20) - 10); // ts may decrease along edges
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (rand() < edgeProb) events[perm[j]].dependsOn.push(perm[i]);
    }
  }
  for (const e of Object.values(events)) e.dependsOn.sort();
  return events;
}

export function allTopoOrders(events) {
  const ids = Object.keys(events);
  const orders = [];
  const placed = new Set();
  const cur = [];
  const bt = () => {
    if (cur.length === ids.length) { orders.push([...cur]); return; }
    for (const id of ids) {
      if (placed.has(id)) continue;
      if (!events[id].dependsOn.every((t) => placed.has(t))) continue;
      placed.add(id);
      cur.push(id);
      bt();
      placed.delete(id);
      cur.pop();
    }
  };
  bt();
  return orders;
}

function lexCmp(ka, kb) {
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i][0] !== kb[i][0]) return ka[i][0] - kb[i][0];
    if (ka[i][1] !== kb[i][1]) return ka[i][1] < kb[i][1] ? -1 : 1;
  }
  return 0;
}

// The deterministic Kahn result must be the lexicographically smallest
// topological order under the (ts, id) key sequence.
export function assertLexMinTopo(events) {
  const { order } = kahn(events);
  const key = (o) => o.map((id) => [events[id].ts, id]);
  let min = null;
  for (const o of allTopoOrders(events)) {
    const k = key(o);
    if (min === null || lexCmp(k, min) < 0) min = k;
  }
  if (allTopoOrders(events).length === 0) throw new Error('no topo orders');
  if (lexCmp(key(order), min) !== 0) {
    throw new Error(`kahn order [${order}] is not the lex-min topological order`);
  }
}
