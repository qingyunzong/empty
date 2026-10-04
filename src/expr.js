'use strict';

// Expression trees: plain data so plans serialize to JSON losslessly.
// Node shapes:
//   {t:'lit', value}
//   {t:'col', table, name, ref}        ref = 'alias.name' after resolution
//   {t:'bin', op, l, r}                op in AND/OR/comparisons/+ - * /
//   {t:'not', e}
//   {t:'neg', e}
//   {t:'isnull', e, negated}
//   {t:'agg', func, arg, idx}          arg null for COUNT(*); idx assigned by planner
const { E_PARSE, E_TYPE } = require('./errors');
const V = require('./values');

function resolveExpr(e, scope) {
  switch (e.t) {
    case 'col': {
      const cands = [];
      for (const s of scope) {
        if (e.table && e.table !== s.alias) continue;
        if (s.columns.includes(e.name)) cands.push(s.alias);
      }
      if (cands.length === 0) {
        throw E_PARSE(`unknown column: ${e.table ? e.table + '.' : ''}${e.name}`);
      }
      if (cands.length > 1) throw E_PARSE(`ambiguous column: ${e.name}`);
      e.ref = cands[0] + '.' + e.name;
      return e;
    }
    case 'lit':
      return e;
    case 'bin':
      resolveExpr(e.l, scope);
      resolveExpr(e.r, scope);
      return e;
    case 'not':
    case 'neg':
    case 'isnull':
      resolveExpr(e.e, scope);
      return e;
    case 'agg':
      if (e.arg) resolveExpr(e.arg, scope);
      return e;
  }
  throw E_PARSE(`bad expression node: ${e && e.t}`);
}

function evalExpr(e, row, aggs) {
  switch (e.t) {
    case 'lit':
      return e.value;
    case 'col': {
      const v = row[e.ref];
      return v === undefined ? null : v;
    }
    case 'bin': {
      if (e.op === 'AND') return V.tvAnd(evalExpr(e.l, row, aggs), evalExpr(e.r, row, aggs));
      if (e.op === 'OR') return V.tvOr(evalExpr(e.l, row, aggs), evalExpr(e.r, row, aggs));
      if (V.CMP_OPS.has(e.op)) {
        return V.compare(e.op, evalExpr(e.l, row, aggs), evalExpr(e.r, row, aggs));
      }
      return V.arith(e.op, evalExpr(e.l, row, aggs), evalExpr(e.r, row, aggs));
    }
    case 'not':
      return V.tvNot(evalExpr(e.e, row, aggs));
    case 'neg': {
      const v = evalExpr(e.e, row, aggs);
      if (v === null || v === undefined) return null;
      if (typeof v !== 'number') throw E_TYPE('unary minus requires a number');
      return -v;
    }
    case 'isnull': {
      const v = evalExpr(e.e, row, aggs);
      const r = v === null || v === undefined;
      return e.negated ? !r : r;
    }
    case 'agg':
      return aggs[e.idx];
  }
  throw E_PARSE(`cannot evaluate node: ${e && e.t}`);
}

function refs(e, acc = new Set()) {
  switch (e.t) {
    case 'col':
      acc.add(e.ref);
      break;
    case 'bin':
      refs(e.l, acc);
      refs(e.r, acc);
      break;
    case 'not':
    case 'neg':
    case 'isnull':
      refs(e.e, acc);
      break;
    case 'agg':
      if (e.arg) refs(e.arg, acc);
      break;
  }
  return acc;
}

function refsOutsideAggs(e, acc = new Set()) {
  switch (e.t) {
    case 'col':
      acc.add(e.ref);
      break;
    case 'agg':
      break;
    case 'bin':
      refsOutsideAggs(e.l, acc);
      refsOutsideAggs(e.r, acc);
      break;
    case 'not':
    case 'neg':
    case 'isnull':
      refsOutsideAggs(e.e, acc);
      break;
  }
  return acc;
}

function findAggs(e, acc = []) {
  if (e.t === 'agg') {
    acc.push(e);
    return acc;
  }
  if (e.t === 'bin') {
    findAggs(e.l, acc);
    findAggs(e.r, acc);
  } else if (e.t === 'not' || e.t === 'neg' || e.t === 'isnull') {
    findAggs(e.e, acc);
  }
  return acc;
}

function hasAgg(e) {
  return findAggs(e).length > 0;
}

function splitAnd(e) {
  if (e.t === 'bin' && e.op === 'AND') return [...splitAnd(e.l), ...splitAnd(e.r)];
  return [e];
}

function andAll(list) {
  if (list.length === 1) return list[0];
  return list.slice(1).reduce((acc, e) => ({ t: 'bin', op: 'AND', l: acc, r: e }), list[0]);
}

function exprKey(e) {
  switch (e.t) {
    case 'lit':
      return 'lit:' + V.encVal(e.value);
    case 'col':
      return 'col:' + e.ref;
    case 'bin':
      return `bin:${e.op}(${exprKey(e.l)},${exprKey(e.r)})`;
    case 'not':
      return `not(${exprKey(e.e)})`;
    case 'neg':
      return `neg(${exprKey(e.e)})`;
    case 'isnull':
      return `isnull:${e.negated ? 1 : 0}(${exprKey(e.e)})`;
    case 'agg':
      return `agg:${e.func}(${e.arg ? exprKey(e.arg) : '*'})`;
  }
  return 'unknown';
}

function exprToString(e) {
  switch (e.t) {
    case 'lit':
      return e.value === null ? 'NULL' : JSON.stringify(e.value);
    case 'col':
      return e.ref || (e.table ? e.table + '.' : '') + e.name;
    case 'bin':
      return `(${exprToString(e.l)} ${e.op} ${exprToString(e.r)})`;
    case 'not':
      return `(NOT ${exprToString(e.e)})`;
    case 'neg':
      return `(-${exprToString(e.e)})`;
    case 'isnull':
      return `(${exprToString(e.e)} IS ${e.negated ? 'NOT ' : ''}NULL)`;
    case 'agg':
      return `${e.func}(${e.arg ? exprToString(e.arg) : '*'})`;
  }
  return '?';
}

module.exports = {
  resolveExpr,
  evalExpr,
  refs,
  refsOutsideAggs,
  findAggs,
  hasAgg,
  splitAnd,
  andAll,
  exprKey,
  exprToString,
};
