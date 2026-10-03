import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { RevError } from '../src/errors.js';

const types = (src) => lex(src).map((t) => t.type);

test('lexes txn refs, accounts, amounts and status keywords', () => {
  const tokens = lex('reverse txn:1001; move 12.50 from acc:revenue.fees to acc:cash.operating; # SETTLED');
  const txn = tokens.find((t) => t.type === 'txn');
  assert.equal(txn.value, '1001');
  const money = tokens.find((t) => t.type === 'number');
  assert.deepEqual([money.value, money.isMoney], [1250, true]);
  const accounts = tokens.filter((t) => t.type === 'account').map((t) => t.value);
  assert.deepEqual(accounts, ['revenue.fees', 'cash.operating']);
});

test('status keywords lex as status tokens', () => {
  assert.deepEqual(types('SETTLED PENDING CANCEL_REQUESTED REVERSED FAILED LOCKED'),
    ['status', 'status', 'status', 'status', 'status', 'status', 'eof']);
});

test('integer literals stay ints, decimals become money cents', () => {
  const [i, m] = lex('7 0.05');
  assert.deepEqual([i.value, i.isMoney], [7, false]);
  assert.deepEqual([m.value, m.isMoney], [5, true]);
});

test('rejects unknown words and bad characters with E_PARSE', () => {
  assert.throws(() => lex('Foo'), (e) => e instanceof RevError && e.code === 'E_PARSE');
  assert.throws(() => lex('@'), (e) => e.code === 'E_PARSE');
  assert.throws(() => lex('1.234'), (e) => e.code === 'E_PARSE');
});
