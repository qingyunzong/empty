import { Frac } from './fraction.js';

// Rate edge (from, to, r) means: 1 unit of `from` == r units of `to`.
// Potentials p[c] (value of 1 unit of c in base currency) must satisfy the
// half-plane boundary p[from] = r * p[to] for every edge; a consistent set of
// triangles is the feasible region. A simple cycle whose rate product != 1
// makes the region empty and is a minimal conflict subset (any proper subset
// of a simple cycle is a forest, hence always consistent).

export function computePotentials(base, edges) {
  const adj = new Map();
  const link = (node, item) => {
    if (!adj.has(node)) adj.set(node, []);
    adj.get(node).push(item);
  };
  for (const e of edges) {
    link(e.from, { peer: e.to, edge: e, forward: true });
    link(e.to, { peer: e.from, edge: e, forward: false });
  }
  if (!adj.has(base)) adj.set(base, []);

  const potentials = new Map();
  const parent = new Map();
  const reachable = new Set();
  const seeds = [base, ...[...adj.keys()].filter((c) => c !== base)];
  for (const seed of seeds) {
    if (potentials.has(seed)) continue;
    potentials.set(seed, Frac.one());
    parent.set(seed, null);
    const queue = [seed];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (seed === base) reachable.add(cur);
      for (const { peer, edge, forward } of adj.get(cur)) {
        const expected = forward
          ? potentials.get(cur).div(edge.rate)
          : potentials.get(cur).mul(edge.rate);
        if (!potentials.has(peer)) {
          potentials.set(peer, expected);
          parent.set(peer, { node: cur, edge });
          queue.push(peer);
        } else if (!potentials.get(peer).eq(expected)) {
          const conflict = buildCycle(cur, peer, edge, parent);
          if (conflict !== null) return { potentials, reachable, conflict };
        }
      }
    }
  }
  return { potentials, reachable, conflict: null };
}

function buildCycle(a, b, closingEdge, parent) {
  const ancestorsOfA = new Set();
  let x = a;
  while (x !== null && x !== undefined) {
    ancestorsOfA.add(x);
    const p = parent.get(x);
    x = p ? p.node : null;
  }
  const pathB = [];
  let y = b;
  while (!ancestorsOfA.has(y)) {
    const p = parent.get(y);
    pathB.push({ edge: p.edge, from: y, to: p.node });
    y = p.node;
  }
  const lca = y;
  const pathA = [];
  x = a;
  while (x !== lca) {
    const p = parent.get(x);
    pathA.push({ edge: p.edge, from: x, to: p.node });
    x = p.node;
  }

  const steps = [];
  const nodes = [a];
  const pushStep = (edge, from, to) => {
    const forward = edge.from === from && edge.to === to;
    steps.push({
      eventId: edge.eid,
      pair: `${edge.from}/${edge.to}`,
      direction: forward ? 'forward' : 'inverse',
      rate: edge.rate,
    });
    nodes.push(to);
  };
  for (const s of pathA) pushStep(s.edge, s.from, s.to);
  for (let i = pathB.length - 1; i >= 0; i -= 1) {
    pushStep(pathB[i].edge, pathB[i].to, pathB[i].from);
  }
  pushStep(closingEdge, b, a);

  let product = Frac.one();
  for (const s of steps) {
    product = s.direction === 'forward' ? product.mul(s.rate) : product.div(s.rate);
  }
  if (product.eq(Frac.one())) return null;
  return { steps, nodes, product };
}
