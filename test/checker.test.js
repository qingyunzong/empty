import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';

const checkSrc = (src) => check(parse(tokenize(src)));
const expectError = (src, code, messagePart) => {
  assert.throws(
    () => checkSrc(src),
    (err) => err.code === code
      && (messagePart === undefined || err.message.includes(messagePart))
      && typeof err.line === 'number'
      && typeof err.col === 'number',
  );
};

test('rejects implicit conversion between money and rate (E_TYPE)', () => {
  expectError('let x: money = 1.00 + 0.06r', 'E_TYPE', 'no implicit conversion');
  expectError('let x: rate = 1.00', 'E_TYPE', 'declared as rate');
  expectError('let b: bool = 1.00 < 0.06r', 'E_TYPE', 'cannot compare');
});

test('rejects negative rate literals (E_TYPE)', () => {
  expectError('param vat_rate: rate = -0.06r', 'E_TYPE', 'negative rate');
});

test('rejects duplicate let in the same scope (E_SCOPE)', () => {
  expectError('let x: money = 1.00\nlet x: money = 2.00', 'E_SCOPE', 'duplicate');
  expectError(
    'rule f(a: money) -> money { let x: money = 1.00 let x: money = 2.00 x }',
    'E_SCOPE', 'duplicate',
  );
});

test('rejects unbound variables (E_SCOPE)', () => {
  expectError('let x: money = y + 1.00', 'E_SCOPE', 'unbound variable');
  expectError('rule f(a: money) -> money { a + missing }', 'E_SCOPE', 'unbound variable');
});

test('rule parameters shadow globals', () => {
  const src = `
    let ratio: money = 1.00
    rule f(ratio: rate) -> money { 10.00 * ratio }
  `;
  assert.doesNotThrow(() => checkSrc(src));
});

test('let in an inner block may shadow an outer name', () => {
  const src = `
    rule f(a: money) -> money {
      let x: money = 1.00
      if a > 0.00 { let x: money = 2.00 x } else { x }
    }
  `;
  assert.doesNotThrow(() => checkSrc(src));
});

test('checks rule call arity and argument types', () => {
  expectError(`
    rule f(a: money) -> money { a }
    rule g(a: money) -> money { f(a, a) }
  `, 'E_TYPE', 'expects 1 argument');
  expectError(`
    rule f(a: money) -> money { a }
    rule g(a: money) -> money { f(0.06r) }
  `, 'E_TYPE', 'must be money');
});

test('checks rule return type and if branch agreement', () => {
  expectError('rule f(a: money) -> rate { a }', 'E_TYPE', 'returns rate');
  expectError('rule f(a: money) -> money { if a > 0.00 { a } else { 0.06r } }', 'E_TYPE', 'different types');
  expectError('rule f(a: money) -> money { if a { a } else { a } }', 'E_TYPE', 'must be bool');
});

test('accepts a well-typed program', () => {
  const src = `
    param fee_rate: rate = 0.0015r
    rule fee(amount: money, day: date) -> money { amount * fee_rate }
    rule net(amount: money, day: date) -> money {
      if day >= 2024-01-01 and amount > 0.00 { amount - fee(amount, day) } else { amount }
    }
  `;
  assert.doesNotThrow(() => checkSrc(src));
});
