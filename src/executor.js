import { createHash } from 'node:crypto';

function qualify(table, row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [`${table}.${k}`, v]));
}

function applyPred(row, p) {
  const v = row[p.col];
  if (v === null || v === undefined) return false; // SQL three-valued logic
  switch (p.op) {
    case '=': return v === p.value;
    case '!=': return v !== p.value;
    case '<': return v < p.value;
    case '<=': return v <= p.value;
    case '>': return v > p.value;
    case '>=': return v >= p.value;
    default: throw new Error(`unknown operator: ${p.op}`);
  }
}

function tablesOf(plan) {
  const out = [];
  const walk = (n) => {
    if (n.type === 'scan') out.push(n.table);
    if (n.input) walk(n.input);
    if (n.left) walk(n.left);
    if (n.right) walk(n.right);
  };
  walk(plan);
  return out;
}

function columnsOf(plan, catalog) {
  return tablesOf(plan).flatMap((t) =>
    Object.keys(catalog.tables[t].columns).map((c) => `${t}.${c}`),
  );
}

// Hash join. Join keys that are null (on either side) never match.
function execJoin(plan, data, catalog) {
  const leftRows = executePlan(plan.left, data, catalog);
  const rightRows = executePlan(plan.right, data, catalog);
  const leftTables = new Set(tablesOf(plan.left));
  const pairs = plan.cond.map(([a, b]) =>
    leftTables.has(a.split('.')[0]) ? [a, b] : [b, a],
  );
  const hash = new Map();
  for (const r of rightRows) {
    const key = pairs.map(([, rc]) => r[rc]);
    if (key.some((v) => v === null || v === undefined)) continue;
    const k = JSON.stringify(key);
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k).push(r);
  }
  const nullPadding = plan.joinType === 'left'
    ? Object.fromEntries(columnsOf(plan.right, catalog).map((c) => [c, null]))
    : null;
  const out = [];
  for (const l of leftRows) {
    const key = pairs.map(([lc]) => l[lc]);
    const matches = key.some((v) => v === null || v === undefined)
      ? []
      : (hash.get(JSON.stringify(key)) ?? []);
    if (matches.length) {
      for (const m of matches) out.push({ ...l, ...m });
    } else if (plan.joinType === 'left') {
      out.push({ ...l, ...nullPadding });
    }
  }
  return out;
}

function aggregate(agg, rows) {
  if (agg.fn === 'count') {
    return agg.col === '*' ? rows.length : rows.filter((r) => r[agg.col] != null).length;
  }
  const vals = rows.map((r) => r[agg.col]).filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return null;
  switch (agg.fn) {
    case 'sum': return vals.reduce((a, b) => a + b, 0);
    case 'avg': return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'min': return vals.reduce((a, b) => (b < a ? b : a));
    case 'max': return vals.reduce((a, b) => (b > a ? b : a));
    default: throw new Error(`unknown aggregate: ${agg.fn}`);
  }
}

// null is its own group, distinct from every concrete value.
function execGroupBy(plan, data, catalog) {
  const rows = executePlan(plan.input, data, catalog);
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(plan.keys.map((k) => {
      const v = row[k];
      return v === null || v === undefined ? { $null: 0 } : { $v: v };
    }));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = [];
  for (const groupRows of groups.values()) {
    const rec = {};
    for (const k of plan.keys) rec[k] = groupRows[0][k] ?? null;
    for (const agg of plan.aggregates) rec[agg.as] = aggregate(agg, groupRows);
    out.push(rec);
  }
  return out;
}

export function executePlan(plan, data, catalog) {
  switch (plan.type) {
    case 'scan':
      return (data[plan.table] ?? [])
        .map((r) => qualify(plan.table, r))
        .filter((row) => plan.predicates.every((p) => applyPred(row, p)));
    case 'filter':
      return executePlan(plan.input, data, catalog)
        .filter((row) => plan.predicates.every((p) => applyPred(row, p)));
    case 'join':
      return execJoin(plan, data, catalog);
    case 'groupby':
      return execGroupBy(plan, data, catalog);
    default:
      throw new Error(`unknown plan node: ${plan.type}`);
  }
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

export function hashRows(rows) {
  const norm = rows.map((r) => JSON.stringify(sortKeys(r))).sort().join('\n');
  return createHash('sha256').update(norm).digest('hex');
}
