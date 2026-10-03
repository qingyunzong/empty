import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, verifyHashChain } from '../src/engine.js';

test('超额冻结失败: authorize beyond available -> INSUFFICIENT, state untouched', () => {
  const eng = new Engine({ initialBalance: 100 });
  const res = eng.submit({ type: 'authorize', clientOpId: 'a1', clock: 1, amount: 150 });
  assert.deepEqual(res, { status: 'ERROR', code: 'INSUFFICIENT' });
  assert.equal(eng.view().available, 100);
  assert.equal(eng.view().frozen, 0);
  eng.submit({ type: 'authorize', clientOpId: 'a2', clock: 2, amount: 100 });
  const res2 = eng.submit({ type: 'authorize', clientOpId: 'a3', clock: 3, amount: 1 });
  assert.deepEqual(res2, { status: 'ERROR', code: 'INSUFFICIENT' });
  assert.equal(eng.view().frozen, 100);
});

test('部分撤销链恢复: partial reversal chain on a capture, cumulative cap enforced', () => {
  const eng = new Engine({ initialBalance: 0 });
  eng.submit({ type: 'deposit', clientOpId: 'd1', clock: 1, amount: 500 });
  eng.submit({ type: 'authorize', clientOpId: 'a1', clock: 2, amount: 200, ttl: 100 });
  eng.submit({ type: 'capture', clientOpId: 'c1', clock: 3, parentId: 'a1', amount: 120 });

  const r1 = eng.submit({ type: 'reverse', clientOpId: 'r1', clock: 4, parentId: 'c1', amount: 40 });
  assert.deepEqual(r1, { status: 'OK', reversed: 40, rootId: 'c1', cumulative: 40 });
  // chain: reference the previous reversal as parent
  const r2 = eng.submit({ type: 'reverse', clientOpId: 'r2', clock: 5, parentId: 'r1', amount: 40 });
  assert.deepEqual(r2, { status: 'OK', reversed: 40, rootId: 'c1', cumulative: 80 });
  // cumulative 80 + 50 > 120 original -> rejected
  const r3 = eng.submit({ type: 'reverse', clientOpId: 'r3', clock: 6, parentId: 'r2', amount: 50 });
  assert.deepEqual(r3, { status: 'ERROR', code: 'INSUFFICIENT' });
  const r4 = eng.submit({ type: 'reverse', clientOpId: 'r4', clock: 7, parentId: 'c1', amount: 40 });
  assert.deepEqual(r4, { status: 'OK', reversed: 40, rootId: 'c1', cumulative: 120 });
  // fully reversed -> IDEMPOTENT
  const r5 = eng.submit({ type: 'reverse', clientOpId: 'r5', clock: 8, parentId: 'c1', amount: 1 });
  assert.deepEqual(r5, { status: 'IDEMPOTENT', rootId: 'c1', cumulative: 120 });

  let view = eng.view();
  assert.equal(view.available, 420);
  assert.equal(view.frozen, 80);
  assert.equal(view.captured, 0);
  assert.equal(view.refunded, 120);

  // void the remaining authorization: funds released back to available
  const r6 = eng.submit({ type: 'reverse', clientOpId: 'r6', clock: 9, parentId: 'a1' });
  assert.deepEqual(r6, { status: 'OK', reversed: 80, rootId: 'a1', cumulative: 80 });
  view = eng.view();
  assert.deepEqual(view, {
    available: 500,
    frozen: 0,
    captured: 0,
    refunded: 120,
    voided: 80,
    expired: 0,
    openAuthorizations: 0,
    terminalAuthorizations: 1,
  });
});

test('乱序并发: out-of-order submission linearizes by (clock, clientOpId) to one final state', () => {
  const ops = [
    { type: 'deposit', clientOpId: 'd1', clock: 1, amount: 1000 },
    { type: 'authorize', clientOpId: 'a1', clock: 2, amount: 400, ttl: 5 },
    { type: 'authorize', clientOpId: 'a2', clock: 3, amount: 400, ttl: 5 },
    { type: 'capture', clientOpId: 'c1', clock: 4, parentId: 'a1', amount: 150 },
    { type: 'reverse', clientOpId: 'r1', clock: 5, parentId: 'c1', amount: 50 },
    { type: 'expire', clientOpId: 'e1', clock: 9, parentId: 'a2' },
  ];
  const base = new Engine({ initialBalance: 0 });
  for (const op of ops) base.submit(op);

  const permutations = [
    [5, 4, 3, 2, 1, 0],
    [2, 0, 4, 1, 5, 3],
    [3, 1, 5, 0, 4, 2],
    [4, 2, 0, 5, 3, 1],
  ];
  for (const perm of permutations) {
    const eng = new Engine({ initialBalance: 0 });
    for (const i of perm) eng.submit(ops[i]);
    assert.equal(eng.tipHash, base.tipHash);
    assert.deepEqual(eng.view(), base.view());
  }
  assert.deepEqual(base.view(), {
    available: 650,
    frozen: 250,
    captured: 100,
    refunded: 50,
    voided: 0,
    expired: 400,
    openAuthorizations: 1,
    terminalAuthorizations: 1,
  });
});

test('重复提交幂等: identical resubmit replays, conflicting resubmit -> DUP_OP', () => {
  const eng = new Engine({ initialBalance: 10 });
  const op = { type: 'deposit', clientOpId: 'd1', clock: 1, amount: 5 };
  const first = eng.submit(op);
  const again = eng.submit({ ...op });
  assert.equal(again.replay, true);
  assert.equal(again.status, first.status);
  const conflict = eng.submit({ type: 'deposit', clientOpId: 'd1', clock: 1, amount: 6 });
  assert.deepEqual(conflict, { status: 'ERROR', code: 'DUP_OP', clientOpId: 'd1' });
  assert.equal(eng.view().available, 15);
});

test('TIME_TRAVEL: child op with clock earlier than its known parent', () => {
  const eng = new Engine({ initialBalance: 100 });
  eng.submit({ type: 'authorize', clientOpId: 'a1', clock: 5, amount: 10 });
  const res = eng.submit({ type: 'capture', clientOpId: 'c1', clock: 2, parentId: 'a1', amount: 10 });
  assert.deepEqual(res, { status: 'ERROR', code: 'TIME_TRAVEL' });
  const res2 = eng.submit({ type: 'reverse', clientOpId: 'r1', clock: 1, parentId: 'a1', amount: 10 });
  assert.deepEqual(res2, { status: 'ERROR', code: 'TIME_TRAVEL' });
});

test('BAD_PARENT: parent unknown to the ledger', () => {
  const eng = new Engine({ initialBalance: 100 });
  const res = eng.submit({ type: 'reverse', clientOpId: 'r1', clock: 1, parentId: 'nope', amount: 1 });
  assert.deepEqual(res, { status: 'ERROR', code: 'BAD_PARENT' });
  const res2 = eng.submit({ type: 'capture', clientOpId: 'c1', clock: 1, parentId: 'ghost', amount: 1 });
  assert.deepEqual(res2, { status: 'ERROR', code: 'BAD_PARENT' });
});

test('PENDING -> EXPIRED via expire after slot; premature expire stays PENDING', () => {
  const eng = new Engine({ initialBalance: 100 });
  eng.submit({ type: 'authorize', clientOpId: 'a1', clock: 1, amount: 60, ttl: 5 });
  const early = eng.submit({ type: 'expire', clientOpId: 'e1', clock: 4, parentId: 'a1' });
  assert.deepEqual(early, { status: 'PENDING', expiresAt: 6 });
  assert.equal(eng.view().frozen, 60);
  const late = eng.submit({ type: 'expire', clientOpId: 'e2', clock: 6, parentId: 'a1' });
  assert.deepEqual(late, { status: 'OK', transition: 'EXPIRED' });
  assert.equal(eng.view().frozen, 0);
  assert.equal(eng.view().available, 100);
  assert.equal(eng.view().expired, 60);
  const again = eng.submit({ type: 'expire', clientOpId: 'e3', clock: 7, parentId: 'a1' });
  assert.deepEqual(again, { status: 'IDEMPOTENT', transition: 'EXPIRED' });
});

test('PENDING -> FAILED on late capture; further ops on lapsed auth -> FROZEN', () => {
  const eng = new Engine({ initialBalance: 100 });
  eng.submit({ type: 'authorize', clientOpId: 'a1', clock: 1, amount: 60, ttl: 2 });
  const late = eng.submit({ type: 'capture', clientOpId: 'c1', clock: 5, parentId: 'a1', amount: 10 });
  assert.deepEqual(late, { status: 'ERROR', code: 'FROZEN' });
  assert.equal(eng.view().frozen, 0);
  assert.equal(eng.view().available, 100);
  const res = eng.submit({ type: 'reverse', clientOpId: 'r1', clock: 6, parentId: 'a1', amount: 10 });
  assert.deepEqual(res, { status: 'ERROR', code: 'FROZEN' });
  const exp = eng.submit({ type: 'expire', clientOpId: 'e1', clock: 7, parentId: 'a1' });
  assert.deepEqual(exp, { status: 'IDEMPOTENT', transition: 'FAILED' });
});

test('哈希链可验证且重放同终态: verify chain, replay log -> same tip', () => {
  const ops = [
    { type: 'deposit', clientOpId: 'd1', clock: 1, amount: 300 },
    { type: 'authorize', clientOpId: 'a1', clock: 2, amount: 120, ttl: 4 },
    { type: 'capture', clientOpId: 'c1', clock: 3, parentId: 'a1', amount: 70 },
    { type: 'reverse', clientOpId: 'r1', clock: 4, parentId: 'c1', amount: 20 },
    { type: 'expire', clientOpId: 'e1', clock: 8, parentId: 'a1' },
  ];
  const eng = new Engine({ initialBalance: 0 });
  for (const op of ops) eng.submit(op);
  assert.equal(verifyHashChain(eng.log, 0), true);

  // tamper detection
  const tampered = eng.log.map((e) => ({ ...e }));
  tampered[2] = { ...tampered[2], result: { ...tampered[2].result, captured: 71 } };
  assert.equal(verifyHashChain(tampered, 0), false);

  // replay from the log yields the same terminal state
  const replayed = new Engine({ initialBalance: 0 });
  replayed.load(eng.log.map((e) => e.op));
  assert.equal(replayed.tipHash, eng.tipHash);
  assert.deepEqual(replayed.view(), eng.view());
});
