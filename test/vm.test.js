import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';
import { compile } from '../src/compiler.js';
import { VM } from '../src/vm.js';
import { money, dateVal, dateToDays } from '../src/money.js';

function runRule(src, ruleName, args, opts = {}) {
  const program = check(parse(tokenize(src)));
  const chunk = compile(program, src);
  const trace = [];
  const usedGlobals = new Set();
  const vm = new VM(chunk, { trace, usedGlobals });
  vm.init();
  const result = vm.callRule(ruleName, args);
  return { result, trace, usedGlobals, chunk };
}

const DAY = dateVal(dateToDays(2024, 6, 1));

test('money * rate rounds half-up to cents', () => {
  const src = 'rule fee(amount: money, day: date) -> money { amount * 0.5r }';
  assert.equal(runRule(src, 'fee', [money(5n), DAY]).result.v, 3n);   // 0.025 -> 0.03
  assert.equal(runRule(src, 'fee', [money(4n), DAY]).result.v, 2n);   // 0.020 -> 0.02
  assert.equal(runRule(src, 'fee', [money(1n), DAY]).result.v, 1n);   // 0.005 -> 0.01
  assert.equal(runRule(src, 'fee', [money(3n), DAY]).result.v, 2n);   // 0.015 -> 0.02
  assert.equal(runRule(src, 'fee', [money(2n), DAY]).result.v, 1n);   // 0.010 -> 0.01
});

test('if/else, comparison and logic operators execute', () => {
  const src = `
    rule f(amount: money, day: date) -> money {
      if amount > 100.00 and day >= 2024-01-01 { amount * 0.1r } else { amount * 0.2r }
    }
  `;
  assert.equal(runRule(src, 'f', [money(20000n), DAY]).result.v, 2000n);
  assert.equal(runRule(src, 'f', [money(20000n), dateVal(dateToDays(2023, 6, 1))]).result.v, 4000n);
  assert.equal(runRule(src, 'f', [money(5000n), DAY]).result.v, 1000n);
});

test('and/or short-circuit (no division by zero evaluated)', () => {
  const src = `
    rule f(amount: money, day: date) -> money {
      let z: rate = 0.001r - 0.001r
      let a: bool = amount > 0.00 or 1r / z > 0r
      let b: bool = amount < 0.00 and 1r / z > 0r
      if a and not b { amount } else { 0.00 }
    }
  `;
  assert.equal(runRule(src, 'f', [money(100n), DAY]).result.v, 100n);
});

test('rules call rules and trace records every invocation', () => {
  const src = `
    param fee_rate: rate = 0.0015r
    rule fee(amount: money, day: date) -> money { amount * fee_rate }
    rule net(amount: money, day: date) -> money { amount - fee(amount, day) }
  `;
  const { result, trace, usedGlobals } = runRule(src, 'net', [money(100000n), DAY], {});
  assert.equal(result.v, 99850n);
  assert.deepEqual(trace.map((t) => t.rule), ['fee', 'net']);
  assert.equal(trace[0].args[0], '1000.00');
  assert.ok(usedGlobals.has('fee_rate'));
});

test('negative computed rate raises E_RT at multiplication', () => {
  const src = `
    param r: rate = 0.01r - 0.02r
    rule fee(amount: money, day: date) -> money { amount * r }
  `;
  assert.throws(
    () => runRule(src, 'fee', [money(100n), DAY]),
    (err) => err.code === 'E_RT' && err.message.includes('negative rate'),
  );
});

test('division by zero raises E_RT with source position', () => {
  const src = 'rule f(amount: money, day: date) -> money { let x: rate = 1r / (0.01r - 0.01r) amount * x }';
  assert.throws(
    () => runRule(src, 'f', [money(100n), DAY]),
    (err) => err.code === 'E_RT' && err.message.includes('division by zero') && err.line === 1,
  );
});

test('calling an unknown rule raises E_RT', () => {
  const src = 'rule f(amount: money, day: date) -> money { amount }';
  assert.throws(() => runRule(src, 'nope', []), (err) => err.code === 'E_RT');
});
