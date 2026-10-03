import { loadTableRows, tableStats } from './catalog.js';

function qualify(table, row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[`${table}.${key}`] = value;
  return out;
}

function applyPredicate(row, p) {
  const v = row[p.col];
  if (v === null || v === undefined) return false;
  switch (p.op) {
    case '=':
      return v === p.value;
    case '!=':
      return v !== p.value;
    case '<':
      return v < p.value;
    case '<=':
      return v <= p.value;
    case '>':
      return v > p.value;
    case '>=':
      return v >= p.value;
    default:
      throw new Error(`unsupported operator: ${p.op}`);
  }
}

function condMatch(left, right, conds) {
  return conds.every((c) => {
    // condition columns are table-qualified; orient them against the two sides
    const [lk, rk] = c.left in left ? [c.left, c.right] : [c.right, c.left];
    const lv = left[lk];
    const rv = right[rk];
    // join conditions match non-null values only
    return lv !== null && lv !== undefined && rv !== null && rv !== undefined && lv === rv;
  });
}

function computeAggregate(fn, col, rows) {
  if (fn === 'count') {
    if (col === '*') return rows.length;
    return rows.filter((r) => r[col] !== null && r[col] !== undefined).length;
  }
  const values = rows
    .map((r) => r[col])
    .filter((v) => v !== null && v !== undefined);
  if (values.length === 0) return null;
  switch (fn) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return values.reduce((a, b) => (b < a ? b : a));
    case 'max':
      return values.reduce((a, b) => (b > a ? b : a));
    default:
      throw new Error(`unsupported aggregate: ${fn}`);
  }
}

export function executePlan(node, ctx) {
  switch (node.op) {
    case 'scan':
      return loadTableRows(ctx.dbDir, node.table).map((r) => qualify(node.table, r));
    case 'idxscan': {
      const key = `${node.table}.${node.column}`;
      return loadTableRows(ctx.dbDir, node.table)
        .map((r) => qualify(node.table, r))
        .filter((r) => r[key] !== null && r[key] !== undefined && r[key] === node.value);
    }
    case 'filter': {
      const rows = executePlan(node.input, ctx);
      return rows.filter((r) => node.predicates.every((p) => applyPredicate(r, p)));
    }
    case 'join': {
      const leftRows = executePlan(node.left, ctx);
      const rightRows = executePlan(node.right, ctx);
      const out = [];
      if (node.type === 'inner') {
        for (const l of leftRows) {
          for (const r of rightRows) {
            if (condMatch(l, r, node.conds)) out.push({ ...l, ...r });
          }
        }
        return out;
      }
      // left join: unmatched left rows are padded with nulls for right columns
      const rightTable = node.right.table;
      const rightCols = Object.keys(tableStats(ctx.catalog, rightTable).columns);
      const nullPad = {};
      for (const c of rightCols) nullPad[`${rightTable}.${c}`] = null;
      for (const l of leftRows) {
        let matched = false;
        for (const r of rightRows) {
          if (condMatch(l, r, node.conds)) {
            out.push({ ...l, ...r });
            matched = true;
          }
        }
        if (!matched) out.push({ ...l, ...nullPad });
      }
      return out;
    }
    case 'groupby': {
      const rows = executePlan(node.input, ctx);
      const groups = new Map();
      for (const row of rows) {
        // null is its own group (JSON.stringify keeps null distinct from "null")
        const keyVals = node.keys.map((k) => row[k] ?? null);
        const key = JSON.stringify(keyVals);
        if (!groups.has(key)) groups.set(key, { keyVals, rows: [] });
        groups.get(key).rows.push(row);
      }
      const out = [];
      for (const { keyVals, rows: members } of groups.values()) {
        const outRow = {};
        node.keys.forEach((k, i) => {
          outRow[k] = keyVals[i];
        });
        for (const agg of node.aggregates) {
          outRow[agg.as] = computeAggregate(agg.fn, agg.col, members);
        }
        out.push(outRow);
      }
      return out;
    }
    default:
      throw new Error(`unknown plan node: ${node.op}`);
  }
}
