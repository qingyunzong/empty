'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { BusinessError, CrashSimulatedError } = require('../src/errors');
const { tmpdir } = require('./helpers');

// 验收 2：构造部分层写入后崩溃，确认无半层且孤儿可报告。
test('写块后崩溃：无半层、孤儿可报告且不并入状态', () => {
  const dir = tmpdir();
  Store.init(dir, { alice: { budget: 1000, credit: 1000, balance: 1000 } });
  const store = Store.open(dir);
  store.commitLayer('reserve', [{ id: 'r1', kind: 'reserve', account: 'alice', amount: 100 }]);
  store.commitLayer('freeze', [{ id: 'f1', kind: 'freeze', account: 'alice', amount: 60, parent: 'r1' }]);
  // 崩溃 1：块已写入但未链接（索引未更新）
  assert.throws(
    () => store.commitLayer('reserve', [{ id: 'rX', kind: 'reserve', account: 'alice', amount: 50 }], { crash: 'after-write' }),
    CrashSimulatedError,
  );
  let res = store.restore({});
  assert.equal(res.layer, 2, 'head 仍停留在第 2 层');
  assert.equal(res.state.txs.rX, undefined, '未链接块绝不并入状态');
  assert.equal(res.orphans.length, 1, '孤儿可报告');
  assert.deepEqual(res.orphans[0].txs, ['rX']);
  assert.equal(res.orphans[0].reason, 'written but not linked');
  let v = store.verify();
  assert.equal(v.ok, true, '孤儿不影响已链接链的校验');
  assert.equal(v.orphans.length, 1);
  // 崩溃 2：半截块（torn write）
  assert.throws(
    () => store.commitLayer('reserve', [{ id: 'rY', kind: 'reserve', account: 'alice', amount: 40 }], { crash: 'torn' }),
    CrashSimulatedError,
  );
  res = store.restore({});
  assert.equal(res.layer, 2, '半截块不会成为半层');
  assert.equal(res.state.txs.rY, undefined);
  v = store.verify();
  assert.equal(v.ok, true);
  assert.ok(v.warnings.length >= 1, '截断尾部以警告形式报告');
  // 崩溃后系统可继续提交，且新层状态正确
  store.commitLayer('reserve', [{ id: 'r3', kind: 'reserve', account: 'alice', amount: 10 }]);
  res = store.restore({});
  assert.equal(res.layer, 3);
  assert.equal(res.state.accounts.alice.budget, 1000 - 100 - 10);
  assert.ok(res.orphans.some((o) => o.txs.includes('rX')), '旧孤儿仍可报告');
});

test('层内事务部分失败：整层不提交，已写块成为孤儿', () => {
  const dir = tmpdir();
  Store.init(dir, { alice: { budget: 100, credit: 100, balance: 100 } });
  const store = Store.open(dir);
  // 同层两笔：第二笔预算不足 -> 整层失败
  assert.throws(
    () => store.commitLayer('reserve', [
      { id: 'r1', kind: 'reserve', account: 'alice', amount: 10 },
      { id: 'r2', kind: 'reserve', account: 'alice', amount: 9999 },
    ]),
    BusinessError,
  );
  const res = store.restore({});
  assert.equal(res.layer, 0, '整层不提交，head 不变');
  assert.equal(res.state.txs.r1, undefined, '成功的那笔也不生效');
  assert.equal(res.state.accounts.alice.budget, 100);
  assert.equal(res.orphans.length, 1, '已写入未链接的块成为孤儿');
  assert.deepEqual(res.orphans[0].txs.sort(), ['r1', 'r2']);
  assert.equal(store.verify().ok, true, '孤儿不视为损坏');
});
