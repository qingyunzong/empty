import test from 'node:test';
import assert from 'node:assert/strict';
import { minimizeMisjudgment } from '../src/counterexample.js';
import { analyze } from '../src/analyze.js';

const MIN = 60 * 1000;

test('disputed fault interval: minimal subset is the fault event alone', () => {
  const events = [
    { id: 'r', type: 'run', start: 0, end: 1000 },
    { id: 'f', type: 'fault', start: 400, end: 500 },
  ];
  const result = minimizeMisjudgment(events, 450);
  assert.equal(result.found, true);
  assert.equal(result.original.rule, 'fault-unplanned');
  assert.deepEqual(
    result.minimalEvents.map((e) => e.id),
    ['f'],
  );
  assert.equal(result.verified1Minimal, true);
  const deleteWitness = result.witnesses.find((w) => w.kind === 'delete-event' && w.eventId === 'f');
  assert.ok(deleteWitness, 'deleting the fault flips the interval away from unplanned');
});

test('minimal subset still reproduces the unplanned judgment when re-analyzed', () => {
  const events = [
    { id: 'r', type: 'run', start: 0, end: 1000 },
    { id: 'f', type: 'fault', start: 400, end: 500 },
    { id: 'i', type: 'idle', start: 700, end: 800 },
  ];
  const result = minimizeMisjudgment(events, 450);
  const replay = analyze(result.minimalEvents);
  const at = replay.timeline.find((iv) => iv.start <= 450 && 450 < iv.end);
  assert.equal(at.planned, false);
  assert.equal(at.downtime, true);
});

test('threshold-based misjudgment: shrinking the changeover flips it to planned', () => {
  const events = [{ id: 'c', type: 'changeover', start: 0, end: 40 * MIN }];
  const result = minimizeMisjudgment(events, 1000);
  assert.equal(result.found, true);
  assert.equal(result.original.rule, 'changeover-exceeds-threshold');
  assert.equal(result.minimalEvents.length, 1);
  const shrunk = result.minimalEvents[0];
  // Shrank to just above the 30-minute threshold while still covering t=1000.
  assert.equal(shrunk.end - shrunk.start, 30 * MIN + 1);
  const shrinkWitness = result.witnesses.find((w) => w.kind === 'shrink-event' && w.resulting.planned === true);
  assert.ok(shrinkWitness, 'a 1ms shrink crosses the threshold and flips to planned');
  assert.equal(shrinkWitness.resulting.planned, true);
});

test('disputed point inside a planned interval reports found=false', () => {
  const events = [{ id: 'r', type: 'run', start: 0, end: 1000 }];
  const result = minimizeMisjudgment(events, 500);
  assert.equal(result.found, false);
  assert.match(result.reason, /not judged unplanned/);
});

test('disputed point outside any interval reports found=false', () => {
  const events = [{ id: 'r', type: 'run', start: 0, end: 1000 }];
  const result = minimizeMisjudgment(events, 5000);
  assert.equal(result.found, false);
  assert.match(result.reason, /no interval covers/);
});
