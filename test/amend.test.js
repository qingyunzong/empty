import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeeEngine } from '../src/engine.js';

const FLAT = { type: 'package', id: 'flat', version: 1, tiers: [{ upTo: null, rate: 0.001 }] };

test('amend equals cancel-plus-add and never double counts', () => {
  const engine = new FeeEngine();
  engine.applyEvent(FLAT);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100 });
  engine.applyEvent({ type: 'amend', id: 't1', amount: 150 });
  const view = engine.accountView('A');
  assert.equal(view.turnoverCents, 15000); // not 25000
  assert.equal(view.feeCents, 15);
  // Amending to the same amount is a no-op on the totals.
  engine.applyEvent({ type: 'amend', id: 't1', amount: 150 });
  assert.equal(engine.accountView('A').turnoverCents, 15000);
});

test('amend of an unknown trade is rejected', () => {
  const engine = new FeeEngine();
  engine.applyEvent(FLAT);
  assert.throws(() => engine.applyEvent({ type: 'amend', id: 'nope', amount: 10 }), /no such active trade/);
});

test('duplicate trade ids and unknown cancels are rejected', () => {
  const engine = new FeeEngine();
  engine.applyEvent(FLAT);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100 });
  assert.throws(
    () => engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 50 }),
    /duplicate trade id/,
  );
  assert.throws(() => engine.applyEvent({ type: 'cancel', id: 'nope' }), /no such active trade/);
});

test('negative trades are only allowed as reversals referencing the original', () => {
  const engine = new FeeEngine();
  engine.applyEvent(FLAT);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 200 });
  // bare negative trade
  assert.throws(
    () => engine.applyEvent({ type: 'trade', id: 't2', account: 'A', amount: -50 }),
    /reversal/,
  );
  // reversal without a live reference
  assert.throws(
    () => engine.applyEvent({ type: 'reversal', id: 'r1', ref: 'ghost', amount: -50 }),
    /not active/,
  );
  // reversal with a positive amount
  assert.throws(
    () => engine.applyEvent({ type: 'reversal', id: 'r1', ref: 't1', amount: 50 }),
    /must be negative/,
  );
  // proper reversal
  engine.applyEvent({ type: 'reversal', id: 'r1', ref: 't1', amount: -50 });
  assert.equal(engine.accountView('A').turnoverCents, 15000);
  assert.equal(engine.accountView('A').feeCents, 15);
});

test('reversal may not push turnover below zero', () => {
  const engine = new FeeEngine();
  engine.applyEvent(FLAT);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100 });
  assert.throws(
    () => engine.applyEvent({ type: 'reversal', id: 'r1', ref: 't1', amount: -150 }),
    /negative/,
  );
});

test('rate version switching rewires the graph and reprices accounts', () => {
  const engine = new FeeEngine();
  engine.applyEvent(FLAT);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  assert.equal(engine.accountView('A').feeCents, 10000);
  // same id, new version: rates switch
  engine.applyEvent({ ...FLAT, version: 2, tiers: [{ upTo: null, rate: 0.0005 }] });
  assert.equal(engine.accountView('A').feeCents, 5000);
  // deactivating the only package leaves nothing to charge
  engine.applyEvent({ type: 'deactivate', packageId: 'flat' });
  const view = engine.accountView('A');
  assert.equal(view.feeCents, 0);
  assert.equal(view.package, null);
  assert.throws(() => engine.applyEvent({ type: 'deactivate', packageId: 'flat' }), /unknown package/);
});

test('snapshot/restore round-trip preserves the certificate', () => {
  const engine = new FeeEngine();
  engine.applyEvent(FLAT);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  engine.applyEvent({ type: 'trade', id: 't2', account: 'B', amount: 50000 });
  engine.applyEvent({ type: 'reversal', id: 'r1', ref: 't2', amount: -20000 });
  engine.applyEvent({ type: 'amend', id: 't1', amount: 120000 });
  const restored = FeeEngine.restore(engine.snapshot());
  assert.equal(restored.certificate().digest, engine.certificate().digest);
});
