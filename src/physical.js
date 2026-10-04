'use strict';

// Physical operators: seqscan / filter / project / nljoin / hashjoin / hashagg.
// NULL join keys never match; aggregates ignore NULL inputs; HAVING is
// three-valued and unknown groups are reported via ctx.unknown (never
// silently dropped).
const E = require('./expr');
const V = require('./values');
const { colsOf } = require('./plan');
const { equiPairs } = require('./optimize');
const { E_TYPE } = require('./errors');

function selOf(pred) {
  switch (pred.t) {
    case 'bin':
      if (pred.op === 'AND') return selOf(pred.l) * selOf(pred.r);
      if (pred.op === 'OR') {
        const a = selOf(pred.l);
        const b = selOf(pred.r);
        return Math.min(1, a + b - a * b);
      }
      return pred.op === '=' ? 0.1 : 0.33;
    case 'not':
      return 1 - selOf(pred.e);
    case 'isnull':
      return pred.negated ? 0.9 : 0.1;
    default:
      return 0.5;
  }
}

// Enumerate physical alternatives with costs. Cost model (deterministic):
//   scan: rows | filter: child + rows | project: child
//   nested loop join: l + r + |L|*|R|   hash join: l + r + |L|+|R|
//   aggregate: child + rows
function enumerate(node, stats) {
  switch (node.op) {
    case 'scan': {
      const rows = stats.rowCount(node.table);
      return [{ plan: { op: 'seqscan', table: node.table, alias: node.alias, columns: node.columns }, cost: rows, rows }];
    }
    case 'filter':
      return enumerate(node.input, stats).map((c) => ({
        plan: { op: 'filter', pred: node.pred, input: c.plan },
        cost: c.cost + c.rows,
        rows: Math.max(1, Math.round(c.rows * selOf(node.pred))),
      }));
    case 'project':
      return enumerate(node.input, stats).map((c) => ({
        plan: { op: 'project', items: node.items, input: c.plan },
        cost: c.cost,
        rows: c.rows,
      }));
    case 'join': {
      const L = enumerate(node.left, stats);
      const R = enumerate(node.right, stats);
      const out = [];
      const Lc = colsOf(node.left);
      const Rc = colsOf(node.right);
      const { pairs } = equiPairs(node.cond, Lc, Rc);
      for (const l of L) {
        for (const r of R) {
          const rows = Math.max(1, Math.round(l.rows * r.rows * 0.1));
          out.push({
            plan: { op: 'nljoin', cond: node.cond, left: l.plan, right: r.plan },
            cost: l.cost + r.cost + l.rows * r.rows,
            rows,
          });
          if (pairs.length) {
            out.push({
              plan: { op: 'hashjoin', cond: node.cond, left: l.plan, right: r.plan },
              cost: l.cost + r.cost + l.rows + r.rows,
              rows,
            });
          }
        }
      }
      return out;
    }
    case 'groupby':
      return enumerate(node.input, stats).map((c) => ({
        plan: { op: 'hashagg', keys: node.keys, aggs: node.aggs, having: node.having, input: c.plan },
        cost: c.cost + c.rows,
        rows: Math.max(1, Math.round(c.rows / 2)),
      }));
  }
  throw E_TYPE(`cannot enumerate physical plan for op ${node.op}`);
}

// All plans tied at the minimum cost (acceptance: report every tie).
function bestPlans(node, stats) {
  const all = enumerate(node, stats);
  const min = Math.min(...all.map((a) => a.cost));
  return all.filter((a) => a.cost === min);
}

// Direct enumeration baseline: the unoptimized logical plan executed with
// nested-loop joins only (brute force semantics reference).
function toDirect(node) {
  switch (node.op) {
    case 'scan':
      return { op: 'seqscan', table: node.table, alias: node.alias, columns: node.columns };
    case 'filter':
      return { op: 'filter', pred: node.pred, input: toDirect(node.input) };
    case 'project':
      return { op: 'project', items: node.items, input: toDirect(node.input) };
    case 'join':
      return { op: 'nljoin', cond: node.cond, left: toDirect(node.left), right: toDirect(node.right) };
    case 'groupby':
      return { op: 'hashagg', keys: node.keys, aggs: node.aggs, having: node.having, input: toDirect(node.input) };
  }
  throw E_TYPE(`toDirect: unknown op ${node.op}`);
}

function keyOf(row, refs) {
  const vals = refs.map((r) => row[r]);
  if (vals.some((v) => v === null || v === undefined)) return null;
  return vals.map(V.encVal).join('|');
}

function mergeRows(l, r) {
  const m = { ...l, ...r };
  if (l.__aggs !== undefined) m.__aggs = l.__aggs;
  if (r.__aggs !== undefined) m.__aggs = r.__aggs;
  return m;
}

function execute(node, data, ctx) {
  switch (node.op) {
    case 'seqscan': {
      const rows = data[node.table] || [];
      return rows.map((r) => {
        const o = {};
        for (const c of node.columns) o[node.alias + '.' + c] = r[c] === undefined ? null : r[c];
        return o;
      });
    }
    case 'filter': {
      const input = execute(node.input, data, ctx);
      return input.filter((row) => {
        const v = V.checkBool(E.evalExpr(node.pred, row, row.__aggs), 'WHERE');
        return v === true;
      });
    }
    case 'project': {
      const input = execute(node.input, data, ctx);
      return input.map((row) => {
        const o = {};
        for (const it of node.items) o[it.name] = E.evalExpr(it.expr, row, row.__aggs);
        return o;
      });
    }
    case 'nljoin': {
      const L = execute(node.left, data, ctx);
      const R = execute(node.right, data, ctx);
      const out = [];
      for (const l of L) {
        for (const r of R) {
          const m = mergeRows(l, r);
          const v = V.checkBool(E.evalExpr(node.cond, m, m.__aggs), 'JOIN ON');
          if (v === true) out.push(m);
        }
      }
      return out;
    }
    case 'hashjoin': {
      const L = execute(node.left, data, ctx);
      const R = execute(node.right, data, ctx);
      const Lc = colsOf(node.left);
      const Rc = colsOf(node.right);
      const { pairs, residual } = equiPairs(node.cond, Lc, Rc);
      const rest = residual.length ? E.andAll(residual) : null;
      const table = new Map();
      for (const r of R) {
        const k = keyOf(r, pairs.map((p) => p.r.ref));
        if (k === null) continue; // NULL join keys never match
        const arr = table.get(k);
        if (arr) arr.push(r);
        else table.set(k, [r]);
      }
      const out = [];
      for (const l of L) {
        const k = keyOf(l, pairs.map((p) => p.l.ref));
        if (k === null) continue;
        const matches = table.get(k);
        if (!matches) continue;
        for (const r of matches) {
          const m = mergeRows(l, r);
          if (rest) {
            const v = V.checkBool(E.evalExpr(rest, m, m.__aggs), 'JOIN ON');
            if (v !== true) continue;
          }
          out.push(m);
        }
      }
      return out;
    }
    case 'hashagg': {
      const input = execute(node.input, data, ctx);
      const groups = new Map();
      const newAcc = () => node.aggs.map(() => ({ n: 0, s: 0, min: null, max: null, type: null }));
      for (const row of input) {
        const kv = node.keys.map((k) => E.evalExpr(k, row, row.__aggs));
        const sk = kv.map(V.encVal).join('|');
        let g = groups.get(sk);
        if (!g) {
          g = { kv, acc: newAcc() };
          groups.set(sk, g);
        }
        node.aggs.forEach((a, i) => {
          const acc = g.acc[i];
          if (a.arg === null) { acc.n++; return; }
          const v = E.evalExpr(a.arg, row, row.__aggs);
          if (v === null || v === undefined) return; // aggregates ignore NULL
          if (a.func === 'COUNT') { acc.n++; return; }
          if (a.func === 'SUM' || a.func === 'AVG') {
            if (typeof v !== 'number') throw E_TYPE(`${a.func} requires numeric input, got ${typeof v}`);
            acc.s += v;
            acc.n++;
            return;
          }
          if (acc.type === null) {
            acc.type = typeof v;
            acc.min = v;
            acc.max = v;
          } else {
            if (typeof v !== acc.type) throw E_TYPE(`${a.func} on mixed types (${acc.type} vs ${typeof v})`);
            if (v < acc.min) acc.min = v;
            if (v > acc.max) acc.max = v;
          }
          acc.n++;
        });
      }
      if (node.keys.length === 0 && groups.size === 0) groups.set('', { kv: [], acc: newAcc() });
      const out = [];
      for (const g of groups.values()) {
        const vals = node.aggs.map((a, i) => {
          const acc = g.acc[i];
          if (a.func === 'COUNT') return acc.n;
          if (a.func === 'SUM') return acc.n ? acc.s : null;
          if (a.func === 'AVG') return acc.n ? acc.s / acc.n : null;
          if (a.func === 'MIN') return acc.n ? acc.min : null;
          if (a.func === 'MAX') return acc.n ? acc.max : null;
          return null;
        });
        const row = {};
        node.keys.forEach((k, i) => { row[k.ref] = g.kv[i]; });
        row.__aggs = vals;
        let hv = true;
        if (node.having) hv = V.checkBool(E.evalExpr(node.having, row, vals), 'HAVING');
        if (hv === true) {
          out.push(row);
        } else if (hv === null) {
          // Three-valued HAVING: unknown groups are surfaced, never dropped silently.
          const d = {};
          node.keys.forEach((k, i) => { d[k.ref] = g.kv[i]; });
          node.aggs.forEach((a, i) => { d['agg#' + a.idx] = vals[i]; });
          ctx.unknown.push(d);
        } else {
          ctx.falseCount++;
        }
      }
      return out;
    }
  }
  throw E_TYPE(`cannot execute op ${node.op}`);
}

function execResult(physicalPlan, data) {
  const ctx = { unknown: [], falseCount: 0 };
  const rows = execute(physicalPlan, data, ctx);
  return { rows, unknown: ctx.unknown, falseCount: ctx.falseCount };
}

module.exports = { enumerate, bestPlans, toDirect, execute, execResult };
