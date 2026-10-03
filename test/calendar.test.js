'use strict';
// Acceptance 1: holiday calendar version switch cascades across value-date queues.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, applyEvent, deliverableReport, exposureReport } = require('../src/engine');

function baseState() {
  const s = createState();
  // T1 delivers 200 USD on 2026-10-05 (Mon), earlier maturity than T2.
  applyEvent(s, { type: 'trade', id: 'T1', pair: 'EUR/USD', amount: 100, rate: 2, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' });
  // T2 delivers 150 USD on 2026-10-06 (Tue).
  applyEvent(s, { type: 'trade', id: 'T2', pair: 'EUR/USD', amount: 75, rate: 2, valueDate: '2026-10-06', maturity: '2026-10-06T09:00:00Z' });
  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 200 });
  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-06', amount: 200 });
  return s;
}

const statusOf = (rep, id) => rep.trades.find((t) => t.id === id);

test('calendar switch rolls trades forward and invalidates later queues', () => {
  const s = baseState();
  let rep = deliverableReport(s);
  assert.equal(statusOf(rep, 'T1').status, 'DELIVERABLE');
  assert.equal(statusOf(rep, 'T1').date, '2026-10-05');
  assert.equal(statusOf(rep, 'T2').status, 'DELIVERABLE');
  assert.equal(statusOf(rep, 'T2').date, '2026-10-06');

  // Calendar v1 declares 2026-10-05 a holiday: T1 rolls to 10-06, lands ahead of
  // T2 (earlier maturity) and consumes the 200 USD there -> T2 invalidated.
  applyEvent(s, { type: 'calendar', version: 1, holidays: ['2026-10-05'] });
  rep = deliverableReport(s);
  assert.equal(statusOf(rep, 'T1').date, '2026-10-06');
  assert.equal(statusOf(rep, 'T1').status, 'DELIVERABLE');
  assert.equal(statusOf(rep, 'T2').status, 'PENDING');
  assert.deepEqual(statusOf(rep, 'T2').reason, {
    reason: 'INSUFFICIENT_LIQUIDITY', ccy: 'USD', date: '2026-10-06', deficit: 150,
  });

  // Exposure moves differentially to the new value date.
  const exp = exposureReport(s);
  assert.deepEqual(exp.nets, { 'EUR/USD@2026-10-06': 175 });
  assert.deepEqual(exp.pending, { EUR: -75, USD: 150 });

  // Calendar v2 also closes 10-06: both roll to 10-07, no liquidity there.
  applyEvent(s, { type: 'calendar', version: 2, holidays: ['2026-10-05', '2026-10-06'] });
  rep = deliverableReport(s);
  assert.equal(statusOf(rep, 'T1').date, '2026-10-07');
  assert.equal(statusOf(rep, 'T1').status, 'PENDING');
  assert.equal(statusOf(rep, 'T2').status, 'PENDING');
});

test('calendar versions must increase', () => {
  const s = baseState();
  applyEvent(s, { type: 'calendar', version: 1, holidays: [] });
  assert.throws(() => applyEvent(s, { type: 'calendar', version: 1, holidays: [] }), /version must increase/);
});
