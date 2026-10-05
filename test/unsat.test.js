'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SettlementEngine } = require('../lib/engine');

test('验收4a: 单指令余额不足 -> UNSAT，环为自身', () => {
  const engine = new SettlementEngine({
    accounts: [
      { id: 'A1', cash: 500 },
      { id: 'A2', securities: { SEC1: 100 } },
    ],
    instructions: [
      { id: 'B1', side: 'buy', security: 'SEC1', price: 10, quantity: 100 },
      { id: 'S1', side: 'sell', security: 'SEC1', price: 10, quantity: 100 },
    ],
    permissions: { B1: ['A1'], S1: ['A2'] },
  });
  const r = engine.settle();
  assert.equal(r.status, 'UNSAT');
  assert.deepEqual(r.conflict.cycle, ['B1']);
  assert.match(r.conflict.explanation, /B1/);
});

test('验收4b: 多指令竞争同一账户资金 -> UNSAT，给出最短指令环', () => {
  const engine = new SettlementEngine({
    accounts: [
      { id: 'A1', cash: 1000 },
      { id: 'A2', securities: { SEC1: 100 } },
      { id: 'A3', securities: { SEC2: 100 } },
    ],
    instructions: [
      { id: 'B1', side: 'buy', security: 'SEC1', price: 8, quantity: 100 },
      { id: 'S1', side: 'sell', security: 'SEC1', price: 8, quantity: 100 },
      { id: 'B2', side: 'buy', security: 'SEC2', price: 8, quantity: 100 },
      { id: 'S2', side: 'sell', security: 'SEC2', price: 8, quantity: 100 },
    ],
    permissions: { B1: ['A1'], S1: ['A2'], B2: ['A1'], S2: ['A3'] },
  });
  const r = engine.settle();
  assert.equal(r.status, 'UNSAT');
  // A1 仅有 1000 现金，B1/B2 各需 800，只能成交一对
  assert.equal(r.pairs.length, 1);
  assert.equal(r.conflict.cycle.length, 2); // 最短环：两个买方指令互相竞争
  assert.deepEqual(new Set(r.conflict.cycle), new Set(['B1', 'B2']));
});
