'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store');
const { CorruptionError, IndexCorruptionError } = require('../src/errors');
const { tmpdir, corruptLayerPayload } = require('./helpers');

function buildStore(dir) {
  Store.init(dir, { alice: { budget: 1000, credit: 1000, balance: 1000 } });
  const store = Store.open(dir);
  store.commitLayer('reserve', [{ id: 'r1', kind: 'reserve', account: 'alice', amount: 100 }]); // 1
  store.commitLayer('reserve', [{ id: 'r2', kind: 'reserve', account: 'alice', amount: 200 }]); // 2
  store.commitLayer('freeze', [{ id: 'f1', kind: 'freeze', account: 'alice', amount: 80, parent: 'r1' }]); // 3
  store.checkpoint(); // 4
  store.commitLayer('freeze', [{ id: 'f2', kind: 'freeze', account: 'alice', amount: 90, parent: 'r2' }]); // 5
  store.commitLayer('pay', [{ id: 'p1', kind: 'pay', account: 'alice', amount: 50, parent: 'f2' }]); // 6
  return store;
}

// 验收 3：中间层 CRC 损坏后恢复旧检查点，跳至损坏层失败。
test('中间层CRC损坏：旧检查点可恢复，跳至损坏层失败', () => {
  const dir = tmpdir();
  const store = buildStore(dir);
  corruptLayerPayload(dir, 5); // 损坏检查点（第4层）之后的中间层
  // 旧检查点（第 4 层，早于损坏层）仍可恢复：只读检查点块，不触碰损坏层
  const res = store.restore({ checkpointLayer: 4 });
  assert.equal(res.layer, 4);
  assert.ok(res.state.txs.r1);
  assert.ok(res.state.txs.f1);
  assert.equal(res.state.txs.f2, undefined, '检查点之后的层不并入');
  assert.equal(res.state.accounts.alice.credit, 1000 - 80);
  // 跳至损坏层及穿过损坏层都失败（损坏 -> CorruptionError）
  assert.throws(() => store.restore({ targetLayer: 5 }), CorruptionError);
  assert.throws(() => store.restore({ targetLayer: 6 }), CorruptionError);
  assert.throws(() => store.restore({}), CorruptionError);
  assert.throws(() => store.verify(), CorruptionError);
});

test('检查点晚于损坏层时，带检查点的增量恢复仍可解码到 head', () => {
  const dir = tmpdir();
  const store = buildStore(dir);
  corruptLayerPayload(dir, 2); // 损坏检查点之前的层
  // restore 从第 4 层检查点出发，不重放全文件，因此第 2 层损坏不影响恢复到 head
  const res = store.restore({});
  assert.equal(res.layer, 6);
  assert.equal(res.state.accounts.alice.balance, 1000 - 50);
  // 但指定目标层穿过损坏层时仍失败
  assert.throws(() => store.restore({ targetLayer: 2 }), CorruptionError);
  // verify 全链校验能发现损坏
  assert.throws(() => store.verify(), CorruptionError);
});

test('索引指向的偏移处层号或哈希不符按索引损坏处理', () => {
  const dir = tmpdir();
  const store = buildStore(dir);
  const indexPath = path.join(dir, 'index.json');
  const original = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  // 篡改哈希（检查点之后的第 5 层，restore 到 head 会用到）
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.layers['5'].hash = '0'.repeat(64);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  assert.throws(() => store.verify(), IndexCorruptionError);
  assert.throws(() => store.restore({}), IndexCorruptionError);
  // 旧检查点恢复不触碰被篡改的索引项，仍可用
  assert.equal(store.restore({ checkpointLayer: 4 }).layer, 4);
  // 篡改偏移（指到块中间 -> 魔数不符）
  const index2 = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index2.layers['5'].hash = original.layers['5'].hash;
  index2.layers['5'].offset += 7;
  fs.writeFileSync(indexPath, JSON.stringify(index2, null, 2));
  assert.throws(() => store.verify(), IndexCorruptionError);
  // 篡改层号对应关系：把第 5 层的索引项指向第 6 层的偏移
  const index3 = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index3.layers['5'].offset = index3.layers['5'].offset - 7; // 还原
  index3.layers['5'] = { ...index3.layers['6'] };
  fs.writeFileSync(indexPath, JSON.stringify(index3, null, 2));
  assert.throws(() => store.verify(), IndexCorruptionError);
  assert.throws(() => store.restore({}), IndexCorruptionError);
});
