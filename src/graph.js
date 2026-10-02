import { InvalidHistory } from './parse.js';

export class Budget {
  constructor(limit) {
    this.left = limit;
  }
  spend(n = 1) {
    this.left -= n;
    return this.left >= 0;
  }
}

function getOrSet(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

// Happens-before graph: per-device program order plus rendezvous sync edges.
// A matched sync pair (s1 on device A, s2 on device B, same session) adds
// s1 -> succ(s2) and s2 -> succ(s1): everything before a sync point is
// visible to everything after its counterpart.
export function buildGraph(ops) {
  const nodes = ops.map((o) => o.id);
  const adj = new Map(nodes.map((id) => [id, new Set()]));
  const byId = new Map(ops.map((o) => [o.id, o]));

  const byDevice = new Map();
  for (const o of ops) getOrSet(byDevice, o.device, () => []).push(o);
  for (const list of byDevice.values()) {
    for (let i = 1; i < list.length; i++) adj.get(list[i - 1].id).add(list[i].id);
  }

  const sessions = new Map();
  for (const o of ops) {
    if (o.op === 'sync') getOrSet(sessions, o.session, () => []).push(o);
  }
  const syncPairs = [];
  const errors = [];
  for (const [session, list] of sessions) {
    if (list.length !== 2 || list[0].device === list[1].device) {
      errors.push({
        message: `sync session "${session}" must pair exactly two ops on different devices (got ${list.length})`,
      });
      continue;
    }
    const [s1, s2] = list;
    syncPairs.push([s1, s2]);
    const succ = (s) => {
      const list = byDevice.get(s.device);
      const i = list.findIndex((o) => o.id === s.id);
      return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
    };
    const n1 = succ(s1);
    const n2 = succ(s2);
    if (n2) adj.get(s1.id).add(n2.id);
    if (n1) adj.get(s2.id).add(n1.id);
  }
  if (errors.length) throw new InvalidHistory(errors);
  return { nodes, adj, byId, syncPairs };
}

// Kahn's algorithm. Returns { order, unique } on success,
// { remaining } when a cycle exists, or { pending: true } on budget exhaustion.
export function kahn(nodes, adj, budget) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  for (const n of nodes) for (const m of adj.get(n)) indeg.set(m, indeg.get(m) + 1);
  const ready = nodes.filter((n) => indeg.get(n) === 0).sort();
  const done = new Set();
  const order = [];
  let unique = true;
  while (ready.length) {
    if (ready.length > 1) unique = false;
    if (!budget.spend()) return { pending: true };
    ready.sort();
    const n = ready.shift();
    done.add(n);
    order.push(n);
    for (const m of adj.get(n)) {
      if (!budget.spend()) return { pending: true };
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) ready.push(m);
    }
  }
  if (order.length < nodes.length) return { remaining: nodes.filter((n) => !done.has(n)) };
  return { order, unique };
}

// Shortest directed cycle within `subset` (BFS from each node). Budget-limited.
export function minimalCycle(adj, subset, budget) {
  const inSub = new Set(subset);
  let best = null;
  for (const start of subset) {
    if (best && best.length <= 2) break;
    const dist = new Map([[start, 0]]);
    const parent = new Map();
    const queue = [start];
    while (queue.length) {
      const x = queue.shift();
      for (const y of adj.get(x)) {
        if (!inSub.has(y)) continue;
        if (!budget.spend()) return { pending: true };
        if (y === start) {
          const len = dist.get(x) + 1;
          if (!best || len < best.length) {
            const path = [x];
            let cur = x;
            while (cur !== start) {
              cur = parent.get(cur);
              path.unshift(cur);
            }
            best = path;
          }
          continue;
        }
        if (!dist.has(y)) {
          dist.set(y, dist.get(x) + 1);
          parent.set(y, x);
          queue.push(y);
        }
      }
    }
  }
  return { cycle: best };
}

// Strict ancestors of every node (transitive closure, reverse reachability).
export function ancestorsOf(nodes, adj) {
  const rev = new Map(nodes.map((n) => [n, []]));
  for (const n of nodes) for (const m of adj.get(n)) rev.get(m).push(n);
  const anc = new Map();
  for (const n of nodes) {
    const seen = new Set();
    const stack = [...rev.get(n)];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      for (const p of rev.get(x)) stack.push(p);
    }
    anc.set(n, seen);
  }
  return anc;
}
