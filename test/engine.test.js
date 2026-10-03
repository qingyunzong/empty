'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

const D1 = '2026-01-05'; // Monday
const D2 = '2026-01-06'; // Tuesday
const D3 = '2026-01-07'; // Wednesday

function fx(id, payCcy, payAmt, recvCcy, recvAmt, valueDate, maturity) {
  return { op: 'trade', id, payCcy, payAmt, recvCcy, recvAmt, valueDate, ...(maturity ? { maturity } : {}) };
}

function base() {
  const e = new Engine();
  e.apply('calendar', { version: 'v1', holidays: [] });
  return e;
}

test('holiday calendar switch cascades to subsequent value dates', () => {
  const e = base();
  e.apply('trade', fx('T1', 'EUR', 100, 'USD', 110, D1));
  e.apply('trade', fx('T2', 'USD', 110, 'EUR', 100, D1));
  e.apply('trade', fx('T3', 'EUR', 50, 'USD', 55, D2));
  let items = e.deliverables();
  assert.equal(items.filter((i) => i.status !== 'PENDING' || i.reason !== 'UNMATCHED').length, 2);
  assert.ok(items.every((i) => i.valueDate === D1 || i.reason === 'UNMATCHED'));

  const expBefore = e.exposureList();
  e.apply('calendar', { version: 'v2', holidays: [D1, D2] });

  items = e.deliverables();
  assert.ok(items.every((i) => i.valueDate === D3), 'all value dates shift to next business day');
  const keys = e.queueSnapshot().map((q) => q.key);
  assert.ok(keys.every((k) => k.endsWith(`|${D3}`) || k.endsWith(`|${D1}`) || k.endsWith(`|${D2}`)));
  const open = e.queueSnapshot().flatMap((q) => (q.key.endsWith(D3) ? q.open : []));
  assert.deepEqual(open, ['T3']);
  assert.deepEqual(e.exposureList(), expBefore);
  assert.deepEqual(e.exposureList(), [{ amount: 55, ccy: 'USD' }, { amount: -50, ccy: 'EUR' }].sort((a, b) => a.ccy.localeCompare(b.ccy)));
  assert.equal(e.proof().ok, true);
});

test('cancel of a paired trade unlocks both sides and generates compensation', () => {
  const e = base();
  e.apply('trade', fx('T1', 'EUR', 100, 'USD', 110, D1));
  e.apply('trade', fx('T2', 'USD', 110, 'EUR', 100, D1));
  assert.equal(e.trades.get('T1').status, 'PAIRED');

  const res = e.apply('cancel', { id: 'T1' });
  assert.equal(res.compensation.id, 'COMP-T1');
  assert.equal(res.compensation.reason, 'CANCEL_COMPENSATION');
  assert.deepEqual(res.compensation.legs, [
    { ccy: 'EUR', amount: -100 },
    { ccy: 'USD', amount: -110 },
  ]);
  assert.equal(e.trades.get('T2').status, 'OPEN');

  const items = e.deliverables();
  assert.equal(items.length, 1);
  assert.equal(items[0].tradeId, 'T2');
  assert.equal(items[0].status, 'PENDING');
  assert.equal(items[0].reason, 'UNMATCHED');
  assert.deepEqual(e.exposureList(), [
    { ccy: 'EUR', amount: 100 },
    { ccy: 'USD', amount: -110 },
  ]);
});

test('empty queue boundary conditions', () => {
  const e = base();
  assert.deepEqual(e.deliverables(), []);
  assert.deepEqual(e.exposureList(), []);
  assert.deepEqual(e.queueSnapshot(), []);
  assert.equal(e.proof().ok, true);
  assert.throws(() => e.apply('cancel', { id: 'NOPE' }), /unknown trade/);
  assert.throws(() => e.apply('delay', { id: 'NOPE', valueDate: D1 }), /unknown trade/);
  e.apply('liquidity', { ccy: 'EUR', amount: 1000 });
  assert.deepEqual(e.deliverables(), []);
  const en = new Engine();
  assert.throws(() => en.apply('trade', fx('T1', 'EUR', 1, 'USD', 1, D1)), /no calendar/);
});

test('deliverable tie-break: same value date and currency ordered by maturity then id', () => {
  const e = base();
  e.apply('trade', fx('T1', 'EUR', 10, 'USD', 11, D1, `${D1}T10:00:00.000Z`));
  e.apply('trade', fx('T2', 'USD', 11, 'EUR', 10, D1, `${D1}T10:00:00.000Z`));
  e.apply('trade', fx('A9', 'EUR', 20, 'USD', 22, D1, `${D1}T09:00:00.000Z`));
  e.apply('trade', fx('A8', 'USD', 22, 'EUR', 20, D1, `${D1}T09:00:00.000Z`));
  e.apply('trade', fx('B1', 'EUR', 30, 'USD', 33, D1, `${D1}T09:00:00.000Z`));
  e.apply('trade', fx('B2', 'USD', 33, 'EUR', 30, D1, `${D1}T09:00:00.000Z`));
  const eur = e.deliverables().filter((i) => i.ccy === 'EUR');
  assert.deepEqual(eur.map((i) => i.tradeId), ['A9', 'B1', 'T1']);
});

test('insufficient liquidity yields PENDING with reason, never a failure', () => {
  const e = base();
  e.apply('trade', fx('T1', 'EUR', 100, 'USD', 110, D1));
  e.apply('trade', fx('T2', 'USD', 110, 'EUR', 100, D1));
  e.apply('liquidity', { ccy: 'EUR', amount: 40 });
  e.apply('liquidity', { ccy: 'USD', amount: 200 });
  const items = e.deliverables();
  const t1 = items.find((i) => i.tradeId === 'T1');
  const t2 = items.find((i) => i.tradeId === 'T2');
  assert.equal(t1.status, 'PENDING');
  assert.equal(t1.reason, 'INSUFFICIENT_LIQUIDITY:EUR');
  assert.equal(t2.status, 'DELIVERABLE');
  e.apply('liquidity', { ccy: 'EUR', amount: 100 });
  assert.equal(e.deliverables().find((i) => i.tradeId === 'T1').status, 'DELIVERABLE');
});

test('reprice updates exposure differentially', () => {
  const e = base();
  e.apply('trade', fx('T1', 'EUR', 100, 'USD', 110, D1));
  assert.deepEqual(e.exposureList(), [
    { ccy: 'EUR', amount: -100 },
    { ccy: 'USD', amount: 110 },
  ]);
  e.apply('reprice', { id: 'T1', rate: 1.25 });
  assert.deepEqual(e.exposureList(), [
    { ccy: 'EUR', amount: -100 },
    { ccy: 'USD', amount: 125 },
  ]);
});

test('delay moves trade between value-date queues and unpairs', () => {
  const e = base();
  e.apply('trade', fx('T1', 'EUR', 100, 'USD', 110, D1));
  e.apply('trade', fx('T2', 'USD', 110, 'EUR', 100, D1));
  assert.equal(e.trades.get('T1').status, 'PAIRED');
  const res = e.apply('delay', { id: 'T1', valueDate: D2 });
  assert.equal(res.valueDate, D2);
  assert.equal(e.trades.get('T1').status, 'OPEN');
  assert.equal(e.trades.get('T2').status, 'OPEN');
  const snap = Object.fromEntries(e.queueSnapshot().map((q) => [q.key, q.open]));
  assert.deepEqual(snap[`EUR/USD|${D1}`], ['T2']);
  assert.deepEqual(snap[`EUR/USD|${D2}`], ['T1']);
});

test('proof replays deterministically after a mixed op sequence', () => {
  const e = base();
  e.apply('trade', fx('T1', 'EUR', 100, 'USD', 110, D1));
  e.apply('trade', fx('T2', 'USD', 110, 'EUR', 100, D1));
  e.apply('trade', fx('T3', 'EUR', 40, 'USD', 44, D2));
  e.apply('cancel', { id: 'T1' });
  e.apply('delay', { id: 'T3', valueDate: D1 });
  e.apply('reprice', { id: 'T2', rate: 1.2 });
  e.apply('calendar', { version: 'v2', holidays: [D2] });
  e.apply('liquidity', { ccy: 'USD', amount: 50 });
  const pr = e.proof();
  assert.equal(pr.ok, true);
  assert.equal(pr.events, e.journal.length);
  assert.equal(Engine.replay(e.journal).stateHash(), e.stateHash());
});
