import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const P = (n, d = 1) => ({ num: n, den: d });

function baseEngine() {
  const e = new Engine();
  e.setAccount({ id: 'A', funds: P(100) });
  e.setAccount({ id: 'B', funds: P(0) });
  e.setAccount({ id: 'C', funds: P(100) });
  e.setAccount({ id: 'D', funds: P(0) });
  e.setOrder({ id: 'o1', account: 'A', symbol: 'X', side: 'buy', qty: 2, limit: P(5) });
  e.setOrder({ id: 'o2', account: 'B', symbol: 'X', side: 'sell', qty: 2, limit: P(3) });
  e.setOrder({ id: 'o3', account: 'C', symbol: 'Y', side: 'buy', qty: 2, limit: P(5) });
  e.setOrder({ id: 'o4', account: 'D', symbol: 'Y', side: 'sell', qty: 2, limit: P(3) });
  return e;
}

test('commit applies fills atomically and is idempotent per commit id', () => {
  const e = baseEngine();
  const t = e.trial({ window: 'w1', prices: { X: P(4) } });
  assert.equal(t.result.qty, 2n);
  const c = e.commit({ id: 'c1', trial: t.trialId });
  assert.equal(c.status, 'committed');
  const st = e.state();
  assert.deepEqual(st.accounts.A.funds, { num: 92n, den: 1n });
  assert.deepEqual(st.accounts.B.funds, { num: 8n, den: 1n });
  assert.equal(st.orders.o1.qty, 0n);
  assert.equal(st.orders.o2.qty, 0n);
  // Same commit id + same trial: idempotent replay, no double apply.
  const again = e.commit({ id: 'c1', trial: t.trialId });
  assert.equal(again.idempotent, true);
  assert.deepEqual(e.state().accounts.A.funds, { num: 92n, den: 1n });
  // Same commit id + different trial: conflict.
  const t2 = e.trial({ window: 'w2', prices: { X: P(4) } });
  assert.throws(() => e.commit({ id: 'c1', trial: t2.trialId }), /E_CONFLICT/);
});

test('disjoint windows commit; overlapping read sets go E_STALE', () => {
  const e = baseEngine();
  const t1 = e.trial({ window: 'w1', prices: { X: P(4) } });
  const t2 = e.trial({ window: 'w2', prices: { Y: P(4) } });
  const t3 = e.trial({ window: 'w3', prices: { X: P(4) } }); // same read set as t1
  e.commit({ id: 'c1', trial: t1.trialId });
  // Disjoint window untouched: still committable.
  const c2 = e.commit({ id: 'c2', trial: t2.trialId });
  assert.equal(c2.status, 'committed');
  // Overlapping trial read o1/o2 at old versions: stale.
  assert.throws(() => e.commit({ id: 'c3', trial: t3.trialId }), /E_STALE/);
});

test('corrections stale exactly the trials that read the changed object', () => {
  const e = baseEngine();
  const t = e.trial({ window: 'w1', prices: { Y: P(4) } });
  // Seller account D is not in the read set (funds never read by the solver).
  e.correctAccount({ id: 'D', funds: P(7) });
  const ok = e.commit({ id: 'c1', trial: t.trialId });
  assert.equal(ok.status, 'committed');

  const t2 = e.trial({ window: 'w2', prices: { Y: P(4) } });
  e.correctAccount({ id: 'C', funds: P(50) }); // buyer account: read dependency
  assert.throws(() => e.commit({ id: 'c2', trial: t2.trialId }), /E_STALE/);

  const t3 = e.trial({ window: 'w3', prices: { Y: P(4) } });
  e.correctOrder({ id: 'o4', limit: P(2) }); // order in the read set
  assert.throws(() => e.commit({ id: 'c3', trial: t3.trialId }), /E_STALE/);
});

test('undo removes only uncommitted trials', () => {
  const e = baseEngine();
  const t = e.trial({ window: 'w1', prices: { X: P(4) } });
  e.undo({ trial: t.trialId });
  assert.throws(() => e.commit({ id: 'c1', trial: t.trialId }), /E_NOT_FOUND/);
  const t2 = e.trial({ window: 'w2', prices: { X: P(4) } });
  e.commit({ id: 'c2', trial: t2.trialId });
  assert.throws(() => e.undo({ trial: t2.trialId }), /E_STATE/);
});

test('compensation reverses once; duplicates and conflicts fail atomically', () => {
  const e = new Engine();
  e.setAccount({ id: 'A', funds: P(100) });
  e.setAccount({ id: 'B', funds: P(0) });
  e.setOrder({ id: 'o1', account: 'A', symbol: 'X', side: 'buy', qty: 2, limit: P(5) });
  e.setOrder({ id: 'o2', account: 'B', symbol: 'X', side: 'sell', qty: 2, limit: P(3) });
  const t = e.trial({ window: 'w1', prices: { X: P(4) } });
  e.commit({ id: 'k1', trial: t.trialId });
  assert.deepEqual(e.state().accounts.A.funds, { num: 92n, den: 1n });

  const r = e.compensate({ id: 'r1', commit: 'k1' });
  assert.equal(r.status, 'compensated');
  assert.deepEqual(e.state().accounts.A.funds, { num: 100n, den: 1n });
  assert.deepEqual(e.state().accounts.B.funds, { num: 0n, den: 1n });
  assert.equal(e.state().orders.o1.qty, 2n);
  // Same compensation id replays idempotently; a new id cannot reverse twice.
  assert.equal(e.compensate({ id: 'r1', commit: 'k1' }).idempotent, true);
  assert.throws(() => e.compensate({ id: 'r2', commit: 'k1' }), /E_ALREADY_COMPENSATED/);

  // Fresh commit, then seller cannot return proceeds -> whole compensation fails.
  const t2 = e.trial({ window: 'w2', prices: { X: P(4) } });
  e.commit({ id: 'k2', trial: t2.trialId });
  e.correctAccount({ id: 'B', funds: P(0) }); // drain seller below proceeds
  assert.throws(() => e.compensate({ id: 'r3', commit: 'k2' }), /E_FUNDS/);
  const st = e.state();
  assert.deepEqual(st.accounts.A.funds, { num: 92n, den: 1n }); // unchanged
  assert.equal(st.orders.o1.qty, 0n); // unchanged

  // Order state changed after commit -> conflict, still atomic.
  e.correctAccount({ id: 'B', funds: P(100) });
  e.correctOrder({ id: 'o1', limit: P(6) });
  assert.throws(() => e.compensate({ id: 'r4', commit: 'k2' }), /E_CONFLICT/);
  assert.equal(e.state().orders.o2.qty, 0n);
});

test('sell proceeds become spendable only after commit, in later windows', () => {
  const e = new Engine();
  e.setAccount({ id: 'A', funds: P(0) });
  e.setAccount({ id: 'B', funds: P(0) });
  e.setAccount({ id: 'C', funds: P(100) });
  e.setOrder({ id: 'o1', account: 'A', symbol: 'X', side: 'sell', qty: 2, limit: P(3) });
  e.setOrder({ id: 'o2', account: 'C', symbol: 'X', side: 'buy', qty: 2, limit: P(5) });
  e.setOrder({ id: 'o3', account: 'A', symbol: 'Y', side: 'buy', qty: 2, limit: P(5) });
  e.setOrder({ id: 'o4', account: 'B', symbol: 'Y', side: 'sell', qty: 2, limit: P(3) });
  // Same window: A's sale proceeds are not yet available; funds 0 -> no buy.
  const t1 = e.trial({ window: 'w1', prices: { X: P(4), Y: P(4) } });
  assert.equal(t1.fills.o1, 2n); // the sale itself happens
  assert.equal(t1.fills.o3 ?? 0n, 0n);
  e.commit({ id: 'c1', trial: t1.trialId });
  assert.deepEqual(e.state().accounts.A.funds, { num: 8n, den: 1n });
  // Later window: the committed proceeds are spendable.
  const t2 = e.trial({ window: 'w2', prices: { Y: P(4) } });
  assert.equal(t2.fills.o3, 2n);
  e.commit({ id: 'c2', trial: t2.trialId });
  assert.deepEqual(e.state().accounts.A.funds, { num: 0n, den: 1n });
});

test('trial reports base version and read dependencies', () => {
  const e = baseEngine();
  const before = e.baseVersion;
  const t = e.trial({ window: 'w1', prices: { X: P(4) } });
  assert.equal(t.baseVersion, before);
  assert.deepEqual(Object.keys(t.reads.orders).sort(), ['o1', 'o2']);
  assert.deepEqual(Object.keys(t.reads.accounts), ['A']);
  const check = e.checkTrial({ trial: t.trialId });
  assert.ok(check.ok, check.errors.join('; '));
});
