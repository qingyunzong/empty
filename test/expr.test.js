import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateExpr, hashExpr } from '../src/expr.js';
import { GateError } from '../src/errors.js';

const noWindow = () => null;

test('three-valued logic: AND/OR/NOT with NULL', () => {
  const T = { lit: true };
  const F = { lit: false };
  const N = { lit: null };
  assert.equal(evaluate({ and: [T, N] }, {}, noWindow), null);
  assert.equal(evaluate({ and: [F, N] }, {}, noWindow), false);
  assert.equal(evaluate({ and: [T, T] }, {}, noWindow), true);
  assert.equal(evaluate({ or: [F, N] }, {}, noWindow), null);
  assert.equal(evaluate({ or: [T, N] }, {}, noWindow), true);
  assert.equal(evaluate({ or: [F, F] }, {}, noWindow), false);
  assert.equal(evaluate({ not: N }, {}, noWindow), null);
  assert.equal(evaluate({ not: T }, {}, noWindow), false);
});

test('comparisons propagate NULL and reject mixed types', () => {
  assert.equal(evaluate({ cmp: 'gt', left: { ref: 'missing' }, right: { lit: 1 } }, {}, noWindow), null);
  assert.equal(evaluate({ cmp: 'eq', left: { lit: null }, right: { lit: null } }, {}, noWindow), null);
  assert.equal(evaluate({ cmp: 'lt', left: { lit: 'a' }, right: { lit: 1 } }, {}, noWindow), null);
  assert.equal(evaluate({ cmp: 'ge', left: { lit: 5 }, right: { lit: 5 } }, {}, noWindow), true);
  assert.equal(evaluate({ cmp: 'ne', left: { lit: 'x' }, right: { lit: 'y' } }, {}, noWindow), true);
});

test('arithmetic: NULL propagation and division by zero', () => {
  assert.equal(evaluate({ add: [{ lit: 1 }, { lit: 2 }, { lit: 3 }] }, {}, noWindow), 6);
  assert.equal(evaluate({ sub: [{ lit: 10 }, { lit: 3 }] }, {}, noWindow), 7);
  assert.equal(evaluate({ mul: [{ lit: 2 }, { ref: 'x' }] }, { x: 4 }, noWindow), 8);
  assert.equal(evaluate({ div: [{ lit: 1 }, { lit: 0 }] }, {}, noWindow), null);
  assert.equal(evaluate({ add: [{ lit: 1 }, { ref: 'nope' }] }, {}, noWindow), null);
  assert.equal(evaluate({ isnull: { ref: 'nope' } }, {}, noWindow), true);
  assert.equal(evaluate({ isnull: { lit: 0 } }, {}, noWindow), false);
});

test('AST hash is stable under key reordering and sensitive to semantics', () => {
  const a = { cmp: 'eq', left: { lit: 1 }, right: { ref: 'x' } };
  const b = { right: { ref: 'x' }, left: { lit: 1 }, cmp: 'eq' };
  const c = { cmp: 'ne', left: { lit: 1 }, right: { ref: 'x' } };
  assert.equal(hashExpr(a), hashExpr(b));
  assert.notEqual(hashExpr(a), hashExpr(c));
  assert.match(hashExpr(a), /^[0-9a-f]{16}$/);
});

test('validation: E_RULE for malformed expressions, E_WINDOW for bad windows', () => {
  assert.throws(() => validateExpr({ and: [] }), (e) => e instanceof GateError && e.code === 'E_RULE');
  assert.throws(() => validateExpr({ cmp: 'between', left: { lit: 1 }, right: { lit: 2 } }), (e) => e.code === 'E_RULE');
  assert.throws(() => validateExpr({ ref: '' }), (e) => e.code === 'E_RULE');
  assert.throws(
    () => validateExpr({ agg: 'avg', window: { size: 0 }, expr: { ref: 'v' } }),
    (e) => e.code === 'E_WINDOW',
  );
  assert.throws(
    () => validateExpr({ agg: 'avg', window: { size: 100, bounds: 'sideways' }, expr: { ref: 'v' } }),
    (e) => e.code === 'E_WINDOW',
  );
  assert.throws(
    () => validateExpr({ agg: 'median', window: { size: 100 }, expr: { ref: 'v' } }),
    (e) => e.code === 'E_RULE',
  );
});
