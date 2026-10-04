'use strict';

// Three-valued logic (SQL NULL semantics). `unknown` is represented as null.
const { E_TYPE } = require('./errors');

function checkBool(v, what) {
  if (v !== true && v !== false && v !== null && v !== undefined) {
    throw E_TYPE(`${what} requires a boolean operand, got ${typeof v}`);
  }
  return v === undefined ? null : v;
}

function tvAnd(a, b) {
  a = checkBool(a, 'AND');
  b = checkBool(b, 'AND');
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

function tvOr(a, b) {
  a = checkBool(a, 'OR');
  b = checkBool(b, 'OR');
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

function tvNot(a) {
  a = checkBool(a, 'NOT');
  return a === null ? null : !a;
}

const CMP_OPS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);

function compare(op, l, r) {
  if (l === null || l === undefined || r === null || r === undefined) return null;
  if (typeof l !== typeof r) {
    throw E_TYPE(`cannot compare ${typeof l} with ${typeof r} using ${op}`);
  }
  const t = typeof l;
  if (t !== 'number' && t !== 'string' && t !== 'boolean') {
    throw E_TYPE(`cannot compare values of type ${t}`);
  }
  if (t === 'boolean' && !(op === '=' || op === '<>' || op === '!=')) {
    throw E_TYPE(`operator ${op} is not supported for boolean values`);
  }
  switch (op) {
    case '=': return l === r;
    case '<>':
    case '!=': return l !== r;
    case '<': return l < r;
    case '<=': return l <= r;
    case '>': return l > r;
    case '>=': return l >= r;
  }
  throw E_TYPE(`unknown comparison operator ${op}`);
}

function arith(op, l, r) {
  if (l === null || l === undefined || r === null || r === undefined) return null;
  if (typeof l !== 'number' || typeof r !== 'number') {
    throw E_TYPE(`arithmetic ${op} requires numbers, got ${typeof l} and ${typeof r}`);
  }
  switch (op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? null : l / r;
  }
  throw E_TYPE(`unknown arithmetic operator ${op}`);
}

// Canonical, type-tagged encoding used for hashing rows deterministically.
function encVal(v) {
  if (v === null || v === undefined) return 'z';
  if (typeof v === 'number') return 'n:' + (Object.is(v, -0) ? 0 : v);
  if (typeof v === 'string') return 's:' + v;
  if (typeof v === 'boolean') return 'b:' + v;
  return 'j:' + JSON.stringify(v);
}

module.exports = { checkBool, tvAnd, tvOr, tvNot, compare, arith, encVal, CMP_OPS };
