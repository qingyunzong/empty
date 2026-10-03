import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, UnknownOrigError } from '../src/engine.js';
import { frame } from '../testutil/sign.mjs';

function run(frames, config) {
  const e = new Engine(config);
  for (const f of frames) e.apply(f);
  return e;
}

test('acceptance 1: amend may never cross the already-filled part', () => {
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 105, seq: 1 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 40, price: 100, seq: 2 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 3 }),
    frame({ op: 'amend', clOrdId: 'A1', origId: 'B1', qty: 30, seq: 4 }), // 30 < filled 40 -> reject
    frame({ op: 'amend', clOrdId: 'A2', origId: 'B1', qty: 50, seq: 5 }), // ok: remaining 10
  ]);
  const rej = e.events.find((ev) => ev.type === 'rejected');
  assert.equal(rej.reason, 'amendCrossesFilled');
  assert.equal(rej.filled, 40);
  const b1 = e.orders.get('B1');
  assert.equal(b1.filled, 40);
  assert.equal(b1.qty, 50);
  assert.equal(b1.remaining, 10);
  // filled part untouched by both amends
  const trade = e.events.find((ev) => ev.type === 'trade');
  assert.equal(trade.qty, 40);
  assert.equal(trade.price, 105); // maker = earlier resting buy
});

test('acceptance 2: cancel vs match at the same tick is decided by log order (seq)', () => {
  // cancel first (lower seq) -> match finds nothing
  const e1 = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 100, seq: 1, ts: 10 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 100, price: 100, seq: 2, ts: 10 }),
    frame({ op: 'cancel', clOrdId: 'C1', origId: 'B1', seq: 3, ts: 20 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 4, ts: 20 }),
  ]);
  assert.equal(e1.events.filter((ev) => ev.type === 'trade').length, 0);
  assert.equal(e1.orders.get('B1').state, 'canceled');

  // match first (lower seq) -> trade happens, cancel then rejected
  const e2 = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 100, seq: 1, ts: 10 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 100, price: 100, seq: 2, ts: 10 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 3, ts: 20 }),
    frame({ op: 'cancel', clOrdId: 'C1', origId: 'B1', seq: 4, ts: 20 }),
  ]);
  assert.equal(e2.events.filter((ev) => ev.type === 'trade').length, 1);
  const rej = e2.events.find((ev) => ev.type === 'rejected');
  assert.equal(rej.op, 'cancel');
  assert.equal(rej.reason, 'orderNotOpen');
});

test('acceptance 3: cash sufficient but securities short -> whole pairing rejected, no unilateral debit', () => {
  const config = { accounts: { A: { cash: 1000, sec: 0 }, B: { cash: 0, sec: 0 } } };
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, acct: 'A', seq: 1 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 10, price: 90, acct: 'B', seq: 2 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 3 }),
  ], config);
  const rej = e.events.find((ev) => ev.type === 'matchRejected');
  assert.equal(rej.reason, 'insufficientSecurities');
  assert.equal(e.events.filter((ev) => ev.type === 'trade').length, 0);
  // neither side debited
  const a = e.acct('A');
  const b = e.acct('B');
  assert.deepEqual([a.cashAvail, a.cashFrozen], [1000, 0]);
  assert.deepEqual([b.secAvail, b.secFrozen], [0, 0]);
});

test('acceptance 3b: cash short -> rejected, securities untouched', () => {
  const config = { accounts: { A: { cash: 500, sec: 0 }, B: { cash: 0, sec: 100 } } };
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, acct: 'A', seq: 1 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 10, price: 90, acct: 'B', seq: 2 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 3 }),
  ], config);
  assert.equal(e.events.find((ev) => ev.type === 'matchRejected').reason, 'insufficientCash');
  assert.equal(e.acct('B').secAvail, 100);
  assert.equal(e.acct('A').cashAvail, 500);
});

test('acceptance 4: matching-window timeout releases the unmatched remainder', () => {
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 100, seq: 1, ts: 0 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 2, ts: 5 }), // nothing to match
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 100, price: 100, seq: 3, ts: 20 }), // B1 expires first (20-0 >= 10)
    frame({ op: 'match', clOrdId: 'M2', seq: 4, ts: 21 }),
  ], { window: 10 });
  const exp = e.events.find((ev) => ev.type === 'expired');
  assert.equal(exp.clOrdId, 'B1');
  assert.equal(exp.released, 100);
  assert.equal(e.orders.get('B1').state, 'expired');
  assert.equal(e.events.filter((ev) => ev.type === 'trade').length, 0);
});

test('partial fills and remaining quantities', () => {
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 100, seq: 1 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 30, price: 95, seq: 2 }),
    frame({ op: 'new', clOrdId: 'S2', side: 'sell', qty: 50, price: 100, seq: 3 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 4 }),
  ]);
  const trades = e.events.filter((ev) => ev.type === 'trade');
  assert.equal(trades.length, 2); // S1 (better price) first, then S2
  assert.deepEqual(trades.map((t) => [t.sellId, t.qty]), [['S1', 30], ['S2', 50]]);
  assert.equal(e.orders.get('B1').remaining, 20);
  assert.equal(e.orders.get('S1').state, 'filled');
  assert.equal(e.orders.get('S2').state, 'filled');
});

test('priority: price, then time, then clOrdId for same price same tick', () => {
  const e = run([
    frame({ op: 'new', clOrdId: 'B2', side: 'buy', qty: 10, price: 100, seq: 1, ts: 5 }),
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, seq: 2, ts: 5 }), // same price+ts -> clOrdId wins
    frame({ op: 'new', clOrdId: 'B3', side: 'buy', qty: 10, price: 101, seq: 3, ts: 9 }), // best price wins despite latest
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 25, price: 100, seq: 4, ts: 10 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 5, ts: 11 }),
  ]);
  const trades = e.events.filter((ev) => ev.type === 'trade');
  assert.deepEqual(trades.map((t) => [t.buyId, t.qty]), [['B3', 10], ['B1', 10], ['B2', 5]]);
});

test('price amend loses time priority, qty-only amend keeps it', () => {
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, seq: 1, ts: 0 }),
    frame({ op: 'new', clOrdId: 'B2', side: 'buy', qty: 10, price: 100, seq: 2, ts: 1 }),
    frame({ op: 'amend', clOrdId: 'A1', origId: 'B1', price: 100, qty: 10, seq: 3, ts: 2 }), // qty-only: keeps ts 0
    frame({ op: 'amend', clOrdId: 'A2', origId: 'B2', price: 100, seq: 4, ts: 3 }), // no-op price, keeps ts 1
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 10, price: 100, seq: 5, ts: 4 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 6, ts: 5 }),
  ]);
  assert.equal(e.events.find((ev) => ev.type === 'trade').buyId, 'B1');

  const e2 = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, seq: 1, ts: 0 }),
    frame({ op: 'new', clOrdId: 'B2', side: 'buy', qty: 10, price: 100, seq: 2, ts: 1 }),
    frame({ op: 'amend', clOrdId: 'A1', origId: 'B1', price: 101, seq: 3, ts: 2 }), // price change -> prio reset to ts 2
    frame({ op: 'amend', clOrdId: 'A2', origId: 'B1', price: 100, seq: 4, ts: 3 }), // back to 100, prio ts 3 (behind B2)
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 10, price: 100, seq: 5, ts: 4 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 6, ts: 5 }),
  ]);
  assert.equal(e2.events.find((ev) => ev.type === 'trade').buyId, 'B2');
});

test('settle finalizes; afterwards only fail compensation, never unbooking', () => {
  const config = { accounts: { A: { cash: 10000, sec: 0 }, B: { cash: 0, sec: 100 } } };
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, acct: 'A', seq: 1 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 10, price: 100, acct: 'B', seq: 2 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 3 }),
    frame({ op: 'settle', clOrdId: 'ST1', origId: 'T1', seq: 4 }),
    frame({ op: 'settle', clOrdId: 'ST2', origId: 'T1', seq: 5 }), // rejected: already settled
    frame({ op: 'fail', clOrdId: 'F1', origId: 'T1', seq: 6 }),
    frame({ op: 'fail', clOrdId: 'F2', origId: 'T1', seq: 7 }), // rejected: already compensated
  ], config);
  const rej = e.events.filter((ev) => ev.type === 'rejected').map((ev) => ev.reason);
  assert.deepEqual(rej, ['tradeNotMatched', 'tradeNotSettled']);
  const comp = e.events.find((ev) => ev.type === 'compensated');
  assert.equal(comp.tradeId, 'T1');
  assert.equal(comp.amount, 1000);
  // compensation returned both legs; original trade record still in the log
  const a = e.acct('A');
  const b = e.acct('B');
  assert.deepEqual([a.cashAvail, a.secAvail], [10000, 0]);
  assert.deepEqual([b.cashAvail, b.secAvail], [0, 100]);
  assert.equal(e.events.filter((ev) => ev.type === 'trade').length, 1);
  assert.equal(e.trades.get('T1').state, 'compensated');
});

test('fail on a matched-but-unsettled trade is rejected', () => {
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, seq: 1 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 10, price: 100, seq: 2 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 3 }),
    frame({ op: 'fail', clOrdId: 'F1', origId: 'T1', seq: 4 }),
  ]);
  assert.equal(e.events.find((ev) => ev.type === 'rejected').reason, 'tradeNotSettled');
});

test('unknown origId throws UnknownOrigError (exit 3 path)', () => {
  const e = new Engine();
  assert.throws(() => e.apply(frame({ op: 'cancel', clOrdId: 'C1', origId: 'NOPE', seq: 1 })), UnknownOrigError);
  assert.throws(() => e.apply(frame({ op: 'settle', clOrdId: 'S1', origId: 'T99', seq: 2 })), UnknownOrigError);
  assert.throws(() => e.apply(frame({ op: 'amend', clOrdId: 'A1', origId: 'NOPE', qty: 1, seq: 3 })), UnknownOrigError);
});

test('freeze events carry balances for configured accounts', () => {
  const config = { accounts: { A: { cash: 10000, sec: 0 }, B: { cash: 0, sec: 100 } } };
  const e = run([
    frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 10, price: 100, acct: 'A', seq: 1 }),
    frame({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 10, price: 100, acct: 'B', seq: 2 }),
    frame({ op: 'match', clOrdId: 'M1', seq: 3 }),
  ], config);
  const freezes = e.events.filter((ev) => ev.type === 'freeze');
  assert.equal(freezes.length, 2);
  assert.deepEqual(freezes[0].balances, { cashAvail: 9000, cashFrozen: 1000, secAvail: 0, secFrozen: 0 });
  assert.deepEqual(freezes[1].balances, { cashAvail: 0, cashFrozen: 0, secAvail: 90, secFrozen: 10 });
});
