'use strict';

// Rewrite rules, each recorded in `rules` for the equivalence certificate:
//   1. predicate_pushdown  - conjuncts move below joins / group-by when they
//      only reference columns available there. Conjuncts referencing both
//      join sides merge into the join condition. 3VL-safe: WHERE keeps only
//      TRUE rows, and pushing a conjunct below an inner join keeps exactly
//      the same TRUE set on both sides.
//   2. projection_pruning  - scans carry only columns needed upstream.
//      Bag semantics preserved: pruning never introduces DISTINCT.
//   3. aggregate_pushdown  - GroupBy moves below an inner equi-join only when
//      the other side's join key is verified UNIQUE on non-NULL rows in the
//      actual data, group keys include this side's join key, and all
//      aggregates/HAVING reference only this side. Then each row matches at
//      most one partner, so pre-aggregation is exact (NULL keys never match
//      in either plan, duplicates are preserved 1:1). Additionally, this
//      side's join key must contain no NULLs and every key must exist on the
//      other side (verified on data): otherwise pre-aggregation would form
//      groups the join would later discard, which would leak spurious
//      HAVING=unknown groups into the observable diagnostics.
const E = require('./expr');
const { colsOf } = require('./plan');

function pushdown(node, rules) {
  switch (node.op) {
    case 'filter': {
      const input = pushdown(node.input, rules);
      const conj = E.splitAnd(node.pred);
      if (input.op === 'join') {
        const L = colsOf(input.left);
        const R = colsOf(input.right);
        const toL = [];
        const toR = [];
        const toCond = [];
        const stay = [];
        for (const c of conj) {
          const r = E.refs(c);
          if (r.size === 0) { stay.push(c); continue; }
          const inL = [...r].every((x) => L.has(x));
          const inR = [...r].every((x) => R.has(x));
          if (inL) toL.push(c);
          else if (inR) toR.push(c);
          else toCond.push(c);
        }
        if (!toL.length && !toR.length && !toCond.length) return { ...node, input };
        rules.push({
          rule: 'predicate_pushdown',
          detail: `join: ${toL.length} conjunct(s) to left, ${toR.length} to right, ${toCond.length} into join condition`,
        });
        let { left, right, cond } = input;
        if (toL.length) left = pushdown({ op: 'filter', pred: E.andAll(toL), input: left }, rules);
        if (toR.length) right = pushdown({ op: 'filter', pred: E.andAll(toR), input: right }, rules);
        if (toCond.length) cond = E.andAll([cond, ...toCond]);
        const j = { ...input, left, right, cond };
        return stay.length ? { op: 'filter', pred: E.andAll(stay), input: j } : j;
      }
      if (input.op === 'groupby') {
        const keySet = new Set(input.keys.map((k) => k.ref));
        const below = [];
        const stay = [];
        for (const c of conj) {
          const r = E.refs(c);
          if (r.size > 0 && [...r].every((x) => keySet.has(x))) below.push(c);
          else stay.push(c);
        }
        if (!below.length) return { ...node, input };
        rules.push({ rule: 'predicate_pushdown', detail: 'key-only conjunct(s) pushed below group by' });
        const g = { ...input, input: pushdown({ op: 'filter', pred: E.andAll(below), input: input.input }, rules) };
        return stay.length ? { op: 'filter', pred: E.andAll(stay), input: g } : g;
      }
      if (input.op === 'filter') {
        rules.push({ rule: 'predicate_merge', detail: 'merged adjacent filters' });
        return pushdown({ op: 'filter', pred: E.andAll([node.pred, input.pred]), input: input.input }, rules);
      }
      return { ...node, input };
    }
    case 'join':
      return { ...node, left: pushdown(node.left, rules), right: pushdown(node.right, rules) };
    case 'groupby':
      return { ...node, input: pushdown(node.input, rules) };
    case 'project':
      return { ...node, input: pushdown(node.input, rules) };
    default:
      return node;
  }
}

function splitQual(q) {
  const i = q.lastIndexOf('.');
  return [q.slice(0, i), q.slice(i + 1)];
}

function prune(node, need, rules) {
  switch (node.op) {
    case 'scan': {
      const avail = node.columns.map((c) => node.alias + '.' + c);
      const keep = avail.filter((c) => need.has(c));
      if (keep.length === avail.length) return node;
      const dropped = avail.filter((c) => !need.has(c));
      rules.push({ rule: 'projection_pruning', detail: `${node.alias}: pruned [${dropped.join(', ')}]` });
      return {
        op: 'project',
        items: keep.map((q) => {
          const [a, c] = splitQual(q);
          return { expr: { t: 'col', table: a, name: c, ref: q }, name: q };
        }),
        input: node,
      };
    }
    case 'filter':
      return { ...node, input: prune(node.input, new Set([...need, ...E.refs(node.pred)]), rules) };
    case 'project': {
      const childNeed = new Set();
      for (const it of node.items) for (const r of E.refs(it.expr)) childNeed.add(r);
      return { ...node, input: prune(node.input, childNeed, rules) };
    }
    case 'join': {
      const all = new Set([...need, ...E.refs(node.cond)]);
      const L = colsOf(node.left);
      const R = colsOf(node.right);
      const needL = new Set([...all].filter((x) => L.has(x)));
      const needR = new Set([...all].filter((x) => R.has(x)));
      return { ...node, left: prune(node.left, needL, rules), right: prune(node.right, needR, rules) };
    }
    case 'groupby': {
      const childNeed = new Set();
      for (const k of node.keys) for (const r of E.refs(k)) childNeed.add(r);
      for (const a of node.aggs) if (a.arg) for (const r of E.refs(a.arg)) childNeed.add(r);
      if (node.having) for (const r of E.refsOutsideAggs(node.having)) childNeed.add(r);
      return { ...node, input: prune(node.input, childNeed, rules) };
    }
    default:
      return node;
  }
}

function equiPairs(cond, L, R) {
  const pairs = [];
  const residual = [];
  for (const c of E.splitAnd(cond)) {
    if (c.t === 'bin' && c.op === '=' && c.l.t === 'col' && c.r.t === 'col') {
      if (L.has(c.l.ref) && R.has(c.r.ref)) { pairs.push({ l: c.l, r: c.r }); continue; }
      if (L.has(c.r.ref) && R.has(c.l.ref)) { pairs.push({ l: c.r, r: c.l }); continue; }
    }
    residual.push(c);
  }
  return { pairs, residual };
}

function findScan(node) {
  let n = node;
  while (n) {
    if (n.op === 'scan') return n;
    if (n.op === 'filter' || n.op === 'project') { n = n.input; continue; }
    return null;
  }
  return null;
}

function tryAggPushdown(node, rules, stats) {
  if (node.op !== 'project') return node;
  const g = node.input;
  if (!g || g.op !== 'groupby') return node;
  const j = g.input;
  if (!j || j.op !== 'join') return node;
  const L = colsOf(j.left);
  const R = colsOf(j.right);
  const { pairs, residual } = equiPairs(j.cond, L, R);
  if (!pairs.length || residual.length) return node;

  for (const side of ['left', 'right']) {
    const sCols = side === 'left' ? L : R;
    const keyRefs = g.keys.map((k) => k.ref);
    if (!keyRefs.every((r) => sCols.has(r))) continue;
    if (!g.aggs.every((a) => !a.arg || [...E.refs(a.arg)].every((r) => sCols.has(r)))) continue;
    if (g.having && ![...E.refsOutsideAggs(g.having)].every((r) => sCols.has(r))) continue;
    const sKeys = pairs.map((p) => (side === 'left' ? p.l : p.r).ref);
    if (!sKeys.every((k) => keyRefs.includes(k))) continue;
    const other = side === 'left' ? j.right : j.left;
    const scan = findScan(other);
    if (!scan) continue;
    const rKeyCols = pairs.map((p) => splitQual((side === 'left' ? p.r : p.l).ref)[1]);
    if (!stats.isUnique(scan.table, rKeyCols)) continue;
    const sScan = findScan(side === 'left' ? j.left : j.right);
    if (!sScan) continue;
    const sKeyCols = sKeys.map((q) => splitQual(q)[1]);
    if (stats.hasNullKey(sScan.table, sKeyCols)) continue;
    if (!stats.keysIncluded(sScan.table, sKeyCols, scan.table, rKeyCols)) continue;
    rules.push({
      rule: 'aggregate_pushdown',
      detail: `group by pushed below join on ${side} side; verified unique key ${scan.alias}(${rKeyCols.join(',')}), non-null included key ${sScan.alias}(${sKeyCols.join(',')})`,
    });
    const newG = { ...g, input: side === 'left' ? j.left : j.right };
    const newJ = side === 'left' ? { ...j, left: newG } : { ...j, right: newG };
    return { ...node, input: newJ };
  }
  return node;
}

function aggPushdown(node, rules, stats) {
  let n = node;
  if (n.op === 'join') {
    n = { ...n, left: aggPushdown(n.left, rules, stats), right: aggPushdown(n.right, rules, stats) };
  } else if (n.input) {
    n = { ...n, input: aggPushdown(n.input, rules, stats) };
  }
  return tryAggPushdown(n, rules, stats);
}

function optimize(plan, stats) {
  const rules = [];
  let p = pushdown(plan, rules);
  p = aggPushdown(p, rules, stats);
  p = prune(p, new Set(), rules);
  return { plan: p, rules };
}

module.exports = { optimize, equiPairs };
