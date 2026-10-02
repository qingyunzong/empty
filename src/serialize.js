// Fold a serialization (topological order of op ids) into an abundance matrix.
// morph_species / move_plot are global renames already accounted for in
// `effective`; sync / undo_op carry no state.
export function foldOrder(orderedOps, effective) {
  const matrix = {};
  for (const op of orderedOps) {
    if (op.op !== 'set_count') continue;
    const eff = effective.get(op.id);
    (matrix[eff.plot] ??= {})[eff.species] = op.tier;
  }
  // Deterministic key order so matrices compare equal regardless of fold order.
  const sorted = {};
  for (const plot of Object.keys(matrix).sort()) {
    sorted[plot] = {};
    for (const species of Object.keys(matrix[plot]).sort()) sorted[plot][species] = matrix[plot][species];
  }
  return sorted;
}

// Enumerate all topological orders (intended for small n, e.g. n <= 8).
export function enumerateTopoOrders(nodes, adj, limit = 200000) {
  const orders = [];
  const indeg = new Map(nodes.map((n) => [n, 0]));
  for (const n of nodes) for (const m of adj.get(n)) indeg.set(m, indeg.get(m) + 1);
  const order = [];
  const ready = nodes.filter((n) => indeg.get(n) === 0);
  (function rec() {
    if (orders.length >= limit) return;
    if (order.length === nodes.length) {
      orders.push([...order]);
      return;
    }
    for (let i = 0; i < ready.length; i++) {
      const n = ready[i];
      ready.splice(i, 1);
      order.push(n);
      const added = [];
      for (const m of adj.get(n)) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0) {
          ready.push(m);
          added.push(m);
        }
      }
      rec();
      for (const m of adj.get(n)) indeg.set(m, indeg.get(m) + 1);
      for (const m of added) ready.splice(ready.indexOf(m), 1);
      order.pop();
      ready.splice(i, 0, n);
    }
  })();
  return orders;
}
