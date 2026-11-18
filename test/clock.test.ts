import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DriftBoundedClock,
  ManualClock,
} from '../src/index.js';

test('manual clock only advances forward', () => {
  const clock = new ManualClock(100);
  assert.equal(clock.advance(25), 125);
  assert.throws(() => clock.advance(-1), RangeError);
  assert.equal(clock.set(7), 7);
});

test('drift correction cancels skew inside the public bound', () => {
  const raw = new ManualClock(1000);
  const clock = new DriftBoundedClock(raw, 10, 7);
  const result = clock.synchronize(1000);

  assert.equal(result.appliedCorrectionMs, -7);
  assert.equal(result.correctedNow, 1000);
  assert.equal(result.driftMs, 0);
  assert.equal(result.withinBound, true);
  assert.equal(clock.now(), 1000);
});

test('correction is clamped to the public drift bound', () => {
  const raw = new ManualClock(1000);
  const clock = new DriftBoundedClock(raw, 5, 20);
  const result = clock.synchronize(1000);

  assert.equal(result.appliedCorrectionMs, -5);
  assert.equal(result.correctedNow, 1015);
  assert.equal(result.driftMs, 15);
  assert.equal(result.withinBound, false);
});

test('clock keeps advancing after a corrected anchor', () => {
  const raw = new ManualClock(100);
  const clock = new DriftBoundedClock(raw, 10, -4);
  clock.synchronize(100);
  raw.advance(30);

  assert.equal(clock.now(), 130);
  assert.equal(clock.driftFrom(130), 0);
});
