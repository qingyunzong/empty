import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  deposit,
  executeFill,
  cancelFill,
  acknowledge,
  COMPENSATION_STEPS,
} from '../src/saga.js';

const INITIAL = 1000;
const AMOUNT = 100;
const FEE = 5;

function setup({ irreversible = false } = {}) {
  const state = createState();
  deposit(state, INITIAL);
  executeFill(state, { id: 'f1', amount: AMOUNT, fee: FEE, irreversible });
  return state;
}

function ackSteps(state) {
  return state.events.filter((e) => e.type === 'COMPENSATION_ACK').map((e) => e.step);
}

function assertFullyRolledBack(state) {
  assert.deepEqual(state.ledger, { available: INITIAL, reserved: 0, feesCollected: 0 });
  assert.deepEqual(state.matches, {});
  assert.equal(state.fills.f1.status, 'CANCELLED');
}

test('成交后任意三个补偿阶段撤单,最终全部资源回退', () => {
  for (const failAt of COMPENSATION_STEPS) {
    const state = setup();
    // 第一次撤单在该分支失败 -> CANCELLING,之前的分支已 ACK
    assert.throws(() => cancelFill(state, 'f1', { failAt }), (err) => {
      assert.equal(err.code, 'COMPENSATION_FAILED');
      assert.equal(err.details.step, failAt);
      return true;
    });
    assert.equal(state.fills.f1.status, 'CANCELLING');
    assert.equal(state.fills.f1.comp[failAt], 'FAILED');
    // 恢复后重试,从未完成分支继续,最终全部回退
    const cert = cancelFill(state, 'f1');
    assert.equal(cert.status, 'CANCELLED');
    assertFullyRolledBack(state);
    assert.deepEqual(ackSteps(state), [...COMPENSATION_STEPS]);
  }
});

test('重复撤单和重复 ACK 不产生多退', () => {
  const state = setup();
  const cert1 = cancelFill(state, 'f1');
  assertFullyRolledBack(state);
  // 重复撤单: 幂等返回同一证书,账本不变
  const cert2 = cancelFill(state, 'f1');
  const cert3 = cancelFill(state, 'f1', { failAt: 'REFUND_FEE' }); // failAt 也不再生效
  assert.deepEqual(cert2, cert1);
  assert.deepEqual(cert3, cert1);
  assertFullyRolledBack(state);
  // 重复 ACK: duplicate=true,不产生多退
  for (const step of COMPENSATION_STEPS) {
    const res = acknowledge(state, 'f1', step);
    assert.equal(res.ack, true);
    assert.equal(res.duplicate, true);
  }
  assert.deepEqual(state.ledger, { available: INITIAL, reserved: 0, feesCollected: 0 });
  // 撤单途中重复请求也不重复补偿
  const s2 = setup();
  assert.throws(() => cancelFill(s2, 'f1', { failAt: 'REFUND_FEE' }), /REFUND_FEE/);
  assert.throws(() => cancelFill(s2, 'f1', { failAt: 'REFUND_FEE' }), /REFUND_FEE/);
  assert.equal(s2.ledger.feesCollected, FEE); // UNDO_MATCH 已 ACK,费用仍未退
  cancelFill(s2, 'f1');
  assert.deepEqual(s2.ledger, { available: INITIAL, reserved: 0, feesCollected: 0 });
});

test('不可撤销成交返回 IRREVERSIBLE_CONFLICT 且余额不变', () => {
  const state = setup({ irreversible: true });
  const before = structuredClone(state);
  assert.throws(() => cancelFill(state, 'f1'), (err) => {
    assert.equal(err.code, 'IRREVERSIBLE_CONFLICT');
    return true;
  });
  // 不得产生任何部分补偿: 状态完全不变
  assert.deepEqual(state, before);
  assert.equal(state.fills.f1.status, 'FILLED');
  assert.deepEqual(state.ledger, {
    available: INITIAL - AMOUNT - FEE,
    reserved: AMOUNT,
    feesCollected: FEE,
  });
});

test('一个分支失败后恢复,补偿顺序和最终证书正确', () => {
  const state = setup();
  assert.throws(() => cancelFill(state, 'f1', { failAt: 'REFUND_FEE' }), /REFUND_FEE/);
  // 失败点之前: UNDO_MATCH 已 ACK(撮合已撤销),费用与准备金未动
  assert.equal(state.fills.f1.comp.UNDO_MATCH, 'ACK');
  assert.equal(state.fills.f1.comp.REFUND_FEE, 'FAILED');
  assert.equal(state.fills.f1.comp.RELEASE_RESERVE, 'PENDING');
  assert.deepEqual(state.matches, {});
  assert.deepEqual(state.ledger, {
    available: INITIAL - AMOUNT - FEE,
    reserved: AMOUNT,
    feesCollected: FEE,
  });
  const cert = cancelFill(state, 'f1');
  // 补偿顺序严格为相反顺序
  assert.deepEqual(ackSteps(state), ['UNDO_MATCH', 'REFUND_FEE', 'RELEASE_RESERVE']);
  assert.deepEqual(cert, {
    certificateId: 'CERT-f1',
    fillId: 'f1',
    status: 'CANCELLED',
    steps: ['UNDO_MATCH', 'REFUND_FEE', 'RELEASE_RESERVE'],
    acks: ['UNDO_MATCH', 'REFUND_FEE', 'RELEASE_RESERVE'],
    refundedFee: FEE,
    releasedReserve: AMOUNT,
  });
  assert.equal(state.fills.f1.certificate, cert);
  assertFullyRolledBack(state);
});

// 独立枚举器: 列出撤单点 x 失败分支 x 重复请求的全部组合,直接计算期望状态
function enumerateCombos() {
  const combos = [];
  for (const failBranch of [null, ...COMPENSATION_STEPS]) {
    for (const failCount of failBranch === null ? [0] : [1, 2]) {
      for (const repeatCancel of [0, 1, 2]) {
        for (const repeatAck of [0, 1]) {
          combos.push({ failBranch, failCount, repeatCancel, repeatAck });
        }
      }
    }
  }
  return combos;
}

// 不依赖 saga 实现,直接由组合参数计算期望终态
function expectedFinalState() {
  return {
    ledger: { available: INITIAL, reserved: 0, feesCollected: 0 },
    status: 'CANCELLED',
    matched: false,
    ackOrder: [...COMPENSATION_STEPS],
  };
}

test('枚举器: 撤单点/失败分支/重复请求组合的直接期望校验', () => {
  const combos = enumerateCombos();
  assert.equal(combos.length, 1 * 1 * 3 * 2 + 3 * 2 * 3 * 2); // 6 + 36 = 42
  for (const combo of combos) {
    const state = setup();
    // 重试直到完成: 前 failCount 次尝试在 failBranch 失败
    let attempts = 0;
    while (state.fills.f1.status !== 'CANCELLED') {
      attempts += 1;
      const stillFailing =
        combo.failBranch !== null &&
        attempts <= combo.failCount &&
        state.fills.f1.comp[combo.failBranch] !== 'ACK';
      try {
        cancelFill(state, 'f1', { failAt: stillFailing ? combo.failBranch : null });
      } catch (err) {
        assert.equal(err.code, 'COMPENSATION_FAILED', JSON.stringify(combo));
        assert.equal(state.fills.f1.status, 'CANCELLING', JSON.stringify(combo));
      }
      assert.ok(attempts <= combo.failCount + 1, `loop runaway: ${JSON.stringify(combo)}`);
    }
    // 重复撤单请求: 幂等
    for (let i = 0; i < combo.repeatCancel; i += 1) {
      cancelFill(state, 'f1', { failAt: combo.failBranch ?? undefined });
    }
    // 重复 ACK 请求: 幂等
    for (let i = 0; i < combo.repeatAck; i += 1) {
      const res = acknowledge(state, 'f1', 'REFUND_FEE');
      assert.equal(res.duplicate, true, JSON.stringify(combo));
    }
    const expected = expectedFinalState();
    assert.deepEqual(state.ledger, expected.ledger, JSON.stringify(combo));
    assert.equal(state.fills.f1.status, expected.status, JSON.stringify(combo));
    assert.equal(Boolean(state.matches.f1), expected.matched, JSON.stringify(combo));
    assert.deepEqual(ackSteps(state), expected.ackOrder, JSON.stringify(combo));
    assert.deepEqual(state.fills.f1.certificate.steps, expected.ackOrder, JSON.stringify(combo));
  }
});
