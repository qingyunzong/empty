import { QueryError } from './query.js';

const DEFAULT_COL_SEL = 0.5;
const DEFAULT_JOIN_SEL = 0.1;
const MAX_TABLES = 5;

// ---------- plan string (canonical, used for tie-breaking) ----------

export function predString(p) {
  return `${p.col}${p.op}${JSON.stringify(p.value)}`;
}

export function planString(node) {
  switch (node.type) {
    case 'scan': {
      const base = node.index
        ? `IndexScan(${node.table}@${node.index.name})`
        : `SeqScan(${node.table})`;
      if (!node.predicates.length) return base;
      return `${base}[${node.predicates.map(predString).sort().join(',')}]`;
    }
    case 'filter':
      return `Filter(${node.predicates.map(predString).sort().join(',')};${planString(node.input)})`;
    case 'join': {
      const name = node.joinType === 'left' ? 'LeftJoin' : 'InnerJoin';
      const cond = node.cond.map((pair) => pair.join('=')).sort().join('&');
      return `${name}(${cond};${planString(node.left)};${planString(node.right)})`;
    }
    case 'groupby': {
      const keys = node.keys.join(',');
      const aggs = node.aggregates.map((a) => `${a.fn}(${a.col})->${a.as}`).join(',');
      return `GroupBy(${keys}=>${aggs};${planString(node.input)})`;
    }
    default:
      throw new QueryError(`unknown plan node: ${node.type}`);
  }
}

// ---------- cost model ----------
// cost = scanned pages + join intermediate result rows (join output cardinalities)

function colSel(catalog, ref) {
  const [table, column] = ref.split('.');
  return catalog.tables[table].columns[column].selectivity ?? DEFAULT_COL_SEL;
}

function joinSel(catalog, cond) {
  let sel = 1;
  for (const pair of cond) {
    const key = [...pair].sort().join('=');
    sel *= catalog.joinSelectivity?.[key] ?? DEFAULT_JOIN_SEL;
  }
  return sel;
}

export function costOf(plan, catalog) {
  const rec = (node) => {
    switch (node.type) {
      case 'scan': {
        const t = catalog.tables[node.table];
        let rows = t.rowCount;
        for (const p of node.predicates) rows *= colSel(catalog, p.col);
        const pages = node.index
          ? (node.index.pages ?? 2) + Math.max(1, Math.ceil(t.pages * node.index.selectivity))
          : t.pages;
        return { pages, joinRows: 0, rows };
      }
      case 'filter': {
        const inner = rec(node.input);
        let rows = inner.rows;
        for (const p of node.predicates) rows *= colSel(catalog, p.col);
        return { ...inner, rows };
      }
      case 'join': {
        const l = rec(node.left);
        const r = rec(node.right);
        const matched = l.rows * r.rows * joinSel(catalog, node.cond);
        const rows = node.joinType === 'left' ? Math.max(l.rows, matched) : matched;
        return {
          pages: l.pages + r.pages,
          joinRows: l.joinRows + r.joinRows + rows,
          rows,
        };
      }
      case 'groupby':
        return rec(node.input);
      default:
        throw new QueryError(`unknown plan node: ${node.type}`);
    }
  };
  const r = rec(plan);
  return { cost: r.pages + r.joinRows, pages: r.pages, joinRows: r.joinRows };
}

// ---------- enumeration helpers ----------

function* shapes(n) {
  if (n === 1) {
    yield null;
    return;
  }
  for (let l = 1; l < n; l++) {
    for (const ls of shapes(l)) {
      for (const rs of shapes(n - l)) yield [ls, rs];
    }
  }
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function* cartesian(arrays) {
  if (arrays.length === 0) {
    yield [];
    return;
  }
  const [first, ...rest] = arrays;
  for (const x of first) {
    for (const ys of cartesian(rest)) yield [x, ...ys];
  }
}

function buildTree(shape, leaves) {
  let i = 0;
  const build = (s) => (s === null ? { leaf: leaves[i++] } : { left: build(s[0]), right: build(s[1]) });
  return build(shape);
}

function annotate(node, parent = null) {
  node.parent = parent;
  if (node.leaf) {
    node.set = new Set([node.leaf]);
  } else {
    annotate(node.left, node);
    annotate(node.right, node);
    node.set = new Set([...node.left.set, ...node.right.set]);
  }
  return node;
}

function findLeaf(node, table) {
  if (node.leaf) return node.leaf === table ? node : null;
  return findLeaf(node.left, table) ?? findLeaf(node.right, table);
}

function lowestCovering(leaf, otherTable) {
  let node = leaf;
  while (node.parent && !node.parent.set.has(otherTable)) node = node.parent;
  return node.parent;
}

// Assigns join types and conditions to a binary tree; returns null if the
// tree violates left-join null-padding semantics or needs a cross product.
function assignJoins(tree, query) {
  const tables = [query.scan, ...query.joins.map((j) => j.table)];
  const steps = query.joins.map((j, i) => ({ ...j, idx: i + 1 }));
  for (const step of steps) {
    if (step.type !== 'left') continue;
    const leaf = findLeaf(tree, step.table);
    const parent = leaf.parent;
    // The null-supplying table must stay the lone right child of its left
    // join, and every table introduced before it must be on the left side.
    if (!parent || parent.right !== leaf || parent.joinType) return null;
    for (let k = 0; k < step.idx; k++) {
      if (!parent.left.set.has(tables[k])) return null;
    }
    for (const pair of step.on) {
      if (!parent.set.has(pair[0].split('.')[0]) || !parent.set.has(pair[1].split('.')[0])) {
        return null;
      }
    }
    parent.joinType = 'left';
    parent.conds = step.on.map((pair) => [...pair]);
  }
  for (const step of steps) {
    if (step.type === 'left') continue;
    for (const pair of step.on) {
      const leaf = findLeaf(tree, pair[0].split('.')[0]);
      const node = lowestCovering(leaf, pair[1].split('.')[0]);
      if (!node) return null;
      node.conds ??= [];
      node.conds.push([...pair]);
    }
  }
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (node.leaf) continue;
    if (!node.conds || node.conds.length === 0) return null; // no cross products
    node.joinType ??= 'inner';
    stack.push(node.left, node.right);
  }
  return tree;
}

// Legal placement of a single-table predicate: its own scan, or any join
// node above it -- except strictly below a left join whose null-supplying
// (right) side is that table, which would break null-padding semantics.
function legalPositions(tree, pred) {
  const table = pred.col.split('.')[0];
  const leaf = findLeaf(tree, table);
  const positions = [{ kind: 'scan' }];
  let cur = leaf;
  let node = leaf.parent;
  while (node) {
    if (node.joinType === 'left' && node.right === cur) positions.length = 0;
    positions.push({ kind: 'join', node });
    cur = node;
    node = node.parent;
  }
  return positions;
}

function indexOptions(catalog, table, predsAtScan) {
  const tdef = catalog.tables[table];
  const options = [null];
  for (const idx of tdef.indexes ?? []) {
    const idxCol = `${table}.${idx.columns[0]}`;
    if (predsAtScan.some((p) => p.col === idxCol)) options.push(idx);
  }
  return options;
}

function buildPlan(tree, query, preds, posCombo, idxByTable) {
  const build = (node) => {
    if (node.leaf) {
      const atScan = preds.filter(
        (p, i) => posCombo[i].kind === 'scan' && p.col.split('.')[0] === node.leaf,
      );
      return { type: 'scan', table: node.leaf, index: idxByTable.get(node.leaf), predicates: atScan };
    }
    let plan = {
      type: 'join',
      joinType: node.joinType,
      cond: node.conds,
      left: build(node.left),
      right: build(node.right),
    };
    const atNode = preds.filter((p, i) => posCombo[i].kind === 'join' && posCombo[i].node === node);
    if (atNode.length) plan = { type: 'filter', predicates: atNode, input: plan };
    return plan;
  };
  let plan = build(tree);
  if (query.groupBy) {
    plan = {
      type: 'groupby',
      keys: query.groupBy.keys,
      aggregates: query.groupBy.aggregates,
      input: plan,
    };
  }
  return plan;
}

// Enumerates every legal plan (all binary join orders x predicate pushdown
// positions x index choices), evaluates each with the cost model, and keeps
// the cheapest; ties go to the lexicographically smallest plan string.
export function optimize(query, catalog) {
  const tables = [query.scan, ...query.joins.map((j) => j.table)];
  if (tables.length > MAX_TABLES) {
    throw new QueryError(`too many tables: ${tables.length} > ${MAX_TABLES}`);
  }
  const preds = query.filter;
  let best = null;
  const consider = (plan) => {
    const cost = Math.round(costOf(plan, catalog).cost * 1e6) / 1e6;
    const ps = planString(plan);
    if (!best || cost < best.cost || (cost === best.cost && ps < best.planString)) {
      best = { plan, planString: ps, cost };
    }
  };
  for (const shape of shapes(tables.length)) {
    for (const perm of permutations(tables)) {
      const tree = annotate(buildTree(shape, perm));
      if (!assignJoins(tree, query)) continue;
      const posOpts = preds.map((p) => legalPositions(tree, p));
      for (const posCombo of cartesian(posOpts)) {
        const atScan = new Map(tables.map((t) => [t, []]));
        preds.forEach((p, i) => {
          if (posCombo[i].kind === 'scan') atScan.get(p.col.split('.')[0]).push(p);
        });
        const idxOpts = tables.map((t) => indexOptions(catalog, t, atScan.get(t)));
        for (const idxCombo of cartesian(idxOpts)) {
          const idxByTable = new Map(tables.map((t, i) => [t, idxCombo[i]]));
          consider(buildPlan(tree, query, preds, posCombo, idxByTable));
        }
      }
    }
  }
  if (!best) throw new QueryError('no legal plan exists for query');
  return best;
}
