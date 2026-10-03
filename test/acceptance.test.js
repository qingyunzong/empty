import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, checkInvariants, initialState, verifyMigrationChain, EXIT, STATUS,
} from '../src/ledger.js';

function seeded(balances) {
  const state = initialState();
  for (const [name, available] of Object.entries(balances)) {
    state.accounts[name] = { available, frozen: 0, locked: 0 };
  }
  return state;
}

function ok(state, cmd) {
  const out = applyCommand(state, cmd);
  assert.equal(out.exitCode, EXIT.OK, out.error);
  assert.equal(out.ok, true);
  assert.deepEqual(checkInvariants(state), []);
  return out;
}

function err(state, cmd, code) {
  const out = applyCommand(state, cmd);
  assert.equal(out.ok, false);
  assert.equal(out.exitCode, code, out.error ?? out.result);
  assert.deepEqual(checkInvariants(state), []);
  return out;
}

test('全额撤销再恢复：资金回到转账后状态，迁移链完整', () => {
  const state = seeded({ alice: 100 });
  ok(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 });
  assert.equal(state.accounts.alice.available, 0);
  assert.equal(state.accounts.bob.available, 100);
  assert.equal(state.transactions.t1.status, STATUS.POSTED);

  const rev = ok(state, { type: 'reverse', tx: 't1' });
  assert.equal(rev.result.status, STATUS.REVERSED);
  assert.equal(state.accounts.alice.available, 100);
  assert.equal(state.accounts.bob.available, 0);

  const rr = ok(state, { type: 'reverseReversal', tx: 't1' });
  assert.equal(rr.result.status, STATUS.RESTORED);
  assert.equal(state.accounts.alice.available, 0);
  assert.equal(state.accounts.bob.available, 100);

  assert.equal(state.migrations.length, 3);
  assert.deepEqual(
    state.migrations.map((m) => [m.fromStatus, m.toStatus]),
    [[STATUS.PENDING, STATUS.POSTED], [STATUS.POSTED, STATUS.REVERSED], [STATUS.REVERSED, STATUS.RESTORED]],
  );
  for (const m of state.migrations) {
    for (const field of ['id', 'from', 'to', 'amount', 'reason', 'hash']) {
      assert.ok(m[field] !== undefined, `migration missing ${field}`);
    }
  }
  assert.ok(verifyMigrationChain(state));
});

test('部分撤销边界：amount=0 与超额均 exit16，剩余保持 POSTED', () => {
  const state = seeded({ alice: 100 });
  ok(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 });

  err(state, { type: 'reverse', tx: 't1', amount: 0 }, EXIT.AMOUNT_OUT_OF_RANGE);
  err(state, { type: 'reverse', tx: 't1', amount: -5 }, EXIT.AMOUNT_OUT_OF_RANGE);
  err(state, { type: 'reverse', tx: 't1', amount: 101 }, EXIT.AMOUNT_OUT_OF_RANGE);
  assert.equal(state.transactions.t1.status, STATUS.POSTED);
  assert.equal(state.transactions.t1.reversedAmount, 0);

  const part = ok(state, { type: 'reverse', tx: 't1', amount: 30 });
  assert.equal(part.result.status, STATUS.POSTED);
  assert.equal(state.accounts.alice.available, 30);
  assert.equal(state.accounts.bob.available, 70);

  err(state, { type: 'reverse', tx: 't1', amount: 71 }, EXIT.AMOUNT_OUT_OF_RANGE);
  const rest = ok(state, { type: 'reverse', tx: 't1', amount: 70 });
  assert.equal(rest.result.status, STATUS.REVERSED);
  assert.equal(state.accounts.alice.available, 100);
  assert.equal(state.accounts.bob.available, 0);
});

test('终态与非法迁移：RESTORED 禁止再操作，exit15', () => {
  const state = seeded({ alice: 100 });
  ok(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 });

  err(state, { type: 'reverseReversal', tx: 't1' }, EXIT.ILLEGAL_TRANSITION);
  err(state, { type: 'reverse', tx: 'missing' }, EXIT.ILLEGAL_TRANSITION);
  err(state, { type: 'reverseReversal', tx: 'missing' }, EXIT.ILLEGAL_TRANSITION);

  ok(state, { type: 'reverse', tx: 't1' });
  err(state, { type: 'reverse', tx: 't1' }, EXIT.ILLEGAL_TRANSITION);
  ok(state, { type: 'reverseReversal', tx: 't1' });
  assert.equal(state.transactions.t1.status, STATUS.RESTORED);

  err(state, { type: 'reverse', tx: 't1' }, EXIT.ILLEGAL_TRANSITION);
  err(state, { type: 'reverseReversal', tx: 't1' }, EXIT.ILLEGAL_TRANSITION);
  assert.equal(state.accounts.alice.available, 0);
  assert.equal(state.accounts.bob.available, 100);
});

test('冻结与撤销交织不透支，unfreeze 不释放撤销补偿锁定份额', () => {
  const state = seeded({ alice: 100 });
  ok(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 });
  ok(state, { type: 'freeze', account: 'bob', amount: 80 });
  assert.deepEqual(state.accounts.bob, { available: 20, frozen: 80, locked: 0 });

  const rev = ok(state, { type: 'reverse', tx: 't1', amount: 50 });
  assert.equal(rev.result.locked, 30);
  assert.deepEqual(state.accounts.bob, { available: 0, frozen: 80, locked: 30 });
  assert.equal(state.accounts.alice.available, 50);

  err(state, { type: 'unfreeze', account: 'bob', amount: 51 }, EXIT.AMOUNT_OUT_OF_RANGE);
  ok(state, { type: 'unfreeze', account: 'bob', amount: 50 });
  assert.deepEqual(state.accounts.bob, { available: 50, frozen: 30, locked: 30 });

  ok(state, { type: 'reverse', tx: 't1', amount: 50 });
  assert.equal(state.transactions.t1.status, STATUS.REVERSED);
  assert.deepEqual(state.accounts.bob, { available: 0, frozen: 30, locked: 30 });

  ok(state, { type: 'reverseReversal', tx: 't1' });
  assert.deepEqual(state.accounts.alice, { available: 0, frozen: 0, locked: 0 });
  assert.deepEqual(state.accounts.bob, { available: 70, frozen: 30, locked: 0 });
  assert.ok(verifyMigrationChain(state));
});

test('全额冻结下撤销走锁定份额，恢复后守恒', () => {
  const state = seeded({ alice: 100 });
  ok(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 });
  ok(state, { type: 'freeze', account: 'bob', amount: 100 });
  const rev = ok(state, { type: 'reverse', tx: 't1' });
  assert.equal(rev.result.locked, 100);
  assert.deepEqual(state.accounts.bob, { available: 0, frozen: 100, locked: 100 });
  err(state, { type: 'unfreeze', account: 'bob', amount: 1 }, EXIT.AMOUNT_OUT_OF_RANGE);
  ok(state, { type: 'reverseReversal', tx: 't1' });
  assert.deepEqual(state.accounts.alice, { available: 0, frozen: 0, locked: 0 });
  assert.deepEqual(state.accounts.bob, { available: 0, frozen: 100, locked: 0 });
});

test('撤销/恢复不得透支：余额不足时 exit16', () => {
  const state = seeded({ alice: 100 });
  ok(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 });
  ok(state, { type: 'transfer', id: 't2', from: 'bob', to: 'carol', amount: 90 });
  err(state, { type: 'reverse', tx: 't1', amount: 50 }, EXIT.AMOUNT_OUT_OF_RANGE);
  ok(state, { type: 'reverse', tx: 't1', amount: 10 });
  ok(state, { type: 'reverse', tx: 't2' });
  ok(state, { type: 'transfer', id: 't3', from: 'bob', to: 'dave', amount: 90 });
  err(state, { type: 'reverseReversal', tx: 't2' }, EXIT.AMOUNT_OUT_OF_RANGE);
});

test('幂等：重复 idempotencyKey 返回原结果且不重复生效（含错误重放）', () => {
  const state = seeded({ alice: 100 });
  const cmd = { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 60, idempotencyKey: 'K1' };
  const first = ok(state, cmd);
  const second = applyCommand(state, cmd);
  assert.equal(second.replayed, true);
  assert.equal(second.exitCode, EXIT.OK);
  assert.deepEqual(second.result, first.result);
  assert.equal(state.accounts.bob.available, 60);
  assert.equal(state.migrations.length, 1);

  const bad = { type: 'reverseReversal', tx: 't1', idempotencyKey: 'K2' };
  const e1 = err(state, bad, EXIT.ILLEGAL_TRANSITION);
  const e2 = applyCommand(state, bad);
  assert.equal(e2.replayed, true);
  assert.equal(e2.exitCode, EXIT.ILLEGAL_TRANSITION);
  assert.equal(e2.error, e1.error);
});

test('未知命令 exit17', () => {
  const state = seeded({ alice: 100 });
  const out = err(state, { type: 'teleport', account: 'alice', amount: 10 }, EXIT.UNKNOWN_COMMAND);
  assert.match(out.error, /unknown command/);
});

test('金额越界：transfer/freeze/unfreeze 非正或超额均 exit16', () => {
  const state = seeded({ alice: 50 });
  err(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 0 }, EXIT.AMOUNT_OUT_OF_RANGE);
  err(state, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 51 }, EXIT.AMOUNT_OUT_OF_RANGE);
  err(state, { type: 'freeze', account: 'alice', amount: 0 }, EXIT.AMOUNT_OUT_OF_RANGE);
  err(state, { type: 'freeze', account: 'alice', amount: 51 }, EXIT.AMOUNT_OUT_OF_RANGE);
  err(state, { type: 'unfreeze', account: 'alice', amount: 1 }, EXIT.AMOUNT_OUT_OF_RANGE);
  assert.equal(state.accounts.alice.available, 50);
});
