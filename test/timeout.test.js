'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/sim');

const L = (lineNo, amount, currency, direction) => ({ lineNo, amount, currency, direction });

test('acceptance 3: virtual clock timeout aborts the whole batch and unfreezes', () => {
  const engine = new Engine({ rtoMs: 100 });
  engine.submit({
    batch: 1, timeoutMs: 1000,
    lines: [L(1, '100.00', 'USD', 'pay'), L(2, '200.00', 'USD', 'pay')],
  });
  assert.equal(engine.result().frozen, '300.00');

  engine.pump({ drop: ['1:2'] }); // batch never completes
  assert.equal(engine.result().lines[0].state, 'ACKED');
  assert.equal(engine.result().frozen, '300.00');

  engine.tick(1000); // hits the batch deadline
  const r = engine.result();
  assert.equal(r.batches[0].state, 'ABORTED');
  assert.equal(r.frozen, '0.00');
  assert.equal(r.lines[0].state, 'OPEN'); // rolled back, resubmittable
  const abort = engine.ledger.audit.find((e) => e.kind === 'abort');
  assert.equal(abort.unfrozen, '300.00');
  assert.equal(r.audit.valid, true);

  // Late retransmissions for the aborted batch are ignored.
  engine.tick(10000);
  engine.pump();
  assert.equal(engine.result().lines[0].state, 'OPEN');
  assert.equal(engine.result().frozen, '0.00');
});

test('partial NAK unfreezes only the rejected line', () => {
  const engine = new Engine();
  engine.submit({
    batch: 1, timeoutMs: 100000,
    lines: [L(1, '100.00', 'USD', 'pay'), L(2, '200.00', 'XXX', 'pay')],
  });
  assert.equal(engine.result().frozen, '300.00');
  engine.pump();
  const r = engine.result();
  assert.equal(r.lines[0].state, 'SETTLED');
  assert.equal(r.lines[1].state, 'NAKED');
  assert.equal(r.frozen, '0.00'); // 100 consumed by settlement, 200 unfrozen by NAK
  assert.equal(r.settledPay, '100.00');
  const nak = engine.ledger.audit.find((e) => e.kind === 'nak');
  assert.equal(nak.reason, 'currency_not_allowed');
  assert.equal(nak.unfrozen, '200.00');
  assert.equal(r.audit.valid, true);
});
