import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyEvent, mergedIntervals, downtimeTotal } from '../src/state.js';
import { computeOee } from '../src/oee.js';

const PLANNED = 28800; // 8h shift
const RATE = 2; // units/sec

function baseEvents() {
  return [
    { id: 'p1', type: 'count', counter: 'produced', node: 't1', delta: 40000, ts: 5000 },
    { id: 'p2', type: 'count', counter: 'produced', node: 't2', delta: 10000, ts: 6000 },
    { id: 'r1', type: 'count', counter: 'rejected', node: 't1', delta: 500, ts: 7000 },
  ];
}

// Acceptance 2: after a downtime is revoked, OEE returns to the independent reference.
test('downtime revoke returns OEE to reference', () => {
  const reference = emptyState();
  for (const e of baseEvents()) applyEvent(reference, e);
  const refOee = computeOee(reference, { plannedTime: PLANNED, idealRate: RATE });

  const withDt = emptyState();
  for (const e of baseEvents()) applyEvent(withDt, e);
  applyEvent(withDt, { id: 'd1', type: 'downtime', node: 't1', start: 3600, end: 7200, ts: 3600 });
  const dtOee = computeOee(withDt, { plannedTime: PLANNED, idealRate: RATE });
  assert.ok(dtOee.available < refOee.available, 'downtime lowers availability');
  assert.ok(dtOee.performance > refOee.performance, 'same output over less runtime raises performance');
  assert.equal(dtOee.downtime, 3600);

  applyEvent(withDt, { id: 'v1', type: 'revoke', target: 'd1', node: 't1', ts: 8000 });
  const restored = computeOee(withDt, { plannedTime: PLANNED, idealRate: RATE });
  assert.deepEqual(restored, refOee);
});

test('overlapping downtimes merge into one cover', () => {
  const s = emptyState();
  applyEvent(s, { id: 'd1', type: 'downtime', node: 't1', start: 100, end: 200 });
  applyEvent(s, { id: 'd2', type: 'downtime', node: 't2', start: 150, end: 300 });
  applyEvent(s, { id: 'd3', type: 'downtime', node: 't1', start: 500, end: 600 });
  assert.deepEqual(mergedIntervals(s), [[100, 300], [500, 600]]);
  assert.equal(downtimeTotal(s), 300);
  const oee = computeOee(s, { plannedTime: 1000, idealRate: 1 });
  assert.equal(oee.downtime, 300);
  assert.equal(oee.available, 0.7);
});

test('rejects are clamped to production and flagged as violation', () => {
  const s = emptyState();
  applyEvent(s, { id: 'p1', type: 'count', counter: 'produced', node: 't1', delta: 10 });
  applyEvent(s, { id: 'r1', type: 'count', counter: 'rejected', node: 't2', delta: 25 });
  const oee = computeOee(s, { plannedTime: 100, idealRate: 1 });
  assert.equal(oee.rejected, 10, 'effective rejects clamped to produced');
  assert.equal(oee.quality, 0);
  assert.deepEqual(oee.violations, ['rejects-exceed-production']);
});

test('PN-counter decrements keep counters non-negative', () => {
  const s = emptyState();
  applyEvent(s, { id: 'p1', type: 'count', counter: 'produced', node: 't1', delta: 100 });
  applyEvent(s, { id: 'p2', type: 'count', counter: 'produced', node: 't1', delta: -30 });
  const oee = computeOee(s, { plannedTime: 100, idealRate: 1 });
  assert.equal(oee.produced, 70);
});
