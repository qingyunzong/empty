import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, parse, check, compile, run, CorpError } from '../src/index.js';

const lots = { cash: 0, lots: [{ id: 'L1', security: 'ACME', quantity: 100, acquired: '2024-01-01' }] };

test('lexer recognizes securities, ratios, ex-dates, versions, cash', () => {
  const toks = lex('action a1: ACME split 1/2 ex 2024-03-01 v2 # comment\n');
  const kinds = toks.map((t) => t.t);
  assert.deepEqual(kinds, ['IDENT', 'IDENT', ':', 'IDENT', 'IDENT', 'NUM', '/', 'NUM', 'IDENT', 'DATE', 'IDENT', 'EOF']);
  assert.equal(toks[9].v, '2024-03-01');
  const cashToks = lex('action d1: ACME dividend $0.50 ex 2024-03-01 v1');
  assert.equal(cashToks[5].t, 'CASH');
  assert.equal(cashToks[5].v, 0.5);
});

test('Pratt parser respects precedence and parentheses', () => {
  const [st] = parse(lex('action d1: ACME dividend $1 + $2 * 3 ex 2024-03-01 v1'));
  assert.equal(st.action.amount.kind, 'bin');
  assert.equal(st.action.amount.op, '+');
  assert.equal(st.action.amount.right.op, '*');
  const checked = check(parse(lex('action d1: ACME dividend ($1 + $2) * 3 ex 2024-03-01 v1')));
  assert.equal(checked[0].params.amount, 9);
});

test('fraction ratios evaluate through the Pratt parser', () => {
  const checked = check(parse(lex('action a1: ACME split 1/2 ex 2024-03-01 v1')));
  assert.equal(checked[0].params.ratio, 0.5);
});

// Acceptance 3: illegal ratios and cash/share mixing are static errors
test('split ratio > 1 is rejected statically (E_RATIO)', () => {
  assert.throws(() => compile('action a1: ACME split 2 ex 2024-03-01 v1'), (e) => e instanceof CorpError && e.code === 'E_RATIO');
  assert.throws(() => compile('action a1: ACME split 3/2 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
  assert.throws(() => compile('action a1: ACME split 0 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
});

test('cash used where a share ratio is expected (E_RATIO)', () => {
  assert.throws(() => compile('action a1: ACME split $2 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
  assert.throws(() => compile('sell ACME $10 on 2024-03-01'), (e) => e.code === 'E_RATIO');
});

test('share ratio used where cash is expected (E_RATIO)', () => {
  assert.throws(() => compile('action d1: ACME dividend 0.5 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
  assert.throws(() => compile('action t1: ACME tender 12 for 1/4 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
});

test('mixing cash and shares in one expression (E_RATIO)', () => {
  assert.throws(() => compile('action d1: ACME dividend $0.5 + 1 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
  assert.throws(() => compile('action d1: ACME dividend $0.5 - 1/4 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
  assert.throws(() => compile('action d1: ACME dividend $2 * $3 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
  assert.throws(() => compile('action a1: ACME split 1 / $2 ex 2024-03-01 v1'), (e) => e.code === 'E_RATIO');
});

test('invalid calendar dates (E_DATE)', () => {
  assert.throws(() => compile('action a1: ACME split 1/2 ex 2024-02-30 v1'), (e) => e.code === 'E_DATE');
  assert.throws(() => compile('action a1: ACME split 1/2 ex 2023-02-29 v1'), (e) => e.code === 'E_DATE');
  assert.throws(() => compile('action a1: ACME split 1/2 ex 2024-13-01 v1'), (e) => e.code === 'E_DATE');
  // 2024 is a leap year
  assert.doesNotThrow(() => compile('action a1: ACME split 1/2 ex 2024-02-29 v1'));
});

test('reversal lifecycle errors (E_REVERSE)', () => {
  assert.throws(() => run('reverse nope ex 2024-03-01 v1', lots), (e) => e.code === 'E_REVERSE');
  assert.throws(() => run('restated nope: ACME split 1/2 ex 2024-03-01 v2', lots), (e) => e.code === 'E_REVERSE');
  const doubleReverse = `
action a1: ACME split 1/2 ex 2024-03-01 v1
reverse a1 ex 2024-03-02 v2
reverse a1 ex 2024-03-03 v3`;
  assert.throws(() => run(doubleReverse, lots), (e) => e.code === 'E_REVERSE' && /status 'reversed'/.test(e.message));
  const dupId = `
action a1: ACME split 1/2 ex 2024-03-01 v1
action a1: ACME split 1/2 ex 2024-03-02 v2`;
  assert.throws(() => run(dupId, lots), (e) => e.code === 'E_REVERSE');
});

test('reversal before the action ex-date (E_DATE)', () => {
  const src = `
action a1: ACME split 1/2 ex 2024-03-10 v1
reverse a1 ex 2024-03-05 v2`;
  assert.throws(() => run(src, lots), (e) => e.code === 'E_DATE');
});

test('sell exceeding holdings (E_LOT)', () => {
  assert.throws(() => run('sell ACME 101 on 2024-02-01', lots), (e) => e.code === 'E_LOT');
});

test('malformed lots input (E_LOT / E_DATE)', () => {
  assert.throws(() => run('', { lots: [{ id: 'L1', security: 'ACME', quantity: -5, acquired: '2024-01-01' }] }), (e) => e.code === 'E_LOT');
  assert.throws(() => run('', { lots: [{ id: 'L1', security: 'ACME', quantity: 5, acquired: 'not-a-date' }] }), (e) => e.code === 'E_DATE');
  assert.throws(() => run('', { lots: [
    { id: 'L1', security: 'ACME', quantity: 5, acquired: '2024-01-01' },
    { id: 'L1', security: 'ACME', quantity: 5, acquired: '2024-01-02' },
  ] }), (e) => e.code === 'E_LOT');
});
