'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collector, EXIT } = require('../lib/collector');
const { ev } = require('./helpers');

test('same-key resend is deduplicated (acceptance 1)', () => {
  const c = new Collector();
  const e1 = ev('e1', 'A', 100, 1, 1);
  assert.equal(c.register(e1), 'registered');
  assert.equal(c.register({ ...e1 }), 'duplicate');
  assert.equal(c.register({ ...e1 }), 'duplicate');
  assert.equal(c.dupCount, 2);
  assert.equal(c.balances.get('A'), 100);
  assert.equal(c.currentEvents.length, 1);
});

test('same eventId with different payload exits 3', () => {
  const c = new Collector();
  c.register(ev('e1', 'A', 100, 1, 1));
  assert.throws(() => c.register(ev('e1', 'A', 999, 1, 1)), (err) => err.code === EXIT.DUP_CONFLICT);
});

test('same acct+branchSeq with different eventId exits 3', () => {
  const c = new Collector();
  c.register(ev('e1', 'A', 100, 1, 1));
  assert.throws(() => c.register(ev('e2', 'A', 100, 1, 2)), (err) => err.code === EXIT.DUP_CONFLICT);
});

test('missing sequence beyond window exits 4', () => {
  const c = new Collector({ gapWindow: 4 });
  c.register(ev('e1', 'A', 1, 1, 1));
  c.register(ev('e4', 'A', 1, 4, 4));
  assert.throws(() => c.register(ev('e9', 'A', 1, 9, 9)), (err) => err.code === EXIT.GAP);
});

test('out-of-order delivery drains in branchSeq order once gap fills', () => {
  const c = new Collector();
  c.register(ev('e3', 'A', 30, 3, 3));
  c.register(ev('e1', 'A', 10, 1, 1));
  assert.equal(c.balances.get('A'), 10);
  assert.deepEqual(c.pending().map((p) => p.eventId), ['e3']);
  c.register(ev('e2', 'A', 20, 2, 2));
  assert.equal(c.balances.get('A'), 60);
  assert.deepEqual(c.currentEvents, ['e1', 'e2', 'e3']);
  assert.equal(c.pending().length, 0);
});

test('correction chain reversal+replacement affects later balances (acceptance 2)', () => {
  const c = new Collector();
  c.register(ev('e1', 'A', 100, 1, 1));
  c.register(ev('e2', 'A', 50, 2, 2));
  assert.equal(c.balances.get('A'), 150);
  c.register(ev('e3', 'A', 0, 3, 3, { reversalOf: 'e1' }));
  c.register(ev('e4', 'A', 60, 4, 4, { replaces: 'e1' }));
  assert.equal(c.balances.get('A'), 110);
  c.register(ev('e5', 'A', 10, 5, 5));
  assert.equal(c.balances.get('A'), 120);
});

test('correction of a frozen period-1 event lands in period 2, period 1 untouched', () => {
  const c = new Collector();
  c.register(ev('e1', 'A', 100, 1, 1));
  const p1 = c.close();
  assert.equal(p1.balances.A, 100);
  c.register(ev('e2', 'A', 0, 2, 2, { reversalOf: 'e1' }));
  c.register(ev('e3', 'A', 40, 3, 3, { replaces: 'e1' }));
  const p2 = c.close();
  assert.equal(p1.balances.A, 100);
  assert.equal(p2.balances.A, 40);
  assert.equal(c.balances.get('A'), 40);
});

test('cyclic causality is rejected (exit 5)', () => {
  const c = new Collector();
  c.register(ev('a1', 'A', 1, 1, 1, { reversalOf: 'b1' }));
  assert.throws(
    () => c.register(ev('b1', 'B', 1, 1, 2, { reversalOf: 'a1' })),
    (err) => err.code === EXIT.CYCLE
  );
});

test('self reference is rejected (exit 5)', () => {
  const c = new Collector();
  assert.throws(() => c.register(ev('a1', 'A', 1, 1, 1, { reversalOf: 'a1' })), (err) => err.code === EXIT.CYCLE);
});

test('link contradicting same-acct branchSeq order is rejected (exit 5)', () => {
  const c = new Collector();
  c.register(ev('a1', 'A', 1, 1, 1));
  c.register(ev('a2', 'A', 1, 2, 2, { reversalOf: 'a3' })); // target not known yet: pends
  assert.throws(
    () => c.register(ev('a3', 'A', 1, 3, 3)),
    (err) => err.code === EXIT.CYCLE
  );
});

test('correction may arrive before its target (pending until target applies)', () => {
  const c = new Collector();
  c.register(ev('c1', 'A', 0, 1, 5, { reversalOf: 't1' }));
  assert.equal(c.balances.get('A'), undefined);
  assert.equal(c.pending()[0].reason, 'waiting for t1');
  c.register(ev('t1', 'B', 70, 1, 1));
  assert.equal(c.balances.get('A'), -70);
  assert.equal(c.balances.get('B'), 70);
});

test('canonical order: per-acct branchSeq chains, cross-acct (logicalTs, eventId)', () => {
  const c = new Collector();
  c.register(ev('b2', 'B', 2, 2, 1));
  c.register(ev('a1', 'A', 1, 1, 5));
  c.register(ev('b1', 'B', 1, 1, 9));
  const p = c.close();
  assert.deepEqual(p.events, ['a1', 'b1', 'b2']);
});
