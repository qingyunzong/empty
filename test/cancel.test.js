'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SettlementEngine } = require('../lib/engine');

function baseEngine() {
  return new SettlementEngine({
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
}

test('验收2: 撤单先解冻再拆配对，随后增量重配', () => {
  const engine = baseEngine();
  const r1 = engine.settle();
  assert.equal(r1.pairs.length, 2);
  const keptPairId = r1.pairs.find((p) => p.buy === 'B1').id;

  // 撤单 S2：先解冻（A3 资金、A4 证券恢复），再拆配对
  engine.cancel(['S2']);
  assert.equal(engine.pairs.length, 1);
  assert.equal(engine.ledger.get('A3').cash, 2000);
  assert.equal(engine.ledger.get('A4').securities.SEC2, 200);
  // 未撤的配对冻结保持不变
  assert.equal(engine.ledger.get('A1').cash, 9000);
  assert.equal(engine.ledger.get('A2').securities.SEC1, 0);

  // 新卖方指令进入，增量重配：保留 B1-S1，仅撮合 B2-S3
  engine.addInstructions(
    [{ id: 'S3', side: 'sell', security: 'SEC2', price: 5, quantity: 200 }],
    { S3: ['A4'] },
  );
  const r2 = engine.rematch();
  assert.equal(r2.status, 'OK');
  assert.equal(r2.pairs.length, 2);
  const kept = r2.pairs.find((p) => p.buy === 'B1');
  assert.equal(kept.id, keptPairId); // 既有配对未被重排
  assert.equal(kept.sell, 'S1');
  const added = r2.pairs.find((p) => p.buy === 'B2');
  assert.equal(added.sell, 'S3');
  assert.notEqual(added.id, keptPairId);
  assert.equal(r2.frozen.A3.cash, 1000);
  assert.equal(r2.frozen.A4.securities.SEC2, 200);
});
