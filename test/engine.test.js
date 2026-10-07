import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frac, eq } from '../src/fraction.js';
import { Engine } from '../src/engine.js';

function baseEngine() {
  const e = new Engine();
  e.setAccount('A', frac(10n)); // buyer
  e.setAccount('B', frac(0n)); // seller
  e.setAccount('C', frac(20n)); // second buyer
  e.setAccount('D', frac(0n)); // second seller
  e.setInstrument('X', frac(2n));
  e.setInstrument('Y', frac(3n));
  e.setOrder('O1', { account: 'A', side: 'buy', instrument: 'X', qty: 2n, limit: frac(3n) });
  e.setOrder('O2', { account: 'B', side: 'sell', instrument: 'X', qty: 2n, limit: frac(1n) });
  e.setOrder('O3', { account: 'C', side: 'buy', instrument: 'Y', qty: 2n, limit: frac(4n) });
  e.setOrder('O4', { account: 'D', side: 'sell', instrument: 'Y', qty: 2n, limit: frac(2n) });
  return e;
}

test('trial reports read set with base and object versions', () => {
  const e = baseEngine();
  const t = e.trial('W1');
  assert.ok(t.ok);
  assert.equal(t.volume, 4n);
  assert.equal(t.readSet.base, e.baseVersion);
  assert.deepEqual(t.readSet.orders, { O1: 1, O2: 1, O3: 1, O4: 1 });
  assert.deepEqual(t.readSet.accounts, { A: 1, B: 1, C: 1, D: 1 });
  assert.deepEqual(t.readSet.instruments, { X: 1, Y: 1 });
});

test('commit applies fills atomically and is idempotent per submit id', () => {
  const e = baseEngine();
  assert.ok(e.trial('W1').ok);
  const c1 = e.commit('W1', 'S1');
  assert.ok(c1.ok);
  const state1 = e.state();
  assert.equal(state1.accounts.A.funds.num, 6n); // 10 - 2*2 (buys 2 @ X=2)
  assert.equal(state1.accounts.C.funds.num, 14n); // 20 - 2*3 (buys 2 @ Y=3)
  assert.equal(state1.accounts.B.funds.num, 4n);
  assert.equal(state1.accounts.D.funds.num, 6n);
  const c2 = e.commit('W1', 'S1');
  assert.deepEqual(c2, c1, 'same submit id returns the stored response');
  const state2 = e.state();
  assert.deepEqual(state2.accounts, state1.accounts, 'no double debit on retry');
  assert.deepEqual(state2.orders, state1.orders, 'no double fill on retry');
});

test('stale read set blocks commit with E_STALE; disjoint windows commit', () => {
  const e2 = new Engine();
  e2.setAccount('A', frac(10n));
  e2.setAccount('B', frac(0n));
  e2.setInstrument('X', frac(2n));
  e2.setOrder('O1', { account: 'A', side: 'buy', instrument: 'X', qty: 2n, limit: frac(3n) });
  e2.setOrder('O2', { account: 'B', side: 'sell', instrument: 'X', qty: 2n, limit: frac(1n) });
  e2.setAccount('C', frac(20n));
  e2.setAccount('D', frac(0n));
  e2.setInstrument('Y', frac(3n));
  e2.setOrder('O3', { account: 'C', side: 'buy', instrument: 'Y', qty: 2n, limit: frac(4n) });
  e2.setOrder('O4', { account: 'D', side: 'sell', instrument: 'Y', qty: 2n, limit: frac(2n) });
  // Two windows scoped to disjoint instruments: disjoint read sets.
  const tx = e2.trial('WX', { instruments: ['X'] });
  const ty = e2.trial('WY', { instruments: ['Y'] });
  assert.ok(tx.ok && ty.ok);
  assert.deepEqual(Object.keys(tx.readSet.orders), ['O1', 'O2']);
  assert.deepEqual(Object.keys(ty.readSet.orders), ['O3', 'O4']);
  // WX commits first; WY's read set is disjoint and must still commit.
  assert.ok(e2.commit('WX', 'SX').ok);
  const cy = e2.commit('WY', 'SY');
  assert.ok(cy.ok, `disjoint commit failed: ${cy.error}`);
  // A trial whose read set intersects the committed objects goes stale.
  const e3 = new Engine();
  e3.setAccount('A', frac(10n));
  e3.setAccount('B', frac(0n));
  e3.setInstrument('X', frac(2n));
  e3.setOrder('O1', { account: 'A', side: 'buy', instrument: 'X', qty: 2n, limit: frac(3n) });
  e3.setOrder('O2', { account: 'B', side: 'sell', instrument: 'X', qty: 2n, limit: frac(1n) });
  const w1 = e3.trial('W1');
  const w2 = e3.trial('W2');
  assert.ok(w1.ok && w2.ok);
  assert.ok(e3.commit('W1', 'S1').ok);
  const stale = e3.commit('W2', 'S2');
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'E_STALE');
  assert.ok(stale.stale.length > 0);
  // Stale commit is idempotent too.
  assert.deepEqual(e3.commit('W2', 'S2'), stale);
  // A fresh trial on W2 reads the post-commit state and commits fine.
  const w2b = e3.trial('W2');
  assert.ok(w2b.ok);
  assert.equal(w2b.volume, 0n); // nothing left to clear
  assert.ok(e3.commit('W2', 'S3').ok);
});

test('base data correction stales dependent trials only', () => {
  const e = new Engine();
  e.setAccount('A', frac(10n));
  e.setAccount('B', frac(0n));
  e.setInstrument('X', frac(2n));
  e.setOrder('O1', { account: 'A', side: 'buy', instrument: 'X', qty: 2n, limit: frac(3n) });
  e.setOrder('O2', { account: 'B', side: 'sell', instrument: 'X', qty: 2n, limit: frac(1n) });
  const t = e.trial('W1');
  assert.ok(t.ok);
  // Price correction changes funds feasibility of later trials and stales
  // the old one.
  e.setInstrument('X', frac(5n, 2n));
  const stale = e.commit('W1', 'S1');
  assert.equal(stale.error, 'E_STALE');
  // A fresh trial sees the corrected price and can commit.
  const t2 = e.trial('W1');
  assert.ok(t2.ok);
  assert.ok(eq(t2.spend, frac(5n))); // 2 * 5/2
  assert.ok(e.commit('W1', 'S2').ok);
});

test('undo removes only uncommitted trials', () => {
  const e = baseEngine();
  assert.ok(e.trial('W1').ok);
  assert.ok(e.undo('W1').ok);
  assert.equal(e.commit('W1', 'S1').error, 'E_NO_TRIAL');
  assert.ok(e.trial('W2').ok);
  assert.ok(e.commit('W2', 'S2').ok);
  assert.equal(e.undo('W2').error, 'E_COMMITTED');
  assert.equal(e.undo('W3').error, 'E_NO_TRIAL');
});

test('sell proceeds become usable only after commit', () => {
  const e = new Engine();
  e.setAccount('B', frac(10n)); // buyer in X
  e.setAccount('S', frac(0n)); // seller in X, later buyer in Y
  e.setAccount('Q', frac(0n)); // seller in Y
  e.setInstrument('X', frac(2n));
  e.setInstrument('Y', frac(3n));
  e.setOrder('O1', { account: 'B', side: 'buy', instrument: 'X', qty: 2n, limit: frac(3n) });
  e.setOrder('O2', { account: 'S', side: 'sell', instrument: 'X', qty: 2n, limit: frac(1n) });
  e.setOrder('O3', { account: 'S', side: 'buy', instrument: 'Y', qty: 1n, limit: frac(5n) });
  e.setOrder('O4', { account: 'Q', side: 'sell', instrument: 'Y', qty: 1n, limit: frac(2n) });
  // Before W1 commits, S has no funds: the Y trial clears nothing.
  const early = e.trial('WY', { instruments: ['Y'] });
  assert.ok(early.ok);
  assert.equal(early.volume, 0n);
  assert.ok(e.trial('WX', { instruments: ['X'] }).ok);
  assert.ok(e.commit('WX', 'SX').ok);
  // The early trial is now stale (S's account version moved).
  assert.equal(e.commit('WY', 'SY').error, 'E_STALE');
  // A fresh trial can spend the proceeds: S earned 2*2=4 >= 3.
  const later = e.trial('WY', { instruments: ['Y'] });
  assert.ok(later.ok);
  assert.equal(later.volume, 1n);
  assert.ok(e.commit('WY', 'SY2').ok);
  const s = e.state();
  assert.equal(s.accounts.S.funds.num, 1n); // 4 - 3
});

test('compensation reverses a commit exactly once', () => {
  const e = baseEngine();
  assert.ok(e.trial('W1').ok);
  assert.ok(e.commit('W1', 'S1').ok);
  const before = e.state();
  const comp = e.compensate('W1', 'C1');
  assert.ok(comp.ok);
  const after = e.state();
  // Funds and remaining quantities are restored to the original values.
  assert.equal(after.accounts.A.funds.num, 10n);
  assert.equal(after.accounts.B.funds.num, 0n);
  assert.equal(after.orders.O1.remaining, 2n);
  assert.equal(after.orders.O2.remaining, 2n);
  assert.ok(after.orders.O1.version > before.orders.O1.version);
  // Same submit id: idempotent replay.
  assert.deepEqual(e.compensate('W1', 'C1'), comp);
  // A second, distinct compensation is rejected.
  assert.equal(e.compensate('W1', 'C2').error, 'E_ALREADY_COMPENSATED');
});

test('compensation fails atomically when seller cannot return proceeds', () => {
  const e = baseEngine();
  assert.ok(e.trial('W1').ok);
  assert.ok(e.commit('W1', 'S1').ok);
  const committed = e.state();
  // Seller B spent/lost the proceeds via a correction.
  e.setAccount('B', frac(1n));
  const comp = e.compensate('W1', 'C1');
  assert.equal(comp.ok, false);
  assert.equal(comp.error, 'E_FUNDS');
  const after = e.state();
  // Nothing moved: orders and buyer funds are untouched.
  assert.equal(after.orders.O1.remaining, committed.orders.O1.remaining);
  assert.equal(after.accounts.A.funds.num, committed.accounts.A.funds.num);
  assert.equal(after.accounts.B.funds.num, 1n);
});

test('compensation fails on conflicting later order state', () => {
  const e = baseEngine();
  assert.ok(e.trial('W1').ok);
  assert.ok(e.commit('W1', 'S1').ok);
  // Order corrected after the commit: compensation must conflict.
  e.setOrder('O1', { account: 'A', side: 'buy', instrument: 'X', qty: 5n, limit: frac(3n) });
  const comp = e.compensate('W1', 'C1');
  assert.equal(comp.ok, false);
  assert.equal(comp.error, 'E_CONFLICT');
});

test('committed fills are never silently altered by later corrections', () => {
  const e = baseEngine();
  assert.ok(e.trial('W1').ok);
  const c = e.commit('W1', 'S1');
  assert.ok(c.ok);
  const ser = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const fillsBefore = ser(c.fills);
  e.setInstrument('X', frac(9n)); // wild correction
  e.setAccount('A', frac(0n));
  const c2 = e.commit('W1', 'S1');
  assert.equal(ser(c2.fills), fillsBefore, 'committed fills unchanged');
});

test('verify endpoint validates the stored proof tree', () => {
  const e = baseEngine();
  assert.ok(e.trial('W1').ok);
  const v = e.verifyTrial('W1');
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(e.verifyTrial('NOPE').error, 'E_NO_TRIAL');
});
