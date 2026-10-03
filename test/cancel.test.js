'use strict';
// Acceptance 2: partial and full cancellation of paired trades unlocks both
// sides and records compensation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, applyEvent, deliverableReport, exposureReport } = require('../src/engine');

function pairedState() {
  const s = createState();
  applyEvent(s, { type: 'trade', id: 'A', pair: 'EUR/USD', amount: 100, rate: 2, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' });
  applyEvent(s, { type: 'trade', id: 'B', pair: 'EUR/USD', amount: 50, rate: 2, valueDate: '2026-10-05', maturity: '2026-10-05T10:00:00Z' });
  applyEvent(s, { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 200 });
  return s; // A covered (200 USD), B pending (needs 100 more)
}

test('partial cancel generates compensation and keeps trade paired', () => {
  const s = pairedState();
  applyEvent(s, { type: 'cancel', id: 'A', amount: 40 });
  assert.equal(s.compensations.length, 1);
  const comp = s.compensations[0];
  assert.equal(comp.for, 'A');
  assert.equal(comp.portion, 40);
  // compensation reverses the cancelled legs: +40 EUR (deliver back), -80 USD
  assert.deepEqual(comp.legs, [{ ccy: 'EUR', amount: 40 }, { ccy: 'USD', amount: -80 }]);

  const rep = deliverableReport(s);
  const a = rep.trades.find((t) => t.id === 'A');
  assert.equal(a.status, 'DELIVERABLE');
  assert.deepEqual(a.legs, [{ ccy: 'EUR', amount: -60 }, { ccy: 'USD', amount: 120 }]);
  // freed 80 USD, but B still needs 100 -> stays pending with reduced deficit
  const b = rep.trades.find((t) => t.id === 'B');
  assert.equal(b.status, 'PENDING');
  assert.equal(b.reason.deficit, 20);
});

test('full cancel unlocks both sides and pairs the next trade in queue', () => {
  const s = pairedState();
  applyEvent(s, { type: 'cancel', id: 'A' });
  assert.equal(s.compensations.length, 1);
  assert.equal(s.compensations[0].portion, 100);
  const rep = deliverableReport(s);
  assert.equal(rep.trades.length, 1); // A fully removed from active set
  assert.equal(rep.trades[0].id, 'B');
  assert.equal(rep.trades[0].status, 'DELIVERABLE'); // liquidity unlocked
  const exp = exposureReport(s);
  assert.deepEqual(exp.nets, { 'EUR/USD@2026-10-05': 50 });
  assert.deepEqual(exp.pending, {});
});

test('cancel validation: unknown, over-amount, double cancel', () => {
  const s = pairedState();
  assert.throws(() => applyEvent(s, { type: 'cancel', id: 'ZZ' }), /unknown trade/);
  assert.throws(() => applyEvent(s, { type: 'cancel', id: 'A', amount: 101 }), /exceeds remaining/);
  applyEvent(s, { type: 'cancel', id: 'A' });
  assert.throws(() => applyEvent(s, { type: 'cancel', id: 'A' }), /fully cancelled/);
});
