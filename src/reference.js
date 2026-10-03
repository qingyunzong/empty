// Independent reference algorithm: enumerates every root-to-leaf BOM path
// (at most `limit` paths, default 20) per work order and recomputes gross
// requirements from scratch. Used to cross-check the relational engine.

import { bomAdjacency } from './mrp.js';

export function enumeratePaths(state, { limit = 20 } = {}) {
  const adj = bomAdjacency(state);
  const paths = [];
  const orders = Object.values(state.workorders)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const order of orders) {
    const stack = [{ node: order.product, mult: order.qty, nodes: [order.product], usages: [] }];
    while (stack.length > 0) {
      const { node, mult, nodes, usages } = stack.pop();
      const edges = adj.get(node) ?? [];
      if (edges.length === 0) {
        paths.push({ order: order.id, nodes, usages, multiplier: mult });
        if (paths.length > limit) {
          throw new Error(`reference path limit exceeded (> ${limit})`);
        }
        continue;
      }
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        const edge = edges[i];
        if (nodes.includes(edge.component)) {
          throw new Error(
            `BOM cycle detected: ${[...nodes, edge.component].join(' -> ')}`
          );
        }
        stack.push({
          node: edge.component,
          mult: mult * edge.usage,
          nodes: [...nodes, edge.component],
          usages: [...usages, edge.usage],
        });
      }
    }
  }
  return paths;
}

// Per-path, per-node contributions: for path [P, c1, c2, ...] the entry for
// c_i is order.qty * product(usages[0..i-1]).
export function pathContributions(state, opts) {
  return enumeratePaths(state, opts).map((p) => ({
    order: p.order,
    path: p.nodes,
    components: p.nodes.slice(1).map((component, i) => ({
      component,
      multiplier: p.usages.slice(0, i + 1).reduce((a, b) => a * b, 1),
      quantity: p.usages.slice(0, i + 1).reduce((a, b) => a * b, 1) * orderQty(state, p.order),
    })),
  }));
}

function orderQty(state, id) {
  return state.workorders[id].qty;
}

// Recompute gross requirements purely from path enumeration.
export function referenceGross(state, opts) {
  const gross = {};
  for (const p of enumeratePaths(state, opts)) {
    const qty = state.workorders[p.order].qty;
    p.nodes.slice(1).forEach((component, i) => {
      const mult = p.usages.slice(0, i + 1).reduce((a, b) => a * b, 1);
      gross[component] = (gross[component] ?? 0) + qty * mult;
    });
  }
  return gross;
}

export function referenceNet(state, opts) {
  const gross = referenceGross(state, opts);
  const net = {};
  for (const [component, required] of Object.entries(gross)) {
    const row = Object.prototype.hasOwnProperty.call(state.inventory, component)
      ? state.inventory[component]
      : null;
    const onHand = row === null ? null : row.qty;
    net[component] = onHand === null || onHand === undefined ? null : required - onHand;
  }
  return { gross, net };
}
