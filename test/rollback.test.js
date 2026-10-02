'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { planRollback, executeRollback } = require('../src/rollback');
const { replayBalances, deriveExpectedBalances } = require('../src/reference');
const { buildRandomLedger } = require('../src/random');
const { CODES } = require('../src/errors');

function buildThreeLevel() {
  const ledger = new Ledger();
  ledger.openBatch('G');
  ledger.post('G', { account: 'cash', amount: 1000, day: 1 });
  ledger.post('G', { account: 'rev', amount: -1000, day: 1 });
  ledger.createSavepoint('sp', { batchId: 'G' });
  ledger.openBatch('P', 'G');
  ledger.openBatch('C', 'P');
  ledger.post('P', { account: 'cash', amount: 200, day: 2 });
  ledger.post('C', { account: 'fee', amount: 50, day: 2 });
  return ledger;
}

test('验收1: 祖父-父-子三级回滚只清未结算分支', () => {
  const ledger = buildThreeLevel();
  const plan = planRollback(ledger, 'sp');
  assert.deepEqual(plan.undo.map((u) => u.batchId).sort(), ['C', 'P']);
  assert.equal(plan.orphanReversals.length, 0);
  assert.deepEqual(plan.impact.clearedBatches, ['C', 'P']);
  const result = executeRollback(ledger, plan);
  assert.notEqual(result.preHash, result.postHash);
  // 未结算分支被清除，目标批次快照分录原样保留
  assert.deepEqual(ledger.balances(), { cash: 1000, rev: -1000 });
  assert.equal(ledger.batches.get('P').status, 'rolled_back');
  assert.equal(ledger.batches.get('C').status, 'rolled_back');
  assert.equal(ledger.batches.get('G').status, 'open');
  assert.equal(ledger.entries[2].status, 'rolled_back');
  assert.equal(ledger.entries[3].status, 'rolled_back');
  // 无悬空：在账分录不挂在已回滚批次上
  for (const e of ledger.entries) {
    if (e.status === 'posted' || e.status === 'settled') {
      assert.notEqual(ledger.batches.get(e.batchId).status, 'rolled_back');
    }
  }
});

test('验收2: 已出账子批次必须先生成冲正再回滚', () => {
  const ledger = buildThreeLevel();
  ledger.openBatch('S', 'G');
  ledger.post('S', { account: 'cash', amount: 300, day: 2 });
  ledger.settleBatch('S');
  // 不生成冲正 -> E_ORPHAN，且阻塞清单指向已出账分录
  assert.throws(
    () => planRollback(ledger, 'sp', { generateReversals: false }),
    (err) => err.code === CODES.ORPHAN && err.details.blocking.includes(5),
  );
  const plan = planRollback(ledger, 'sp');
  assert.equal(plan.orphanReversals.length, 1);
  assert.equal(plan.orphanReversals[0].seq, 5);
  const result = executeRollback(ledger, plan);
  assert.equal(result.orphanBatchId, '__orphan__:sp');
  const orig = ledger.entries[4];
  const reversal = ledger.entries[plan.orphanReversals[0].reversalSeq - 1];
  assert.equal(orig.status, 'reversed');
  assert.equal(reversal.kind, 'reversal');
  assert.equal(reversal.amount, -300);
  assert.equal(reversal.reverses, 5);
  // 冲正后净额为零，已出账分支被回滚
  assert.equal(ledger.batches.get('S').status, 'rolled_back');
  assert.deepEqual(ledger.balances(), { cash: 1000, rev: -1000 });
});

test('恢复点不得复活被后续更正覆盖的交易', () => {
  const ledger = buildThreeLevel();
  ledger.correct(1, 1200); // 快照后更正 e1: 1000 -> 1200
  const plan = planRollback(ledger, 'sp');
  assert.deepEqual(plan.preservedCorrections, [
    { seq: 5, supersedes: 1, account: 'cash', amount: 1200 },
  ]);
  executeRollback(ledger, plan);
  assert.equal(ledger.effectiveAmount(ledger.entries[0]), 1200);
  assert.equal(ledger.balances().cash, 1200); // 不是快照里的旧值 1000
});

test('验收3: 跨日边界 savepoint 不含下一日首笔', () => {
  const ledger = new Ledger();
  ledger.openBatch('G');
  ledger.post('G', { account: 'cash', amount: 100, day: 1 });
  ledger.post('G', { account: 'rev', amount: -100, day: 1 });
  const sp = ledger.createSavepoint('eod1', { batchId: 'G' });
  ledger.post('G', { account: 'cash', amount: 7, day: 2 }); // 下一日首笔
  assert.equal(sp.day, 1);
  assert.ok(sp.snapshot.entries.every((e) => e.day <= 1));
  assert.ok(!sp.snapshot.entries.some((e) => e.seq === 3));
  // 回滚后下一日首笔被撤销，快照状态恢复
  const plan = planRollback(ledger, 'eod1');
  executeRollback(ledger, plan);
  assert.deepEqual(ledger.balances(), { cash: 100, rev: -100 });
});

test('E_BOUNDARY: savepoint 不得切开同一日', () => {
  const ledger = new Ledger();
  ledger.openBatch('G');
  ledger.post('G', { account: 'cash', amount: 1, day: 1 });
  ledger.post('G', { account: 'cash', amount: 2, day: 1 });
  ledger.post('G', { account: 'cash', amount: 3, day: 2 });
  assert.throws(
    () => ledger.createSavepoint('mid', { batchId: 'G', atSeq: 1 }),
    (err) => err.code === CODES.BOUNDARY,
  );
  assert.throws(
    () => ledger.createSavepoint('oob', { batchId: 'G', atSeq: 99 }),
    (err) => err.code === CODES.BOUNDARY,
  );
  assert.throws(
    () => ledger.post('G', { account: 'cash', amount: 4, day: 1 }), // 日期回退
    (err) => err.code === CODES.BOUNDARY,
  );
  const sp = ledger.createSavepoint('eod1', { batchId: 'G', atSeq: 2 });
  assert.equal(sp.day, 1);
});

test('E_SNAP: 缺失/篡改/已消费/过期计划', () => {
  const ledger = buildThreeLevel();
  assert.throws(() => planRollback(ledger, 'nope'), (err) => err.code === CODES.SNAP);
  const tampered = buildThreeLevel();
  tampered.savepoints.get('sp').snapshot.entries.push({
    seq: 99, batchId: 'G', account: 'x', amount: 1, day: 1, status: 'posted',
  });
  assert.throws(() => planRollback(tampered, 'sp'), (err) => err.code === CODES.SNAP);
  const plan = planRollback(ledger, 'sp');
  executeRollback(ledger, plan);
  assert.throws(() => planRollback(ledger, 'sp'), (err) => err.code === CODES.SNAP); // 已消费
  const stale = buildThreeLevel();
  const p = planRollback(stale, 'sp');
  stale.post('G', { account: 'cash', amount: 1, day: 3 }); // 计划后账本变化
  assert.throws(() => executeRollback(stale, p), (err) => err.code === CODES.SNAP);
});

test('E_DEPEND: 依赖链违规', () => {
  const ledger = buildThreeLevel();
  assert.throws(() => ledger.openBatch('G'), (err) => err.code === CODES.DEPEND); // 重复批次
  assert.throws(() => ledger.openBatch('X', 'ghost'), (err) => err.code === CODES.DEPEND); // 父不存在
  const plan = planRollback(ledger, 'sp');
  executeRollback(ledger, plan);
  assert.throws(() => ledger.post('P', { account: 'a', amount: 1, day: 3 }),
    (err) => err.code === CODES.DEPEND); // 已回滚批次不可过账
  assert.throws(() => ledger.openBatch('Y', 'C'), (err) => err.code === CODES.DEPEND); // 已回滚父批次
  // 目标批次已回滚时其 savepoint 不可再用
  const inner = new Ledger();
  inner.openBatch('G');
  inner.post('G', { account: 'cash', amount: 1, day: 1 });
  inner.openBatch('P', 'G');
  inner.createSavepoint('spG', { batchId: 'G' });
  inner.post('P', { account: 'cash', amount: 2, day: 2 });
  inner.createSavepoint('spP', { batchId: 'P' });
  executeRollback(inner, planRollback(inner, 'spG'));
  assert.throws(() => planRollback(inner, 'spP'), (err) => err.code === CODES.DEPEND);
});

test('验收4: 随机小账期与逐笔重放/快照推导参考模型对照', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const { ledger, savepoint } = buildRandomLedger(seed);
    const plan = planRollback(ledger, 'sp');
    const result = executeRollback(ledger, plan);
    assert.equal(result.preHash, plan.preHash, `seed ${seed}`);
    const actual = ledger.balances();
    assert.deepEqual(actual, replayBalances(ledger.entries), `replay seed ${seed}`);
    assert.deepEqual(actual, deriveExpectedBalances(ledger, savepoint, plan), `derive seed ${seed}`);
    // 无悬空恢复
    for (const e of ledger.entries) {
      if (e.status === 'posted' || e.status === 'settled') {
        assert.notEqual(ledger.batches.get(e.batchId).status, 'rolled_back', `seed ${seed} seq ${e.seq}`);
      }
    }
  }
});
