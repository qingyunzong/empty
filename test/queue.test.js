'use strict';
// Acceptance 3: empty-queue boundaries, tiebreak ordering, PENDING semantics.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, applyEvent, deliverableReport, exposureReport, proofReport } = require('../src/engine');

test('empty state and liquidity-only queues are well-defined', () => {
  const s = createState();
  let rep = deliverableReport(s);
  assert.deepEqual(rep.trades, []);
  assert.deepEqual(exposureReport(s), { type: 'exposure', nets: {}, pending: {} });
  assert.equal(proofReport(s).events, 0);

  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 1000 });
  rep = deliverableReport(s);
  assert.deepEqual(rep.trades, []); // liquidity with empty queue: nothing to pair
});

test('weekend value date rolls to Monday (fixed UTC calendar)', () => {
  const s = createState();
  applyEvent(s, { type: 'trade', id: 'W', pair: 'EUR/USD', amount: 10, rate: 1, valueDate: '2026-10-04', maturity: '2026-10-04T09:00:00Z' }); // Sunday
  const rep = deliverableReport(s);
  assert.equal(rep.trades[0].date, '2026-10-05');
});

test('tiebreak: same date and currency, maturity first then id', () => {
  const s = createState();
  // Same maturity, same bucket; liquidity covers exactly one deliver leg.
  applyEvent(s, { type: 'trade', id: 'T9', pair: 'EUR/USD', amount: 10, rate: 10, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' });
  applyEvent(s, { type: 'trade', id: 'T1', pair: 'EUR/USD', amount: 10, rate: 10, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' });
  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 100 });
  let rep = deliverableReport(s);
  assert.equal(rep.trades.find((t) => t.id === 'T1').status, 'DELIVERABLE'); // id wins
  assert.equal(rep.trades.find((t) => t.id === 'T9').status, 'PENDING');

  // Earlier maturity beats smaller id.
  const s2 = createState();
  applyEvent(s2, { type: 'trade', id: 'T1', pair: 'EUR/USD', amount: 10, rate: 10, valueDate: '2026-10-05', maturity: '2026-10-05T11:00:00Z' });
  applyEvent(s2, { type: 'trade', id: 'T9', pair: 'EUR/USD', amount: 10, rate: 10, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' });
  applyEvent(s2, { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 100 });
  rep = deliverableReport(s2);
  assert.equal(rep.trades.find((t) => t.id === 'T9').status, 'DELIVERABLE');
  assert.equal(rep.trades.find((t) => t.id === 'T1').status, 'PENDING');
});

test('pending liquidity is not a failure: PENDING with retained reason', () => {
  const s = createState();
  applyEvent(s, { type: 'trade', id: 'P', pair: 'EUR/USD', amount: 100, rate: 2, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' });
  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 120 });
  const rep = deliverableReport(s);
  const t = rep.trades[0];
  assert.equal(t.status, 'PENDING');
  assert.deepEqual(t.reason, { reason: 'INSUFFICIENT_LIQUIDITY', ccy: 'USD', date: '2026-10-05', deficit: 80 });
  // reason clears once liquidity arrives; delay/reprice re-evaluate queues
  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 80 });
  assert.equal(deliverableReport(s).trades[0].status, 'DELIVERABLE');
});

test('delay and reprice move exposure between queues', () => {
  const s = createState();
  applyEvent(s, { type: 'trade', id: 'D', pair: 'EUR/USD', amount: 100, rate: 2, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' });
  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-07', amount: 500 });
  applyEvent(s, { type: 'delay', id: 'D', valueDate: '2026-10-07' });
  assert.equal(deliverableReport(s).trades[0].date, '2026-10-07');
  assert.equal(deliverableReport(s).trades[0].status, 'DELIVERABLE');
  applyEvent(s, { type: 'reprice', id: 'D', rate: 6 });
  const rep = deliverableReport(s);
  assert.equal(rep.trades[0].status, 'PENDING'); // 600 needed, 500 available
  assert.equal(rep.trades[0].reason.deficit, 100);
});
