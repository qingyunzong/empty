'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { tmpdir, fullRecompute } = require('./helpers');

// 验收 1：逐层全量计算不超过 10 层状态并比对。
// 每提交一层，都从头全量重放（不用索引/检查点快照），
// 与 restore（检查点 + 增量）以及逐层目标恢复逐一比对。
test('逐层全量计算与检查点增量恢复比对（不超过10层）', () => {
  const dir = tmpdir();
  Store.init(dir, {
    alice: { budget: 1000, credit: 1000, balance: 1000 },
    bob: { budget: 500, credit: 500, balance: 500 },
  });
  const store = Store.open(dir);
  // genesis 第 0 层 + 9 层 = 共 10 层
  const ops = [
    ['reserve', [{ id: 'r1', kind: 'reserve', account: 'alice', amount: 200 }]],
    ['reserve', [{ id: 'r2', kind: 'reserve', account: 'bob', amount: 300 }]],
    ['freeze', [{ id: 'f1', kind: 'freeze', account: 'alice', amount: 150, parent: 'r1' }]],
    ['pay', [{ id: 'p1', kind: 'pay', account: 'alice', amount: 100, parent: 'f1' }]],
    ['checkpoint', null],
    ['freeze', [{ id: 'f2', kind: 'freeze', account: 'bob', amount: 120, parent: 'r2' }]],
    ['pay', [{ id: 'p2', kind: 'pay', account: 'bob', amount: 120, parent: 'f2' }]],
    ['revert', [{ id: 'rv1', kind: 'revert', target: 'p2' }]],
    ['revert', [{ id: 'rv2', kind: 'revert', target: 'f2' }]],
  ];
  for (const [kind, txs] of ops) {
    if (kind === 'checkpoint') store.checkpoint();
    else store.commitLayer(kind, txs);
    // 全量重放 vs 检查点增量恢复
    const full = fullRecompute(dir);
    const restored = store.restore({});
    assert.deepEqual(restored.state, full.state, `state mismatch after ${kind}`);
    // 逐层：每个目标层都全量重放并比对
    const head = store.readIndex().head.layer;
    assert.ok(head <= 9, 'layer count must stay within 10');
    for (let layer = 0; layer <= head; layer++) {
      const byLayer = store.restore({ targetLayer: layer });
      const fullByLayer = fullRecompute(dir, layer);
      assert.deepEqual(byLayer.state, fullByLayer.state, `state mismatch at layer ${layer}`);
      assert.equal(byLayer.layer, layer);
    }
  }
  // 资金池终态检查
  const final = store.restore({}).state;
  assert.equal(final.accounts.alice.budget, 800);
  assert.equal(final.accounts.alice.credit, 850);
  assert.equal(final.accounts.alice.balance, 900);
  assert.equal(final.accounts.bob.budget, 200);
  assert.equal(final.accounts.bob.credit, 500);
  assert.equal(final.accounts.bob.balance, 500);
  assert.equal(final.txs.p2.reverted, true);
  assert.equal(final.txs.f2.reverted, true);
});
