'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize } = require('../lib/model');
const { solve } = require('../lib/solver');
const { publish } = require('../lib/publish');

// Three layers, three required vouchers; L2 fails to publish so L3 (upper)
// must be rolled back and its reserved amounts charged back.
function layeredInput() {
  return {
    items: [
      { id: 'A1', side: 'asset', restatement: true },
      { id: 'L1', side: 'liability' },
      { id: 'E1', side: 'equity' },
    ],
    periods: [{ id: 'P1', status: 'open' }],
    balances: { A1: { P1: 100 }, L1: { P1: 60 }, E1: { P1: 40 } },
    domain: { values: [-20, -10, 10, 20] },
    formulas: [
      { id: 'F_BS', lhs: [{ side: 'asset' }], rhs: [{ side: 'liability' }, { side: 'equity' }] },
    ],
    vouchers: [
      { id: 'V1', layer: 'L1', required: true },
      { id: 'V2', layer: 'L2', required: true },
      { id: 'V3', layer: 'L3', required: true },
    ],
    layers: [
      { id: 'L1', publish: 'ok' },
      { id: 'L2', publish: 'fail' },
      { id: 'L3', publish: 'ok' },
    ],
  };
}

test('acceptance 3: lower layer failure cascades rollback of upper reservations', () => {
  const model = normalize(layeredInput());
  const r = solve(model);
  assert.equal(r.status, 'SOLVED');

  const pub = publish(model, r.entries);
  assert.deepEqual(
    pub.layers.map((l) => [l.id, l.status]),
    [
      ['L1', 'PUBLISHED'],
      ['L2', 'FAILED'],
      ['L3', 'ROLLED_BACK'],
    ]
  );

  const byVoucher = {};
  for (const e of r.entries) {
    byVoucher[e.voucher] = (byVoucher[e.voucher] || 0) + Math.abs(e.amount);
  }
  const l2 = pub.layers.find((l) => l.id === 'L2');
  const l3 = pub.layers.find((l) => l.id === 'L3');
  assert.equal(l2.reversal, byVoucher.V2);
  assert.ok(l2.reversal > 0);
  assert.equal(l3.reversal, byVoucher.V3);
  assert.ok(l3.reversal > 0, 'upper layer reservation must be charged back');
  assert.equal(pub.reversalTotal, l2.reversal + l3.reversal);

  // every required voucher keeps debit/credit pairing
  const nat = { asset: 1, liability: -1, equity: -1 };
  const sideOf = new Map(model.items.map((i) => [i.id, i.side]));
  const sums = {};
  const legs = {};
  for (const e of r.entries) {
    sums[e.voucher] = (sums[e.voucher] || 0) + e.amount * nat[sideOf.get(e.item)];
    legs[e.voucher] = (legs[e.voucher] || 0) + 1;
  }
  for (const v of model.vouchers) {
    assert.equal(sums[v.id] || 0, 0, `${v.id} unpaired`);
    assert.ok((legs[v.id] || 0) >= 2, `${v.id} needs paired legs`);
  }
});
