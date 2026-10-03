import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { StlError } from '../src/errors.js';

const types = (src) => tokenize(src).map((t) => t.type);

test('lexes identifiers, keywords and punctuation', () => {
  assert.deepEqual(types('let fee_rate: rate = 0.06r'), ['let', 'ident', ':', 'rate', '=', 'rate', 'eof']);
  assert.deepEqual(types('rule f(a: money) -> money { a }'), [
    'rule', 'ident', '(', 'ident', ':', 'money', ')', '->', 'money', '{', 'ident', '}', 'eof',
  ]);
});

test('money literals carry integer cents, max 2 decimals', () => {
  const [tok] = tokenize('12.34');
  assert.equal(tok.type, 'money');
  assert.equal(tok.value, 1234n);
  assert.equal(tokenize('7')[0].value, 700n);
  assert.equal(tokenize('0.05')[0].value, 5n);
});

test('rate literals carry micro units, max 6 decimals', () => {
  const [tok] = tokenize('0.0015r');
  assert.equal(tok.type, 'rate');
  assert.equal(tok.value, 1500n);
  assert.equal(tokenize('2r')[0].value, 2000000n);
});

test('date literals become epoch days', () => {
  const [tok] = tokenize('2024-01-15');
  assert.equal(tok.type, 'date');
  assert.equal(typeof tok.value, 'number');
  assert.equal(tokenize('1970-01-01')[0].value, 0);
});

test('comments (# and //) are skipped', () => {
  assert.deepEqual(types('# hello\nlet // trailing\nx'), ['let', 'ident', 'eof']);
});

test('rejects money with 3 decimals (1.005) as E_LEX with position', () => {
  assert.throws(
    () => tokenize('let x: money = 1.005'),
    (err) => err instanceof StlError && err.code === 'E_LEX' && err.line === 1 && err.col === 16,
  );
});

test('rejects scientific notation as E_LEX', () => {
  assert.throws(() => tokenize('1e5'), (err) => err.code === 'E_LEX');
  assert.throws(() => tokenize('1.5E2'), (err) => err.code === 'E_LEX');
});

test('rejects rate with 7 decimals and invalid dates as E_LEX', () => {
  assert.throws(() => tokenize('0.1234567r'), (err) => err.code === 'E_LEX');
  assert.throws(() => tokenize('2024-02-30'), (err) => err.code === 'E_LEX');
  assert.throws(() => tokenize('2024-13-01'), (err) => err.code === 'E_LEX');
});

test('rejects unexpected characters as E_LEX', () => {
  assert.throws(() => tokenize('@'), (err) => err.code === 'E_LEX' && err.line === 1 && err.col === 1);
  assert.throws(() => tokenize('.5'), (err) => err.code === 'E_LEX');
});
