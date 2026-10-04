import { createHash } from 'node:crypto';
import { GateError } from './errors.js';

export const AGG_FNS = new Set(['avg', 'sum', 'min', 'max', 'count']);
export const CMP_OPS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
export const WINDOW_BOUNDS = new Set(['left-open', 'closed']);

const OP_KEYS = ['lit', 'ref', 'add', 'sub', 'mul', 'div', 'cmp', 'and', 'or', 'not', 'isnull', 'agg'];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function hashExpr(expr) {
  return createHash('sha256').update(canonical(expr)).digest('hex').slice(0, 16);
}

function failRule(path, msg) {
  throw new GateError('E_RULE', `${path}: ${msg}`);
}

export function validateWindow(window, path) {
  if (window === null || typeof window !== 'object' || Array.isArray(window)) {
    throw new GateError('E_WINDOW', `${path}.window: must be an object`);
  }
  const { size, bounds } = window;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    throw new GateError('E_WINDOW', `${path}.window.size: must be a positive finite number (ms)`);
  }
  if (bounds !== undefined && !WINDOW_BOUNDS.has(bounds)) {
    throw new GateError('E_WINDOW', `${path}.window.bounds: must be one of ${[...WINDOW_BOUNDS].join(', ')}`);
  }
}

export function validateExpr(node, path = '$') {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    failRule(path, 'expression node must be a plain object');
  }
  const keys = Object.keys(node);
  const ops = keys.filter((k) => OP_KEYS.includes(k));
  const unknown = keys.filter((k) => !OP_KEYS.includes(k) && !['left', 'right', 'window', 'expr'].includes(k));
  if (ops.length !== 1) failRule(path, `exactly one operator key required, found ${ops.length}`);
  if (unknown.length > 0) failRule(path, `unknown keys: ${unknown.join(', ')}`);

  if ('lit' in node) return;
  if ('ref' in node) {
    if (typeof node.ref !== 'string' || node.ref.length === 0) failRule(path, 'ref must be a non-empty string');
    return;
  }
  for (const op of ['add', 'sub', 'mul']) {
    if (op in node) {
      if (!Array.isArray(node[op]) || node[op].length < 1) failRule(path, `${op} requires a non-empty array`);
      node[op].forEach((e, i) => validateExpr(e, `${path}.${op}[${i}]`));
      return;
    }
  }
  if ('div' in node) {
    if (!Array.isArray(node.div) || node.div.length !== 2) failRule(path, 'div requires exactly 2 operands');
    node.div.forEach((e, i) => validateExpr(e, `${path}.div[${i}]`));
    return;
  }
  if ('cmp' in node) {
    if (!CMP_OPS.has(node.cmp)) failRule(path, `cmp must be one of ${[...CMP_OPS].join(', ')}`);
    if (!('left' in node) || !('right' in node)) failRule(path, 'cmp requires left and right');
    validateExpr(node.left, `${path}.left`);
    validateExpr(node.right, `${path}.right`);
    return;
  }
  for (const op of ['and', 'or']) {
    if (op in node) {
      if (!Array.isArray(node[op]) || node[op].length < 1) failRule(path, `${op} requires a non-empty array`);
      node[op].forEach((e, i) => validateExpr(e, `${path}.${op}[${i}]`));
      return;
    }
  }
  if ('not' in node) { validateExpr(node.not, `${path}.not`); return; }
  if ('isnull' in node) { validateExpr(node.isnull, `${path}.isnull`); return; }
  if ('agg' in node) {
    if (!AGG_FNS.has(node.agg)) failRule(path, `agg must be one of ${[...AGG_FNS].join(', ')}`);
    validateWindow(node.window, path);
    if (!('expr' in node)) failRule(path, 'agg requires expr');
    validateExpr(node.expr, `${path}.expr`);
    return;
  }
}

const isNullish = (v) => v === null || v === undefined;

function tvlNot(v) {
  if (isNullish(v)) return null;
  return !v;
}

function tvlAnd(values) {
  let sawNull = false;
  for (const v of values) {
    if (v === false) return false;
    if (isNullish(v)) sawNull = true;
  }
  return sawNull ? null : true;
}

function tvlOr(values) {
  let sawNull = false;
  for (const v of values) {
    if (v === true) return true;
    if (isNullish(v)) sawNull = true;
  }
  return sawNull ? null : false;
}

function compare(op, left, right) {
  if (isNullish(left) || isNullish(right)) return null;
  if (typeof left !== typeof right) return null;
  switch (op) {
    case 'eq': return left === right;
    case 'ne': return left !== right;
    case 'lt': return typeof left === 'number' || typeof left === 'string' ? left < right : null;
    case 'le': return typeof left === 'number' || typeof left === 'string' ? left <= right : null;
    case 'gt': return typeof left === 'number' || typeof left === 'string' ? left > right : null;
    case 'ge': return typeof left === 'number' || typeof left === 'string' ? left >= right : null;
    default: return null;
  }
}

function arith(op, values) {
  for (const v of values) {
    if (typeof v !== 'number' || Number.isNaN(v)) return null;
  }
  switch (op) {
    case 'add': return values.reduce((a, b) => a + b, 0);
    case 'mul': return values.reduce((a, b) => a * b, 1);
    case 'sub': return values.length === 1 ? -values[0] : values.slice(1).reduce((a, b) => a - b, values[0]);
    case 'div': return values[1] === 0 ? null : values[0] / values[1];
    default: return null;
  }
}

// evalWindow(aggNode) -> aggregate value (or null). Provided by the engine so
// windowed aggregates resolve against the observation store, not the evaluator.
export function evaluate(node, fields, evalWindow) {
  if ('lit' in node) return node.lit === undefined ? null : node.lit;
  if ('ref' in node) {
    const v = fields[node.ref];
    return v === undefined ? null : v;
  }
  if ('add' in node) return arith('add', node.add.map((e) => evaluate(e, fields, evalWindow)));
  if ('sub' in node) return arith('sub', node.sub.map((e) => evaluate(e, fields, evalWindow)));
  if ('mul' in node) return arith('mul', node.mul.map((e) => evaluate(e, fields, evalWindow)));
  if ('div' in node) return arith('div', node.div.map((e) => evaluate(e, fields, evalWindow)));
  if ('cmp' in node) return compare(node.cmp, evaluate(node.left, fields, evalWindow), evaluate(node.right, fields, evalWindow));
  if ('and' in node) return tvlAnd(node.and.map((e) => evaluate(e, fields, evalWindow)));
  if ('or' in node) return tvlOr(node.or.map((e) => evaluate(e, fields, evalWindow)));
  if ('not' in node) return tvlNot(evaluate(node.not, fields, evalWindow));
  if ('isnull' in node) return isNullish(evaluate(node.isnull, fields, evalWindow));
  if ('agg' in node) return evalWindow(node);
  throw new GateError('E_RULE', 'unevaluable expression node');
}
