'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, EngineError } = require('../src/engine');

function foldAll(events) {
  const eng = new Engine();
  for (const e of events) eng.ingest(e);
  return eng.fold();
}

test('acceptance 2: correction invalidating a scheduled target cascades; confirmed observations unchanged', () => {
  const { output } = foldAll([
    { type: 'plan', target: 'T1', pi: 'alice', duration: 50, value: 10, switch: 0, windows: [[0, 100]], clock: 1 },
    { type: 'plan', target: 'T2', pi: 'bob', duration: 40, value: 9, switch: 0, windows: [[0, 100]], clock: 2 },
    { type: 'observe', id: 'o1', target: 'T1', start: 0, end: 50, clock: 3 },
    { type: 'correct', target: 'T2', windows: [[60, 90]], clock: 4 },
  ]);
  // Confirmed observation is immutable.
  assert.deepEqual(output.fixed.map(f => [f.target, f.start, f.end]), [['T1', 0, 50]]);
  // T2 no longer fits its corrected window ([60,90] is 30 < 40): cascade drop.
  assert.deepEqual(output.skipped, [{ target: 'T2', reason: 'no-feasible-window' }]);
  assert.equal(output.schedule.length, 0);
  // Interruption evidence saved, preemption at the observation boundary.
  const pre = output.preemptions.find(p => p.target === 'T2');
  assert.ok(pre, 'expected preemption evidence for T2');
  assert.equal(pre.plannedStart, 50);
  assert.equal(pre.plannedEnd, 90);
  assert.equal(pre.boundary, 50);
  assert.equal(pre.cause.type, 'correct');
  assert.equal(pre.cause.clock, 4);
  // Confirmed exposure is preserved.
  assert.equal(output.exposure.alice, 50);
});

test('cascade reschedules remaining targets into freed time', () => {
  const { output } = foldAll([
    { type: 'plan', target: 'T1', pi: 'a', duration: 50, value: 10, switch: 0, windows: [[0, 100]], clock: 1 },
    { type: 'plan', target: 'T2', pi: 'a', duration: 50, value: 9, switch: 0, windows: [[0, 100]], clock: 2 },
    { type: 'plan', target: 'T3', pi: 'a', duration: 50, value: 8, switch: 0, windows: [[0, 100]], clock: 3 },
    { type: 'correct', target: 'T1', windows: [], clock: 4 },
  ]);
  // T1 closed by correction; T2 and T3 cascade into the freed night.
  assert.deepEqual(output.schedule.map(p => [p.target, p.start, p.end]),
    [['T2', 0, 50], ['T3', 50, 100]]);
  assert.deepEqual(output.skipped, [{ target: 'T1', reason: 'window-closed' }]);
  const pre = output.preemptions.find(p => p.target === 'T1');
  assert.ok(pre);
  assert.deepEqual(pre.replacedBy, ['T2']);
});

test('unknown cloud cover keeps a target pending, never unsatisfiable', () => {
  const eng = new Engine();
  eng.ingest({ type: 'plan', target: 'T1', pi: 'a', duration: 50, value: 10, switch: 0, windows: [[0, 50]], clock: 1 });
  eng.ingest({ type: 'correct', target: 'T1', cloud: 'unknown', clock: 2 });
  let out = eng.fold().output;
  assert.deepEqual(out.pending, [{ target: 'T1', reason: 'cloud-unknown' }]);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.schedule.length, 0);
  // A later correction with known cloud cover un-pends the target.
  eng.ingest({ type: 'correct', target: 'T1', cloud: 0.2, clock: 3 });
  out = eng.fold().output;
  assert.deepEqual(out.pending, []);
  assert.deepEqual(out.schedule.map(p => [p.target, p.start, p.end]), [['T1', 0, 50]]);
});

test('concurrent history merges by logical clock, conflicts by (clock, node, target)', () => {
  // Arrival order would revoke before the observation exists; logical clock
  // orders the observe first, so the revoke is legal.
  const { output } = foldAll([
    { type: 'revoke', id: 'o1', clock: 2, node: 'n1' },
    { type: 'observe', id: 'o1', target: 'T1', start: 0, end: 10, clock: 1, node: 'n1' },
    { type: 'plan', target: 'T1', pi: 'a', duration: 10, value: 5, switch: 0, windows: [[0, 10]], clock: 1, node: 'n1' },
  ]);
  assert.deepEqual(output.revoked, ['o1']);
  assert.equal(output.fixed.length, 0);
  // Revoked observation un-fulfills the target: it is schedulable again.
  assert.deepEqual(output.schedule.map(p => p.target), ['T1']);
});

test('same-clock conflicts from different nodes order deterministically', () => {
  const a = foldAll([
    { type: 'plan', target: 'T2', pi: 'b', duration: 10, value: 5, switch: 0, windows: [[0, 10]], clock: 1, node: 'n2' },
    { type: 'plan', target: 'T1', pi: 'a', duration: 10, value: 5, switch: 0, windows: [[0, 10]], clock: 1, node: 'n1' },
  ]);
  const b = foldAll([
    { type: 'plan', target: 'T1', pi: 'a', duration: 10, value: 5, switch: 0, windows: [[0, 10]], clock: 1, node: 'n1' },
    { type: 'plan', target: 'T2', pi: 'b', duration: 10, value: 5, switch: 0, windows: [[0, 10]], clock: 1, node: 'n2' },
  ]);
  assert.equal(a.output.certificate, b.output.certificate);
});

test('error: overlapping windows are illegal', () => {
  const eng = new Engine();
  assert.throws(
    () => eng.ingest({ type: 'plan', target: 'T', duration: 5, windows: [[0, 10], [5, 15]] }),
    (err) => err instanceof EngineError && err.exitCode === 3 && /overlapping windows/.test(err.message));
  assert.throws(
    () => eng.ingest({ type: 'correct', target: 'T', windows: [[0, 10], [10, 20], [15, 25]] }),
    /overlapping windows/);
});

test('error: negative duration is illegal', () => {
  const eng = new Engine();
  assert.throws(() => eng.ingest({ type: 'plan', target: 'T', duration: -1 }), /negative duration/);
  assert.throws(() => eng.ingest({ type: 'observe', id: 'o', target: 'T', start: 10, end: 5 }), /negative duration/);
  assert.throws(() => eng.ingest({ type: 'plan', target: 'T', duration: 5, windows: [[10, 4]] }), /negative duration/);
});

test('error: revoking an unknown observation is illegal', () => {
  const eng = new Engine();
  eng.ingest({ type: 'revoke', id: 'nope' });
  assert.throws(() => eng.fold(), (err) => err.exitCode === 3 && /unknown observation/.test(err.message));
});

test('revoke of a real observation removes its exposure', () => {
  const { output } = foldAll([
    { type: 'plan', target: 'T1', pi: 'alice', duration: 10, value: 5, switch: 0, windows: [[0, 10]], clock: 1 },
    { type: 'observe', id: 'o1', target: 'T1', start: 0, end: 10, clock: 2 },
    { type: 'revoke', id: 'o1', clock: 3 },
  ]);
  assert.equal(output.fixed.length, 0);
  assert.equal(output.exposure.alice, 10); // rescheduled, not confirmed
  assert.equal(output.fixedValue, 0);
});
