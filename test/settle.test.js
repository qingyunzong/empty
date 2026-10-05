'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SettlementEngine } = require('../lib/engine');

test('验收1: 两对指令正常交收并冻结证券与资金', () => {
  const engine = new SettlementEngine({
    accounts: [
      { id: 'A1', cash: 10000 },
      { id: 'A2', securities: { SEC1: 100 } },
      { id: 'A3', cash: 2000 },
      { id: 'A4', securities: { SEC2: 200 } },
    ],
    instructions: [
      { id: 'B1', side: 'buy', security: 'SEC1', price: 10, quantity: 100 },
      { id: 'S1', side: 'sell', security: 'SEC1', price: 10, quantity: 100 },
      { id: 'B2', side: 'buy', security: 'SEC2', price: 5, quantity: 200 },
      { id: 'S2', side: 'sell', security: 'SEC2', price: 5, quantity: 200 },
    ],
    permissions: { B1: ['A1'], S1: ['A2'], B2: ['A3'], S2: ['A4'] },
  });
  const r = engine.settle();
  assert.equal(r.status, 'OK');
  assert.equal(r.pairs.length, 2);
  assert.equal(r.unmatched.length, 0);
  const p1 = r.pairs.find((p) => p.buy === 'B1');
  assert.deepEqual(
    { sell: p1.sell, buyAccount: p1.buyAccount, sellAccount: p1.sellAccount },
    { sell: 'S1', buyAccount: 'A1', sellAccount: 'A2' },
  );
  // 冻结：买方资金、卖方证券
  assert.equal(r.frozen.A1.cash, 1000);
  assert.equal(r.frozen.A2.securities.SEC1, 100);
  assert.equal(r.frozen.A3.cash, 1000);
  assert.equal(r.frozen.A4.securities.SEC2, 200);
  // 剩余可用
  assert.equal(r.remaining.A1.cash, 9000);
  assert.equal(r.remaining.A2.securities.SEC1, 0);
  assert.equal(r.remaining.A3.cash, 1000);
  assert.equal(r.remaining.A4.securities.SEC2, 0);
});

test('价格或数量不相等不得配对', () => {
  const engine = new SettlementEngine({
    accounts: [{ id: 'A1', cash: 100000 }, { id: 'A2', securities: { SEC1: 500 } }],
    instructions: [
      { id: 'B1', side: 'buy', security: 'SEC1', price: 10, quantity: 100 },
      { id: 'S1', side: 'sell', security: 'SEC1', price: 11, quantity: 100 },
      { id: 'S2', side: 'sell', security: 'SEC1', price: 10, quantity: 99 },
    ],
  });
  const r = engine.settle();
  assert.equal(r.status, 'OK');
  assert.equal(r.pairs.length, 0);
  assert.deepEqual(r.unmatched.sort(), ['B1', 'S1', 'S2']);
});
