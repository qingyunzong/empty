'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { tmpdir } = require('./helpers');

test('撤销实付必须先恢复对应冻结链路，且只能回退检查点之后的层级', () => {
  const dir = tmpdir();
  Store.init(dir, { alice: { budget: 1000, credit: 1000, balance: 1000 } });
  const store = Store.open(dir);
  store.commitLayer('reserve', [{ id: 'r1', kind: 'reserve', account: 'alice', amount: 200 }]); // 1
  store.commitLayer('freeze', [{ id: 'f1', kind: 'freeze', account: 'alice', amount: 150, parent: 'r1' }]); // 2
  store.commitLayer('pay', [{ id: 'p1', kind: 'pay', account: 'alice', amount: 100, parent: 'f1' }]); // 3
  store.checkpoint(); // 4
  store.commitLayer('freeze', [{ id: 'f2', kind: 'freeze', account: 'alice', amount: 50, parent: 'r1' }]); // 5
  store.commitLayer('pay', [{ id: 'p2', kind: 'pay', account: 'alice', amount: 50, parent: 'f2' }]); // 6
  // 冻结已被实付消费：必须先撤销实付
  assert.throws(
    () => store.commitLayer('revert', [{ id: 'rvBad', kind: 'revert', target: 'f2' }]),
    /revert the pay first/,
  );
  // 检查点之前的层不可回退
  assert.throws(
    () => store.commitLayer('revert', [{ id: 'rvOld', kind: 'revert', target: 'p1' }]),
    /checkpoint/,
  );
  // 撤销实付 p2：余额回补，冻结链路恢复（f2 回到冻结态，额度不直接释放）
  store.commitLayer('revert', [{ id: 'rv1', kind: 'revert', target: 'p2' }]); // 7
  let state = store.restore({}).state;
  assert.equal(state.accounts.alice.balance, 1000 - 100);
  assert.equal(state.accounts.alice.credit, 1000 - 150 - 50, '额度仍被冻结占用');
  assert.equal(state.txs.f2.consumed, false, '冻结链路已恢复');
  assert.equal(state.txs.f2.reverted, false);
  // 现在可以撤销冻结：额度释放
  store.commitLayer('revert', [{ id: 'rv2', kind: 'revert', target: 'f2' }]); // 8
  state = store.restore({}).state;
  assert.equal(state.accounts.alice.credit, 1000 - 150);
  // 检查点之前的预约同样不可回退
  assert.throws(
    () => store.commitLayer('revert', [{ id: 'rv3', kind: 'revert', target: 'r1' }]),
    /checkpoint/,
  );
  // 检查点之后：预约仍有活跃冻结子链，不可直接撤销
  store.commitLayer('reserve', [{ id: 'r2', kind: 'reserve', account: 'alice', amount: 100 }]); // 9
  store.commitLayer('freeze', [{ id: 'f3', kind: 'freeze', account: 'alice', amount: 30, parent: 'r2' }]); // 10
  assert.throws(
    () => store.commitLayer('revert', [{ id: 'rv5', kind: 'revert', target: 'r2' }]),
    /freeze chain/,
  );
  // 重复撤销同一事务失败
  assert.throws(
    () => store.commitLayer('revert', [{ id: 'rv4', kind: 'revert', target: 'p2' }]),
    /already reverted/,
  );
});
