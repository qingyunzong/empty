'use strict';

// Logical plan nodes (plain data, JSON-serializable):
//   {op:'scan', table, alias, columns}
//   {op:'filter', pred, input}
//   {op:'project', items:[{expr,name}], input}
//   {op:'join', left, right, cond}
//   {op:'groupby', keys:[colExpr], aggs:[{func,arg,idx}], having, input}
const { E_PARSE, E_UNSUPPORTED } = require('./errors');
const E = require('./expr');

function colsOf(node) {
  switch (node.op) {
    case 'scan':
    case 'seqscan':
      return new Set(node.columns.map((c) => node.alias + '.' + c));
    case 'filter':
      return colsOf(node.input);
    case 'join':
    case 'nljoin':
    case 'hashjoin':
      return new Set([...colsOf(node.left), ...colsOf(node.right)]);
    case 'project':
      return new Set(node.items.map((i) => i.name));
    case 'groupby':
    case 'hashagg':
      return new Set(node.keys.map((k) => k.ref));
  }
  throw E_PARSE(`colsOf: unknown node op ${node.op}`);
}

function buildPlan(ast, schemas) {
  const scope = [];
  const mkScan = (ref) => {
    if (!schemas[ref.table]) throw E_PARSE(`unknown table: ${ref.table}`);
    const alias = ref.alias || ref.table;
    if (scope.some((s) => s.alias === alias)) throw E_PARSE(`duplicate table alias: ${alias}`);
    scope.push({ alias, table: ref.table, columns: schemas[ref.table] });
    return { op: 'scan', table: ref.table, alias, columns: schemas[ref.table].slice() };
  };

  let plan = mkScan(ast.from.base);
  for (const j of ast.from.joins) {
    const right = mkScan(j);
    E.resolveExpr(j.on, scope);
    plan = { op: 'join', left: plan, right, cond: j.on };
  }

  if (ast.where) {
    E.resolveExpr(ast.where, scope);
    if (E.hasAgg(ast.where)) throw E_UNSUPPORTED('aggregate functions are not allowed in WHERE');
    plan = { op: 'filter', pred: ast.where, input: plan };
  }

  // Resolve select expressions and HAVING before collecting aggregates so
  // that structurally identical aggregates dedupe on qualified refs.
  const selectExprs = ast.select.filter((it) => !it.star).map((it) => it.expr);
  for (const e of selectExprs) E.resolveExpr(e, scope);
  if (ast.having) E.resolveExpr(ast.having, scope);

  const aggList = [];
  const aggByKey = new Map();
  const register = (a) => {
    const key = E.exprKey(a);
    if (aggByKey.has(key)) {
      a.idx = aggByKey.get(key).idx;
      return;
    }
    a.idx = aggList.length;
    aggByKey.set(key, a);
    aggList.push(a);
  };
  for (const e of selectExprs) E.findAggs(e).forEach(register);
  if (ast.having) E.findAggs(ast.having).forEach(register);
  for (const a of aggList) {
    if (a.arg && E.hasAgg(a.arg)) throw E_UNSUPPORTED('nested aggregates are not supported');
  }

  const grouped = ast.groupBy.length > 0 || aggList.length > 0 || ast.having !== null;

  if (grouped) {
    if (ast.select.some((it) => it.star)) {
      throw E_UNSUPPORTED('SELECT * is not allowed with GROUP BY / aggregates');
    }
    const keys = ast.groupBy.map((e) => {
      E.resolveExpr(e, scope);
      if (e.t !== 'col') throw E_UNSUPPORTED('GROUP BY supports column references only');
      return e;
    });
    const keySet = new Set(keys.map((k) => k.ref));
    const checkOutside = (e, where) => {
      for (const r of E.refsOutsideAggs(e)) {
        if (!keySet.has(r)) {
          throw E_UNSUPPORTED(`column ${r} in ${where} must appear in GROUP BY`);
        }
      }
    };
    for (const e of selectExprs) checkOutside(e, 'SELECT');
    if (ast.having) checkOutside(ast.having, 'HAVING');
    plan = {
      op: 'groupby',
      keys,
      aggs: aggList.map((a) => ({ func: a.func, arg: a.arg, idx: a.idx })),
      having: ast.having,
      input: plan,
    };
  }

  // Top-level projection.
  let items;
  if (ast.select.some((it) => it.star)) {
    items = [];
    for (const s of scope) {
      for (const c of s.columns) {
        items.push({ expr: { t: 'col', table: s.alias, name: c, ref: s.alias + '.' + c }, name: s.alias + '.' + c });
      }
    }
  } else {
    items = ast.select.map((it, i) => {
      const e = it.expr;
      let name = it.alias;
      if (!name) {
        if (e.t === 'col') name = e.name;
        else if (e.t === 'agg') name = `${e.func.toLowerCase()}(${e.arg && e.arg.t === 'col' ? e.arg.name : e.arg ? 'expr' : '*'})`;
        else name = `expr${i}`;
      }
      return { expr: e, name };
    });
  }
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.name)) throw E_PARSE(`duplicate output column name: ${it.name}`);
    seen.add(it.name);
  }
  plan = { op: 'project', items, input: plan };
  return plan;
}

function formatPlan(node, indent = '') {
  const lines = [];
  const rec = (n, pad) => {
    let head;
    switch (n.op) {
      case 'scan':
      case 'seqscan':
        head = `Scan ${n.table} AS ${n.alias} [${n.columns.join(', ')}]`;
        break;
      case 'filter':
        head = `Filter ${E.exprToString(n.pred)}`;
        break;
      case 'project':
        head = `Project ${n.items.map((i) => `${i.name} := ${E.exprToString(i.expr)}`).join(', ')}`;
        break;
      case 'join':
      case 'nljoin':
      case 'hashjoin':
        head = `${n.op === 'join' ? 'Join' : n.op === 'nljoin' ? 'NestedLoopJoin' : 'HashJoin'} ON ${E.exprToString(n.cond)}`;
        break;
      case 'groupby':
      case 'hashagg': {
        const keys = n.keys.map((k) => k.ref).join(', ') || '(none)';
        const aggs = n.aggs.map((a) => `#${a.idx}=${a.func}(${a.arg ? E.exprToString(a.arg) : '*'})`).join(', ');
        head = `${n.op === 'groupby' ? 'GroupBy' : 'HashAgg'} keys=[${keys}] aggs=[${aggs}]${n.having ? ' HAVING ' + E.exprToString(n.having) : ''}`;
        break;
      }
      default:
        head = n.op;
    }
    lines.push(pad + head);
    if (n.input) rec(n.input, pad + '  ');
    if (n.left) rec(n.left, pad + '  ');
    if (n.right) rec(n.right, pad + '  ');
  };
  rec(node, indent);
  return lines.join('\n');
}

module.exports = { buildPlan, colsOf, formatPlan };
