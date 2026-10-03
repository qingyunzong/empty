export const MAX_DEPTH = 20;

function indexBom(bomRecords) {
  const byParent = new Map();
  for (const edge of bomRecords) {
    let list = byParent.get(edge.parent);
    if (!list) {
      list = [];
      byParent.set(edge.parent, list);
    }
    list.push(edge);
  }
  return byParent;
}

// Relational-algebra expansion: iterate the join
//   requirements(product, qty) JOIN bom(parent = product) -> (component, qty * usage)
// to a fixpoint (bounded by maxDepth join iterations), aggregating per component.
export function grossRequirements(workOrders, bomRecords, maxDepth = MAX_DEPTH) {
  const byParent = indexBom(bomRecords);
  const gross = new Map();
  let frontier = new Map();
  for (const wo of workOrders) {
    frontier.set(wo.product, (frontier.get(wo.product) ?? 0) + wo.qty);
  }
  for (let depth = 0; depth < maxDepth && frontier.size > 0; depth += 1) {
    const next = new Map();
    for (const [product, qty] of frontier) {
      for (const edge of byParent.get(product) ?? []) {
        const need = qty * edge.usage;
        gross.set(edge.component, (gross.get(edge.component) ?? 0) + need);
        next.set(edge.component, (next.get(edge.component) ?? 0) + need);
      }
    }
    frontier = next;
  }
  return gross;
}

// Independent reference algorithm: explicitly enumerate every root-to-leaf
// BOM path of at most maxDepth edges, then re-aggregate gross demand by
// walking each enumerated path edge by edge.
export function referenceGross(workOrders, bomRecords, maxDepth = MAX_DEPTH) {
  const byParent = indexBom(bomRecords);
  const gross = new Map();
  const paths = [];
  for (const wo of workOrders) {
    const stack = [{ product: wo.product, qty: wo.qty, edges: [] }];
    while (stack.length > 0) {
      const node = stack.pop();
      const children = byParent.get(node.product) ?? [];
      if (children.length === 0 || node.edges.length >= maxDepth) {
        if (node.edges.length > 0) {
          paths.push({ order: wo.id, product: node.product, qty: node.qty, edges: node.edges });
        }
        continue;
      }
      for (const edge of children) {
        const need = node.qty * edge.usage;
        gross.set(edge.component, (gross.get(edge.component) ?? 0) + need);
        stack.push({
          product: edge.component,
          qty: need,
          edges: [...node.edges, {
            parent: edge.parent,
            component: edge.component,
            usage: edge.usage,
            qty: need,
          }],
        });
      }
    }
  }
  return { gross, paths };
}

// Left join gross requirements with inventory on component.
// Missing inventory row or qty === null means "unknown" -> net stays null
// (never coerced to 0). Known inventory nets to max(0, gross - onHand).
export function netRequirements(gross, inventoryRecords) {
  const onHand = new Map(inventoryRecords.map((row) => [row.component, row.qty]));
  const net = new Map();
  for (const [component, required] of gross) {
    if (!onHand.has(component) || onHand.get(component) === null) {
      net.set(component, null);
    } else {
      net.set(component, Math.max(0, required - onHand.get(component)));
    }
  }
  return net;
}

export function toSortedObject(map) {
  const out = {};
  for (const key of [...map.keys()].sort()) {
    out[key] = map.get(key);
  }
  return out;
}
