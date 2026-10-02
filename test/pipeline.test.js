import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/pipeline.js';

const T0 = Date.UTC(2026, 9, 2, 14, 0, 0);
const H = 3600 * 1000;
const M = 60 * 1000;

const order = (job, mold, qty, eventTs, opts = {}) => ({
  type: 'order',
  arriveTs: eventTs,
  eventTs,
  job,
  mold,
  due: opts.due ?? T0 + 8 * H,
  qty,
  op: 'add',
});

test('acceptance 1: out-of-order orders trigger exactly three corrections', () => {
  const events = [
    order('A', 'M1', 20, T0),
    order('X', 'M2', 10, T0 + 2 * H + 10 * M), // advances watermark past windows 0 and 1
    order('B', 'M1', 10, T0 + 10 * M), // late but retractable
    order('C', 'M1', 10, T0 + 15 * M), // late but retractable
    order('D', 'M1', 10, T0 + 20 * M), // late but retractable
  ];
  const r = runPipeline(events);
  assert.equal(r.corrections.length, 3);
  assert.deepEqual(
    r.corrections.map((c) => c.trigger.id),
    ['B', 'C', 'D'],
  );
  assert.ok(r.corrections.every((c) => c.trigger.late && c.window.index === 0));
  assert.deepEqual(
    r.corrections[0].before.map((e) => e.job),
    ['A'],
  );
  assert.deepEqual(
    r.corrections[2].after.map((e) => e.job),
    ['A', 'B', 'C', 'D'],
  );
  assert.deepEqual(
    r.best.sequences[0].map((e) => e.job),
    ['A', 'B', 'C', 'D', 'X'],
  );
});

test('acceptance 2: retracting maintenance restores squeezed-out batches', () => {
  const maint = { type: 'maint', eventTs: T0, machine: 'L1', start: T0, end: T0 + 2 * H, op: 'add' };
  const maintId = `L1:${T0}:${T0 + 2 * H}`;
  const before = [
    order('P', 'M1', 60, T0, { due: T0 + 90 * M }),
    order('Q', 'M1', 60, T0, { due: T0 + 2 * H }),
    maint,
  ];
  const squeezed = runPipeline(before);
  assert.equal(squeezed.best.objective.violations, 2);

  const restored = runPipeline([...before, { type: 'retract', eventTs: T0 + 1 * M, kind: 'maint', id: maintId }]);
  assert.equal(restored.best.objective.violations, 0);
  const seq = restored.best.sequences[0];
  assert.deepEqual(
    seq.map((e) => e.job),
    ['P', 'Q'],
  );
  assert.equal(seq[0].start, T0);
  assert.equal(seq[1].end, T0 + 2 * H);
});

test('retracting an order frees its mold slots and restores later candidates', () => {
  const events = [
    order('A', 'M1', 120, T0),
    order('B', 'M1', 30, T0),
  ];
  const before = runPipeline(events);
  assert.equal(before.best.sequences[0][1].start, T0 + 2 * H);

  const after = runPipeline([...events, { type: 'retract', eventTs: T0 + 1 * M, kind: 'order', id: 'A' }]);
  const seq = after.best.sequences[0];
  assert.deepEqual(
    seq.map((e) => e.job),
    ['B'],
  );
  assert.equal(seq[0].start, T0);
});

test('late non-retractable retract events go to late.log and are not applied', () => {
  const events = [
    order('A', 'M1', 20, T0),
    order('X', 'M2', 10, T0 + 2 * H + 10 * M),
    { type: 'retract', eventTs: T0 + 5 * M, kind: 'order', id: 'A' }, // late, not retractable
  ];
  const r = runPipeline(events);
  assert.equal(r.late.length, 1);
  assert.equal(r.late[0].reason, 'LATE_NON_RETRACTABLE');
  assert.equal(r.late[0].event.id, 'A');
  assert.ok(r.best.sequences[0].some((e) => e.job === 'A'));
});

test('on-time retract of an order is applied and corrects emitted windows', () => {
  const events = [
    order('A', 'M1', 20, T0),
    order('B', 'M1', 20, T0 + 30 * M),
    order('X', 'M2', 10, T0 + 2 * H + 10 * M), // emits window 0 = [A, B]
    { type: 'retract', eventTs: T0 + 2 * H + 20 * M, kind: 'order', id: 'B' }, // on-time
  ];
  const r = runPipeline(events);
  assert.equal(r.late.length, 0);
  assert.equal(r.corrections.length, 1);
  assert.deepEqual(
    r.corrections[0].after.map((e) => e.job),
    ['A'],
  );
});

test('watermark tracks max event time minus two minutes', () => {
  const r = runPipeline([order('A', 'M1', 10, T0), order('B', 'M1', 10, T0 + H)]);
  assert.equal(r.watermark, T0 + H - 2 * M);
  assert.equal(r.horizonStart, T0);
  assert.equal(r.horizonEnd, T0 + 8 * H);
});
