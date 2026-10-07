import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyEvent, mergeStates, pendingHolds, counterTotal } from '../src/state.js';
import { computeOee } from '../src/oee.js';

const WINDOW = { windowStart: 0, windowEnd: 28800, maxSkew: 300 };

test('out-of-bound events go to hold and are not applied', () => {
  const s = emptyState();
  applyEvent(s, { id: 'ok', type: 'count', counter: 'produced', node: 't1', delta: 100, ts: 1000 }, WINDOW);
  applyEvent(s, { id: 'late', type: 'count', counter: 'produced', node: 't1', delta: 50, ts: 28800 + 301 }, WINDOW);
  applyEvent(s, { id: 'early', type: 'downtime', node: 't1', start: -1000, end: -900, ts: -1000 }, WINDOW);
  assert.equal(counterTotal(s, 'produced'), 100, 'held count not applied');
  assert.equal(Object.keys(s.downtimes).length, 0, 'held downtime not applied');
  assert.deepEqual(pendingHolds(s).map((h) => h.id).sort(), ['early', 'late']);
});

test('events within skew bound are accepted', () => {
  const s = emptyState();
  applyEvent(s, { id: 'edge1', type: 'count', counter: 'produced', node: 't1', delta: 5, ts: -300 }, WINDOW);
  applyEvent(s, { id: 'edge2', type: 'count', counter: 'produced', node: 't1', delta: 5, ts: 28800 + 300 }, WINDOW);
  applyEvent(s, { id: 'out', type: 'count', counter: 'produced', node: 't1', delta: 5, ts: 28800 + 301 }, WINDOW);
  assert.equal(counterTotal(s, 'produced'), 10);
  assert.deepEqual(pendingHolds(s).map((h) => h.id), ['out']);
});

test('held events do not count as loss or violation in OEE', () => {
  const s = emptyState();
  applyEvent(s, { id: 'p', type: 'count', counter: 'produced', node: 't1', delta: 100, ts: 100 }, WINDOW);
  applyEvent(s, { id: 'held-reject', type: 'count', counter: 'rejected', node: 't1', delta: 999, ts: 99999 }, WINDOW);
  applyEvent(s, { id: 'held-dt', type: 'downtime', node: 't1', start: 50000, end: 60000, ts: 50000 }, WINDOW);
  const oee = computeOee(s, { plannedTime: 28800, idealRate: 1 });
  assert.equal(oee.rejected, 0);
  assert.equal(oee.downtime, 0);
  assert.deepEqual(oee.violations, []);
  assert.equal(oee.pending.length, 2);
});

test('holds propagate through merge', () => {
  const a = emptyState();
  applyEvent(a, { id: 'h1', type: 'count', counter: 'produced', node: 't1', delta: 5, ts: 99999 }, WINDOW);
  const b = emptyState();
  applyEvent(b, { id: 'ok', type: 'count', counter: 'produced', node: 't2', delta: 7, ts: 100 }, WINDOW);
  const merged = mergeStates(a, b);
  assert.equal(counterTotal(merged, 'produced'), 7);
  assert.deepEqual(pendingHolds(merged).map((h) => h.id), ['h1']);
});
