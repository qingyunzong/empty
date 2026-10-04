'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { audit, MAX_LINES } = require('../src/ledger');

const SKIP = '[^|]*';
const sep = '\\|';
const anyLine = [SKIP, SKIP, SKIP, SKIP, SKIP, SKIP].join(sep);

const rules = [
  { id: 'cny-credit', pattern: [SKIP, SKIP, 'CNY', SKIP, 'credit', SKIP].join(sep), decision: 'flag' },
  { id: 'usd-any', pattern: [SKIP, SKIP, 'USD', SKIP, SKIP, SKIP].join(sep), decision: 'pass' },
];

const rec = (over) => ({
  batch: 'B1',
  account: 'A001',
  currency: 'CNY',
  amount: 1,
  direction: 'credit',
  timestamp: '2026-10-01T08:00:00Z',
  ...over,
});
const line = (over) => JSON.stringify(rec(over));

test('acceptance A: valid rules hit and amounts sum correctly', () => {
  const ledger = [
    line({ batch: 'B1', account: 'A001', currency: 'CNY', amount: 100.5, direction: 'credit' }),
    line({ batch: 'B1', account: 'A002', currency: 'CNY', amount: 200.25, direction: 'credit' }),
    line({ batch: 'B1', account: 'A003', currency: 'CNY', amount: 999, direction: 'debit' }),
    line({ batch: 'B2', account: 'A004', currency: 'USD', amount: 50, direction: 'credit' }),
    line({ batch: 'B2', account: 'A005', currency: 'JPY', amount: 3000, direction: 'credit' }),
  ].join('\n') + '\n';

  const { match, summary } = audit(rules, ledger);
  assert.deepStrictEqual(match.map((m) => m.decision), ['flag', 'flag', 'none', 'pass', 'none']);
  assert.deepStrictEqual(match[0].matched, ['cny-credit']);
  assert.deepStrictEqual(match[3].matched, ['usd-any']);
  assert.deepStrictEqual(match[4].matched, []);
  assert.strictEqual(summary.lines, 5);
  assert.strictEqual(summary.flaggedCount, 2);
  assert.deepStrictEqual(summary.flaggedByCurrency, { CNY: 300.75 });
});

test('acceptance B: malformed and out-of-bounds lines report BAD_LINE', () => {
  const badLines = [
    '{not json',
    JSON.stringify({ batch: 'B1' }), // missing fields
    line({ amount: -5 }), // negative amount
    line({ amount: 1e13 }), // amount out of range
    line({ amount: '10' }), // amount not a number
    line({ direction: 'xfer' }), // unknown direction
    line({ currency: 'cny' }), // lowercase currency
    line({ currency: 'CNYD' }), // 4-letter currency
    line({ timestamp: 'not-a-time' }),
    line({ timestamp: '2026-13-01T08:00:00Z' }), // invalid month
    line({ batch: 'B|1' }), // separator inside field
    'x'.repeat(9000), // line too long
  ];
  for (const bad of badLines) {
    assert.throws(
      () => audit(rules, bad + '\n'),
      (err) => err.code === 'BAD_LINE',
      `expected BAD_LINE for ${bad.slice(0, 60)}`
    );
  }
});

test('acceptance B: more than 50000 lines reports BAD_LINE', () => {
  const big = (line() + '\n').repeat(MAX_LINES + 1);
  assert.throws(() => audit(rules, big), (err) => err.code === 'BAD_LINE');
});

test('acceptance B: invalid rule reports BAD_REGEX', () => {
  const bad = [{ id: 'bad', pattern: 'a+', decision: 'flag' }];
  assert.throws(() => audit(bad, line() + '\n'), (err) => err.code === 'BAD_REGEX');
  const noDecision = [{ id: 'bad', pattern: 'a*' }];
  assert.throws(() => audit(noDecision, line() + '\n'), (err) => err.code === 'BAD_REGEX');
});

test('conflicting rule decisions raise AMBIGUOUS_RULE instead of a silent non-match', () => {
  const conflicting = [
    { id: 'flag-cny', pattern: [SKIP, SKIP, 'CNY', SKIP, SKIP, SKIP].join(sep), decision: 'flag' },
    { id: 'pass-all', pattern: anyLine, decision: 'pass' },
  ];
  assert.throws(
    () => audit(conflicting, line({ currency: 'CNY' }) + '\n'),
    (err) => err.code === 'AMBIGUOUS_RULE'
  );
  // a line matched only by the pass rule is fine
  const { match } = audit(conflicting, line({ currency: 'USD' }) + '\n');
  assert.strictEqual(match[0].decision, 'pass');
});

test('rule longer than 80 characters reports BAD_REGEX', () => {
  const long = [{ id: 'long', pattern: 'a'.repeat(81), decision: 'flag' }];
  assert.throws(() => audit(long, line() + '\n'), (err) => err.code === 'BAD_REGEX');
});
