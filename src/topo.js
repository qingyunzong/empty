import { compareClocks } from './vectorClock.js';

// Deterministic tie-break used only to pick a canonical representative order.
function compareTieBreak(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// predecessors[j] = list of indices that must come before j (causal closure).
export function buildPredecessors(events) {
  const n = events.length;
  const preds = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (compareClocks(events[i].clock, events[j].clock) === -1) {
        preds[j].push(i);
      }
    }
  }
  return preds;
}

// One deterministic linearization (Kahn's algorithm, smallest (ts, id) first).
export function canonicalOrder(events) {
  const n = events.length;
  const preds = buildPredecessors(events);
  const indegree = preds.map((p) => p.length);
  const successors = Array.from({ length: n }, () => []);
  preds.forEach((list, j) => {
    for (const i of list) successors[i].push(j);
  });
  const ready = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) ready.push(i);
  const order = [];
  while (ready.length > 0) {
    ready.sort((a, b) => compareTieBreak(events[a], events[b]));
    const next = ready.shift();
    order.push(next);
    for (const m of successors[next]) {
      indegree[m] -= 1;
      if (indegree[m] === 0) ready.push(m);
    }
  }
  return order;
}

// Enumerate every topological order (every linearization of the causal poset).
// Stops early once `cap` orders have been produced and reports truncation.
export function enumerateOrders(events, cap = 100000) {
  const n = events.length;
  const preds = buildPredecessors(events);
  const indegree = preds.map((p) => p.length);
  const successors = Array.from({ length: n }, () => []);
  preds.forEach((list, j) => {
    for (const i of list) successors[i].push(j);
  });
  const orders = [];
  const current = [];
  let truncated = false;

  function backtrack(ready) {
    if (orders.length >= cap) {
      truncated = true;
      return;
    }
    if (current.length === n) {
      orders.push([...current]);
      return;
    }
    // Deterministic iteration order keeps results reproducible.
    const sorted = [...ready].sort((a, b) => compareTieBreak(events[a], events[b]));
    for (const pick of sorted) {
      const nextReady = ready.filter((x) => x !== pick);
      for (const m of successors[pick]) {
        indegree[m] -= 1;
        if (indegree[m] === 0) nextReady.push(m);
      }
      current.push(pick);
      backtrack(nextReady);
      current.pop();
      for (const m of successors[pick]) indegree[m] += 1;
      if (truncated) return;
    }
  }

  const initial = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) initial.push(i);
  backtrack(initial);
  return { orders, truncated };
}
