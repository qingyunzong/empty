'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../lib/restate');

function layeredInput(layers) {
  return {
    items: [
      { id: 'cash', side: 'asset', domain: [-100, 100] },
      { id: 'ar', side: 'asset', domain: [-100, 100] },
      { id: 'ap', side: 'liability', domain: [-100, 100] },
      { id: 'equity', side: 'equity', domain: [-100, 100] },
    ],
    balances: { cash: 100, ar: 50, ap: 100, equity: 40 },
    periods: [{ id: 'P1', status: 'open' }],
    formulas: [{ id: 'bs', lhs: ['cash', 'ar'], rhs: ['ap', 'equity'] }],
    layers,
    budget: 100000,
  };
}

test('验收3: 下层发布失败后上层预留逐层冲回', () => {
  // 最小可行更正总额 |delta| = 10（资产 -5、负债权益 +5），L1 上限 4 必失败。
  const out = run(
    layeredInput([
      { id: 'L1', formulas: ['bs'], reserve: 10, maxAmount: 4 },
      { id: 'L2', formulas: ['bs'], reserve: 20 },
      { id: 'L3', formulas: ['bs'], reserve: 30 },
    ]),
  );
  assert.equal(out.status, 'ROLLED_BACK');
  assert.deepEqual(
    out.layers.map((l) => [l.id, l.status, l.reversal]),
    [
      ['L1', 'FAILED', 0],
      ['L2', 'ROLLED_BACK', 20],
      ['L3', 'ROLLED_BACK', 30],
    ],
  );
  assert.equal(out.reversals, 50, '冲回额 = 上层预留之和');
  assert.match(out.layers[0].reason, /上限/);
});

test('层上限恰好等于更正总额时全部发布', () => {
  const out = run(
    layeredInput([
      { id: 'L1', formulas: ['bs'], reserve: 10, maxAmount: 10 },
      { id: 'L2', formulas: ['bs'], reserve: 20 },
    ]),
  );
  assert.equal(out.status, 'OK');
  assert.deepEqual(out.layers.map((l) => l.status), ['PUBLISHED', 'PUBLISHED']);
  assert.equal(out.reversals, 0);
});

test('中间层失败时仅其上层被冲回，下层保持已发布', () => {
  const out = run(
    layeredInput([
      { id: 'L1', formulas: ['bs'], reserve: 5, maxAmount: 100 },
      { id: 'L2', formulas: ['bs'], reserve: 7, maxAmount: 2 },
      { id: 'L3', formulas: ['bs'], reserve: 9 },
    ]),
  );
  assert.equal(out.status, 'ROLLED_BACK');
  assert.deepEqual(
    out.layers.map((l) => [l.id, l.status, l.reversal]),
    [
      ['L1', 'PUBLISHED', 0],
      ['L2', 'FAILED', 0],
      ['L3', 'ROLLED_BACK', 9],
    ],
  );
  assert.equal(out.reversals, 9);
});
