import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parseSpec } from '../src/parser.js';
import { checkSpec } from '../src/check.js';
import { checkHistory } from '../src/history.js';
import { compileExpr } from '../src/compile.js';
import { checkLinearizable } from '../src/linearize.js';
import { LimError } from '../src/errors.js';

test('lexer vocabulary covers account/order/reserve/confirm/release/clock', () => {
  const tokens = tokenize('account order reserve confirm release clock used quota capacity constraint amount strategy');
  const kws = tokens.filter(t => t.type === 'kw').map(t => t.value);
  assert.deepEqual(kws, ['account', 'order', 'reserve', 'confirm', 'release', 'clock',
    'used', 'quota', 'capacity', 'constraint', 'amount', 'strategy']);
});

test('lexer skips comments and tracks positions', () => {
  const tokens = tokenize('// hello\naccount /* mid */ A');
  assert.deepEqual(tokens.slice(0, 3).map(t => t.value), ['account', 'A', null]);
  assert.equal(tokens[0].line, 2);
});

test('pratt parser: * binds tighter than +, comparisons loosest', () => {
  const spec = parseSpec('account A { capacity 14 strategy s1 { quota 14 } constraint 2 + 3 * 4 <= capacity }');
  const c = spec.accounts[0].constraints[0];
  assert.equal(c.op, '<=');
  assert.equal(c.left.op, '+');
  assert.equal(c.left.right.op, '*');
});

test('pratt parser: comparisons are non-associative', () => {
  assert.throws(
    () => parseSpec('account A { capacity 1 strategy s { quota 1 } constraint 1 < 2 < 3 }'),
    /E_TYPE/);
});

test('pratt parser: unary minus and parentheses', () => {
  const spec = parseSpec('account A { capacity 10 strategy s { quota 10 } constraint -(used(s)) + 20 >= (1 + 1) * 5 }');
  assert.equal(spec.accounts[0].constraints[0].op, '>=');
});

test('compiled constraint bytecode evaluates with precedence', () => {
  // 2 + 3 * 4 = 14 <= capacity(14): reserve of 1 must succeed; if precedence
  // were wrong ((2+3)*4=20) it would fail.
  const spec = checkSpec(parseSpec('account A { capacity 14 strategy s1 { quota 14 } constraint 2 + 3 * 4 <= capacity }'));
  const ops = checkHistory(spec, [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 1, invoke: 0, response: 1, result: 'ok' },
  ]);
  const v = checkLinearizable(spec, ops, { max: 8 });
  assert.equal(v.status, 'OK');
});

test('scope: strategy sub-limits must not exceed account capacity', () => {
  assert.throws(
    () => checkSpec(parseSpec('account A { capacity 100 strategy s1 { quota 60 } strategy s2 { quota 50 } }')),
    (e) => e.code === 'E_TYPE' && /sum to 110 > capacity 100/.test(e.message));
});

test('type: confirm must reference an existing reserve', () => {
  const spec = checkSpec(parseSpec('account A { capacity 10 strategy s1 { quota 10 } }'));
  assert.throws(
    () => checkHistory(spec, [{ id: 'c1', kind: 'confirm', target: 'nope', invoke: 0, response: 1, result: 'ok' }]),
    (e) => e.code === 'E_TYPE');
});

test('type: duplicate confirm of the same reserve rejected', () => {
  const spec = checkSpec(parseSpec('account A { capacity 10 strategy s1 { quota 10 } }'));
  const history = [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 1, invoke: 0, response: 1, result: 'ok' },
    { id: 'c1', kind: 'confirm', target: 'r1', invoke: 2, response: 3, result: 'ok' },
    { id: 'c2', kind: 'confirm', target: 'r1', invoke: 4, response: 5, result: 'fail' },
  ];
  assert.throws(() => checkHistory(spec, history), (e) => e.code === 'E_TYPE');
});

test('type: constraint must be a boolean comparison over known identifiers', () => {
  assert.throws(
    () => checkSpec(parseSpec('account A { capacity 10 strategy s1 { quota 10 } constraint used(s1) + 1 }')),
    (e) => e.code === 'E_TYPE');
  assert.throws(
    () => checkSpec(parseSpec('account A { capacity 10 strategy s1 { quota 10 } constraint used(nope) <= 1 }')),
    (e) => e.code === 'E_TYPE');
  assert.throws(
    () => checkSpec(parseSpec('account A { capacity 10 strategy s1 { quota 10 } constraint whatever <= 1 }')),
    (e) => e.code === 'E_TYPE');
});

test('real-time order is respected: non-overlapping intervals fix the order', () => {
  const spec = checkSpec(parseSpec('account A { capacity 10 strategy s1 { quota 10 } }'));
  // r1 ends before r2 starts, both observed ok with amount 6+6 > 10:
  // impossible in the only legal order => not linearizable.
  const ops = checkHistory(spec, [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 0, response: 2, result: 'ok' },
    { id: 'r2', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 3, response: 5, result: 'ok' },
  ]);
  const v = checkLinearizable(spec, ops, { max: 8 });
  assert.equal(v.status, 'E_LINEAR');
  assert.deepEqual(v.orders, []);
});

test('logical clock constrains the sequential order', () => {
  const spec = checkSpec(parseSpec('account A { capacity 10 strategy s1 { quota 10 } }'));
  // Intervals overlap, but clocks force r2 before r1; r1 (amount 6) then fails,
  // contradicting its observed ok.
  const ops = checkHistory(spec, [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 0, response: 10, result: 'ok', clock: 5 },
    { id: 'r2', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 1, response: 9, result: 'ok', clock: 2 },
  ]);
  const v = checkLinearizable(spec, ops, { max: 8 });
  assert.equal(v.status, 'E_LINEAR');
});

test('order templates from the spec can be referenced by history ops', () => {
  const spec = checkSpec(parseSpec(`
    account A {
      capacity 100
      strategy s1 { quota 60 }
      order o1 { strategy s1 amount 30 clock 1 }
    }`));
  const ops = checkHistory(spec, [
    { id: 'r1', kind: 'reserve', order: 'o1', invoke: 0, response: 1, result: 'ok' },
  ]);
  assert.equal(ops[0].amount, 30);
  assert.equal(ops[0].strategy, 's1');
  assert.equal(ops[0].clock, 1);
  const v = checkLinearizable(spec, ops, { max: 8 });
  assert.equal(v.status, 'OK');
});

test('compileExpr rejects unknown nodes', () => {
  assert.throws(() => compileExpr({ type: 'wat' }), /cannot compile/);
});
