// Relational-algebra style BOM expansion and net-requirement computation.
// Relations:
//   WORKORDER(id, product, qty)
//   BOM(parent, component, usage)
//   INVENTORY(component, qty)   -- qty === null means "unknown"
// Gross requirements: fixpoint of JOIN/UNION over BOM starting from work orders.
// Net requirements: LEFT JOIN gross requirements with INVENTORY;
//   unknown (null) inventory yields null net, never 0.

export function bomAdjacency(state) {
  const adj = new Map();
  for (const row of Object.values(state.bom)) {
    if (!adj.has(row.parent)) adj.set(row.parent, []);
    adj.get(row.parent).push(row);
  }
  for (const edges of adj.values()) {
    edges.sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : 0));
  }
  return adj;
}

// Semi-naive fixpoint: frontier relation (node, multiplier, path) is joined
// with BOM on node = parent until the frontier is empty.
export function grossRequirements(state) {
  const adj = bomAdjacency(state);
  const gross = {};
  const orders = Object.values(state.workorders)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const order of orders) {
    let frontier = [{ node: order.product, mult: order.qty, path: [order.product] }];
    while (frontier.length > 0) {
      const next = [];
      for (const tuple of frontier) {
        for (const edge of adj.get(tuple.node) ?? []) {
          if (tuple.path.includes(edge.component)) {
            throw new Error(
              `BOM cycle detected: ${[...tuple.path, edge.component].join(' -> ')}`
            );
          }
          const qty = tuple.mult * edge.usage;
          gross[edge.component] = (gross[edge.component] ?? 0) + qty;
          next.push({
            node: edge.component,
            mult: qty,
            path: [...tuple.path, edge.component],
          });
        }
      }
      frontier = next;
    }
  }
  return gross;
}

// LEFT JOIN gross requirements with inventory on component.
// Missing inventory row or null qty => net is null (unknown), never coerced to 0.
export function netRequirements(state) {
  const gross = grossRequirements(state);
  const inventory = {};
  const net = {};
  for (const [component, required] of Object.entries(gross)) {
    const row = Object.prototype.hasOwnProperty.call(state.inventory, component)
      ? state.inventory[component]
      : null;
    const onHand = row === null ? null : row.qty;
    inventory[component] = onHand === undefined ? null : onHand;
    net[component] = onHand === null || onHand === undefined ? null : required - onHand;
  }
  return { gross, inventory, net };
}
