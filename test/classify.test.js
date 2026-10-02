import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';

const MIN = 60 * 1000;
const expectCode = (code) => (err) => err && err.code === code;

test('idle within micro-stop threshold is planned, beyond it is unplanned', () => {
  const planned = analyze([{ id: 'a', type: 'idle', start: 0, end: 30 * 1000 }], {
    microStopThresholdMs: MIN,
  });
  assert.equal(planned.timeline[0].planned, true);
  assert.equal(planned.timeline[0].rule, 'idle-micro-stop');

  const unplanned = analyze([{ id: 'a', type: 'idle', start: 0, end: 2 * MIN }], {
    microStopThresholdMs: MIN,
  });
  assert.equal(unplanned.timeline[0].planned, false);
  assert.equal(unplanned.timeline[0].rule, 'idle-exceeds-micro-stop');
});

test('changeover within threshold is planned, beyond it is unplanned', () => {
  const planned = analyze([{ id: 'a', type: 'changeover', start: 0, end: 30 * MIN }]);
  assert.equal(planned.timeline[0].planned, true);
  assert.equal(planned.timeline[0].rule, 'changeover-within-threshold');

  const unplanned = analyze([{ id: 'a', type: 'changeover', start: 0, end: 31 * MIN }]);
  assert.equal(unplanned.timeline[0].planned, false);
  assert.equal(unplanned.timeline[0].rule, 'changeover-exceeds-threshold');
  assert.equal(unplanned.timeline[0].thresholdMs, 30 * MIN);
});

test('priority coupling: fault overrides planned maintenance on overlap', () => {
  const cert = analyze([
    { id: 'pm', type: 'maintenance', start: 0, end: 1000 },
    { id: 'f', type: 'fault', start: 400, end: 600 },
  ]);
  const mid = cert.timeline.find((iv) => iv.start === 400);
  assert.equal(mid.state, 'fault');
  assert.equal(mid.planned, false);
  assert.equal(mid.rule, 'fault-unplanned');
  assert.deepEqual(mid.winnerEventIds, ['f']);
  const before = cert.timeline.find((iv) => iv.start === 0);
  assert.equal(before.state, 'maintenance');
  assert.equal(before.planned, true);
});

test('threshold applies to the merged span of connected same-type coverage', () => {
  // Two adjacent 20-minute changeovers merge into a 40-minute span > 30-minute threshold.
  const cert = analyze([
    { id: 'a', type: 'changeover', start: 0, end: 20 * MIN },
    { id: 'b', type: 'changeover', start: 20 * MIN, end: 40 * MIN },
  ]);
  assert.ok(cert.timeline.every((iv) => iv.planned === false));
  assert.ok(cert.timeline.every((iv) => iv.spanDurationMs === 40 * MIN));
});

test('equal-priority overlap of different types raises ERR_CONFLICT', () => {
  assert.throws(
    () =>
      analyze(
        [
          { id: 'f', type: 'fault', start: 0, end: 100 },
          { id: 'm', type: 'maintenance', start: 50, end: 150 },
        ],
        { priorities: { fault: 40, maintenance: 40 } },
      ),
    expectCode('ERR_CONFLICT'),
  );
});
