// Physical plan enumeration with a simple cardinality-based cost model.
// Costs use actual input cardinalities (single-node, offline: data is present).
//   seqscan:    cost = rows
//   filter:     child + rows(child)
//   project:    child + rows(child)
//   hashjoin:   children + |L| + |R|      (build + probe)
//   nestedjoin: children + |L| * |R|      (double loop)
//   aggregates: child + rows(child)

const mk = (node, rows, cost) => ({ node, rows, cost });

export function enumeratePhysical(node, ctx) {
  switch (node.type) {
    case 'scan': {
      const rows = ctx.tables[node.table].rows.length;
      return [mk({ op: 'seqscan', table: node.table, alias: node.alias, columns: node.columns }, rows, rows)];
    }
    case 'select':
      return enumeratePhysical(node.input, ctx).map((c) =>
        mk({ op: 'filter', predicate: node.predicate, input: c.node }, c.rows, c.cost + c.rows));
    case 'project':
      return enumeratePhysical(node.input, ctx).map((c) =>
        mk({ op: 'project', items: node.items, input: c.node }, c.rows, c.cost + c.rows));
    case 'join': {
      const L = enumeratePhysical(node.left, ctx);
      const R = enumeratePhysical(node.right, ctx);
      const out = [];
      for (const l of L) {
        for (const r of R) {
          const estRows = l.rows * r.rows;
          out.push(mk(
            { op: 'hashjoin', left: l.node, right: r.node, leftKeys: node.leftKeys, rightKeys: node.rightKeys },
            estRows, l.cost + r.cost + l.rows + r.rows));
          out.push(mk(
            { op: 'nestedjoin', left: l.node, right: r.node, leftKeys: node.leftKeys, rightKeys: node.rightKeys },
            estRows, l.cost + r.cost + l.rows * r.rows));
        }
      }
      return out;
    }
    case 'groupby':
      return enumeratePhysical(node.input, ctx).map((c) =>
        mk({ op: 'hashagg', keys: node.keys, keyCols: node.keyCols, aggs: node.aggs, having: node.having, input: c.node },
          c.rows, c.cost + c.rows));
    case 'aggpartial':
      return enumeratePhysical(node.input, ctx).map((c) =>
        mk({ op: 'partagg', keys: node.keys, keyCols: node.keyCols, aggs: node.aggs, input: c.node },
          c.rows, c.cost + c.rows));
    case 'aggfinal':
      return enumeratePhysical(node.input, ctx).map((c) =>
        mk({ op: 'finalagg', keys: node.keys, keyCols: node.keyCols, aggs: node.aggs, having: node.having, input: c.node },
          c.rows, c.cost + c.rows));
    default:
      throw new Error(`enumeratePhysical: unknown node type ${node.type}`);
  }
}

// All plans tied at the minimum cost are returned, never just the first.
export function bestPlans(alts) {
  let min = Infinity;
  for (const a of alts) if (a.cost < min) min = a.cost;
  return alts.filter((a) => a.cost === min);
}
