import test from 'node:test';
import assert from 'node:assert/strict';
import { Processor } from '../src/stream.js';

const MIN = 60_000;
const T = 1_700_000_000_000;
const DUE = T + 8 * 3600 * 1000;

const order = (job, mold, eventTs, qty = 5, op = 1) => ({
  type: 'order', arriveTs: eventTs, eventTs, job, mold, due: DUE, qty, op,
});

// Acceptance 1: out-of-order orders trigger exactly three corrections.
test('out-of-order orders produce three incremental corrections', () => {
  const p = new Processor();
  p.ingest(order('J1', 'A', T));
  p.ingest(order('J2', 'A', T + 10 * MIN)); // watermark -> T+8m
  const r3 = p.ingest(order('J3', 'B', T + 1 * MIN));
  const r4 = p.ingest(order('J4', 'B', T + 2 * MIN));
  const r5 = p.ingest(order('J5', 'C', T + 3 * MIN));
  assert.equal(r3.late, true);
  assert.equal(r4.late, true);
  assert.equal(r5.late, true);
  assert.equal(p.corrections.length, 3);
  assert.deepEqual(p.corrections.map((c) => c.seq), [1, 2, 3]);
  assert.deepEqual(p.corrections.map((c) => c.id), ['J3', 'J4', 'J5']);
  assert.ok(p.corrections.every((c) => c.watermark === T + 8 * MIN));
  assert.ok(p.corrections.every((c) => c.changedJobs.length > 0));
  assert.equal(p.lateLog.length, 0);
  const jobs = p.current.schedules[0].map((x) => x.job).sort();
  assert.deepEqual(jobs, ['J1', 'J2', 'J3', 'J4', 'J5']);
});

// Acceptance 2: retracting a maintenance window restores the squeezed batch.
test('maint retract restores the squeezed-out batch', () => {
  const p = new Processor();
  p.ingest(order('J1', 'A', T, 10, 1));
  p.ingest(order('J2', 'A', T, 10, 1));
  const before = p.current;
  assert.equal(before.schedules[0][0].start, T + 30 * MIN); // after initial setup
  assert.equal(before.schedules[0][1].end, T + 50 * MIN);

  const maint = {
    type: 'maint', eventTs: T + 5 * MIN, machine: 'M1',
    start: T + 35 * MIN, end: T + 45 * MIN, op: 'inspection',
  };
  p.ingest(maint);
  const squeezed = p.current;
  // t0 advanced to T+5m: setup [T+5,T+35), J1 pushed past the maint window
  assert.equal(squeezed.schedules[0][0].start, T + 45 * MIN);
  assert.equal(squeezed.objective.makespan, T + 65 * MIN);
  // while the maint window is active, nothing overlaps it
  for (const pl of squeezed.schedules[0]) {
    assert.ok(pl.end <= T + 35 * MIN || pl.start >= T + 45 * MIN);
  }

  p.ingest({ type: 'retract', eventTs: T + 6 * MIN, kind: 'maint', id: 'M1:' + (T + 35 * MIN) + '-' + (T + 45 * MIN) });
  const restored = p.current;
  assert.equal(restored.maints === undefined, true);
  assert.equal(restored.schedules[0][0].start, T + 36 * MIN); // t0=T+6m, setup 30m
  assert.equal(restored.schedules[0][0].end, T + 46 * MIN);
  assert.equal(restored.schedules[0][1].start, T + 46 * MIN);
  assert.equal(restored.objective.makespan, T + 56 * MIN);
  // the batch squeezed out by maintenance is restored to the freed slots
  assert.ok(restored.schedules[0][0].start < T + 45 * MIN);
});

// Late but retractable data is corrected; late non-retractable data goes to late.log.
test('late retract of known id corrects; unknown id goes to late.log', () => {
  const p = new Processor();
  p.ingest(order('J1', 'A', T));
  p.ingest(order('J2', 'A', T + 10 * MIN)); // watermark -> T+8m

  const ghost = p.ingest({ type: 'retract', eventTs: T + 1 * MIN, kind: 'order', id: 'GHOST' });
  assert.equal(ghost.late, true);
  assert.equal(ghost.applied, false);
  assert.equal(p.lateLog.length, 1);
  assert.match(p.lateLog[0], /GHOST/);
  assert.equal(p.corrections.length, 0);

  const known = p.ingest({ type: 'retract', eventTs: T + 2 * MIN, kind: 'order', id: 'J1' });
  assert.equal(known.late, true);
  assert.equal(known.applied, true);
  assert.equal(p.corrections.length, 1);
  assert.deepEqual(p.corrections[0].changedJobs, ['J1', 'J2']);
  assert.deepEqual(p.current.schedules[0].map((x) => x.job), ['J2']);
});
