import {
  RANGE_SELECTIVITY,
  distinctOf,
  hasIndex,
  pagesOf,
  selectivityOf,
  tableStats,
} from './catalog.js';
import { validateQuery } from './query.js';

const MAX_CANDIDATES = 100000;

// ---------- skeleton enumeration (join orders) ----------

function enumOrderedTrees(units) {
  // All ordered binary trees over the given unit sequence.
  if (units.length === 1) return [units[0]];
  const trees = [];
  const n = units.length;
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    const left = [];
    const right = [];
    for (let i = 0; i < n; i++) (mask >> i & 1 ? left : right).push(units[i]);
    for (const lt of enumOrderedTrees(left)) {
      for (const rt of enumOrderedTrees(right)) {
        trees.push({ kind: 'join', jtype: 'inner', left: lt, right: rt, conds: [] });
      }
    }
  }
  return trees;
}

function enumSkeletons(query) {
  // Inner joins are freely reorderable within a segment; a left join is a
  // barrier: its left subtree (everything before it) and right table are fixed.
  const segments = [{ leftJoin: null, tables: [query.from] }];
  for (const join of query.joins) {
    if (join.type === 'inner') segments[segments.length - 1].tables.push(join.table);
    else segments.push({ leftJoin: join, tables: [] });
  }
  const scan = (t) => ({ kind: 'scan', table: t });
  let trees = enumOrderedTrees(segments[0].tables.map(scan));
  for (let s = 1; s < segments.length; s++) {
    const seg = segments[s];
    const right = scan(seg.leftJoin.table);
    trees = trees.map((lt) => ({
      kind: 'join',
      jtype: 'left',
      left: lt,
      right,
      conds: [seg.leftJoin.cond],
    }));
    if (seg.tables.length > 0) {
      const scans = seg.tables.map(scan);
      const next = [];
      for (const acc of trees) {
        for (const t of enumOrderedTrees([acc, ...scans])) next.push(t);
      }
      trees = next;
    }
  }
  return trees;
}

// ---------- join condition assignment ----------

function tablesOf(node, acc = new Set()) {
  if (node.kind === 'scan') acc.add(node.table);
  else {
    tablesOf(node.left, acc);
    tablesOf(node.right, acc);
  }
  return acc;
}

function condTables(cond) {
  return [cond.lcol.split('.')[0], cond.rcol.split('.')[0]];
}

function assignConds(node, innerConds) {
  if (node.kind === 'scan') return;
  assignConds(node.left, innerConds);
  assignConds(node.right, innerConds);
  if (node.jtype !== 'inner') return;
  const lt = tablesOf(node.left);
  const rt = tablesOf(node.right);
  node.conds = innerConds.filter((c) => {
    const [a, b] = condTables(c);
    return (lt.has(a) && rt.has(b)) || (lt.has(b) && rt.has(a));
  });
}

// ---------- predicate pushdown positions ----------

function annotateParents(node, parent = null) {
  node.parent = parent;
  if (node.kind === 'join') {
    annotateParents(node.left, node);
    annotateParents(node.right, node);
  }
}

function lowestCovering(node, tables) {
  const here = tablesOf(node);
  for (const t of tables) if (!here.has(t)) return null;
  if (node.kind === 'join') {
    return lowestCovering(node.left, tables) ?? lowestCovering(node.right, tables) ?? node;
  }
  return node;
}

function coveringPath(root, tables) {
  const lowest = lowestCovering(root, tables);
  const path = [];
  let cur = lowest;
  while (cur) {
    path.push(cur);
    cur = cur.parent;
  }
  return path;
}

function cartesian(lists) {
  return lists.reduce(
    (acc, list) => acc.flatMap((combo) => list.map((x) => [...combo, x])),
    [[]],
  );
}

function collectScans(node, acc = []) {
  if (node.kind === 'scan') acc.push(node);
  else {
    collectScans(node.left, acc);
    collectScans(node.right, acc);
  }
  return acc;
}

function predString(p) {
  return `${p.col}${p.op}${JSON.stringify(p.value)}`;
}

function buildPlan(node, assigned, indexChoice) {
  if (node.kind === 'scan') {
    const idxPred = indexChoice.get(node) ?? null;
    let plan = idxPred
      ? { op: 'idxscan', table: node.table, column: idxPred.col.split('.')[1], value: idxPred.value }
      : { op: 'scan', table: node.table };
    const here = (assigned.get(node) ?? []).filter((p) => p !== idxPred);
    if (here.length > 0) {
      plan = { op: 'filter', predicates: sortPreds(here), input: plan };
    }
    return plan;
  }
  const left = buildPlan(node.left, assigned, indexChoice);
  const right = buildPlan(node.right, assigned, indexChoice);
  let plan = {
    op: 'join',
    type: node.jtype,
    conds: node.conds.map((c) => ({ left: c.lcol, right: c.rcol })),
    left,
    right,
  };
  const here = assigned.get(node) ?? [];
  if (here.length > 0) plan = { op: 'filter', predicates: sortPreds(here), input: plan };
  return plan;
}

function sortPreds(preds) {
  return [...preds]
    .sort((a, b) => (predString(a) < predString(b) ? -1 : 1))
    .map((p) => ({ col: p.col, op: p.op, value: p.value }));
}

function enumPredicatePlans(skeleton, predicates, catalog) {
  annotateParents(skeleton);
  const paths = predicates.map((p) => coveringPath(skeleton, p.tables));
  const plans = [];
  for (const positions of cartesian(paths)) {
    const assigned = new Map();
    positions.forEach((node, i) => {
      if (!assigned.has(node)) assigned.set(node, []);
      assigned.get(node).push(predicates[i]);
    });
    // index scan variants: for each scan node, at most one equality predicate
    // on an indexed column can be consumed by an index scan
    const scans = collectScans(skeleton);
    const choices = scans.map((scan) => {
      const eligible = (assigned.get(scan) ?? []).filter(
        (p) =>
          p.op === '=' &&
          p.tables.size === 1 &&
          hasIndex(catalog, scan.table, p.col.split('.')[1]),
      );
      return [null, ...eligible];
    });
    for (const picked of cartesian(choices)) {
      const indexChoice = new Map();
      picked.forEach((pred, i) => {
        if (pred) indexChoice.set(scans[i], pred);
      });
      plans.push(buildPlan(skeleton, assigned, indexChoice));
      if (plans.length > MAX_CANDIDATES) throw new Error('plan space too large');
    }
  }
  return plans;
}

// ---------- cost model ----------
// cost = scanned pages + join intermediate (estimated output) rows

function predSelectivity(catalog, p) {
  const [table, column] = p.col.split('.');
  if (p.op === '=') return selectivityOf(catalog, table, column);
  if (p.op === '!=') return 1 - selectivityOf(catalog, table, column);
  return RANGE_SELECTIVITY;
}

export function estimate(node, catalog) {
  switch (node.op) {
    case 'scan': {
      const stats = tableStats(catalog, node.table);
      return { cost: pagesOf(stats.rowCount), rows: stats.rowCount };
    }
    case 'idxscan': {
      const stats = tableStats(catalog, node.table);
      const sel = selectivityOf(catalog, node.table, node.column);
      return {
        // unclustered index: 1 index page + one page fetch per matching row
        cost: 1 + Math.max(1, Math.ceil(stats.rowCount * sel)),
        rows: Math.max(1, Math.ceil(stats.rowCount * sel)),
      };
    }
    case 'filter': {
      const child = estimate(node.input, catalog);
      const sel = node.predicates.reduce(
        (acc, p) => acc * predSelectivity(catalog, p),
        1,
      );
      return { cost: child.cost, rows: Math.max(1, Math.ceil(child.rows * sel)) };
    }
    case 'join': {
      const l = estimate(node.left, catalog);
      const r = estimate(node.right, catalog);
      let rows;
      if (node.conds.length === 0) {
        rows = l.rows * r.rows;
      } else {
        const denom = node.conds.reduce((acc, c) => {
          const [lt, lc] = c.left.split('.');
          const [rt, rc] = c.right.split('.');
          return acc * Math.max(distinctOf(catalog, lt, lc), distinctOf(catalog, rt, rc));
        }, 1);
        rows = Math.max(1, Math.ceil((l.rows * r.rows) / denom));
      }
      if (node.type === 'left') rows = Math.max(l.rows, rows);
      return { cost: l.cost + r.cost + rows, rows };
    }
    case 'groupby': {
      const child = estimate(node.input, catalog);
      const distinct = node.keys.reduce((acc, k) => {
        const [t, c] = k.split('.');
        return acc * distinctOf(catalog, t, c);
      }, 1);
      return { cost: child.cost, rows: Math.min(child.rows, Math.max(1, distinct)) };
    }
    default:
      throw new Error(`unknown plan node: ${node.op}`);
  }
}

// ---------- plan rendering ----------

export function planToString(node) {
  switch (node.op) {
    case 'scan':
      return `scan(${node.table})`;
    case 'idxscan':
      return `idxscan(${node.table}.${node.column}=${JSON.stringify(node.value)})`;
    case 'filter':
      return `filter(${node.predicates.map(predString).join('&&')},${planToString(node.input)})`;
    case 'join': {
      const conds = node.conds
        .map((c) => `${c.left}=${c.right}`)
        .sort()
        .join('&&');
      return `join_${node.type}(${conds},${planToString(node.left)},${planToString(node.right)})`;
    }
    case 'groupby': {
      const aggs = node.aggregates.map((a) => `${a.fn}(${a.col}) as ${a.as}`).join(',');
      return `groupby(${node.keys.join(',')};${aggs},${planToString(node.input)})`;
    }
    default:
      throw new Error(`unknown plan node: ${node.op}`);
  }
}

// ---------- public API ----------

export function enumeratePlans(catalog, rawQuery) {
  const query = validateQuery(catalog, rawQuery);
  if (query.tables.length > 5) throw new Error('too many tables: optimizer supports at most 5');
  const skeletons = enumSkeletons(query);
  const candidates = [];
  for (const skeleton of skeletons) {
    assignConds(skeleton, query.innerConds);
    for (const plan of enumPredicatePlans(skeleton, query.where, catalog)) {
      const full = query.groupBy
        ? { op: 'groupby', keys: query.groupBy.keys, aggregates: query.groupBy.aggregates, input: plan }
        : plan;
      const est = estimate(full, catalog);
      candidates.push({ plan: full, cost: est.cost, rows: est.rows, planString: planToString(full) });
    }
  }
  candidates.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    return a.planString < b.planString ? -1 : a.planString > b.planString ? 1 : 0;
  });
  return { query, candidates };
}

export function optimize(catalog, rawQuery) {
  const { query, candidates } = enumeratePlans(catalog, rawQuery);
  return { best: candidates[0], candidateCount: candidates.length, query };
}
