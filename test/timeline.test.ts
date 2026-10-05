import test from 'node:test';
import assert from 'node:assert/strict';
import { Rat } from '../src/rational';
import { Timeline, step, smooth } from '../src/timeline';
import { mapTime } from '../src/player';

const tl = new Timeline([
  { t: Rat.of(0), v: 0 },
  { t: Rat.of(1, 2), v: 10 },
  { t: Rat.of(2), v: 30 },
]);

test('piecewise linear interpolation at rational points', () => {
  assert.equal(tl.valueAt(Rat.of(0)), 0);
  assert.equal(tl.valueAt(Rat.of(1, 4)), 5);
  assert.equal(tl.valueAt(Rat.of(1, 2)), 10);
  assert.equal(tl.valueAt(Rat.of(5, 4)), 20);
  assert.equal(tl.valueAt(Rat.of(2)), 30);
});

test('clamps outside keyframe range', () => {
  assert.equal(tl.valueAt(Rat.of(-3)), 0);
  assert.equal(tl.valueAt(Rat.of(99)), 30);
});

test('per-segment easing', () => {
  const t2 = new Timeline([
    { t: Rat.of(0), v: 0, ease: step },
    { t: Rat.of(1), v: 10, ease: smooth },
    { t: Rat.of(2), v: 20 },
  ]);
  assert.equal(t2.valueAt(Rat.of(1, 2)), 0); // step holds
  assert.equal(t2.valueAt(Rat.of(3, 2)), 15); // smooth midpoint
});

test('loop mapping: exact multiples land on 0, range is [0, D)', () => {
  const D = Rat.of(2);
  assert.equal(mapTime('loop', Rat.of(0), D).toString(), '0');
  assert.equal(mapTime('loop', Rat.of(3, 2), D).toString(), '3/2');
  assert.equal(mapTime('loop', Rat.of(2), D).toString(), '0');
  assert.equal(mapTime('loop', Rat.of(7, 2), D).toString(), '3/2');
  assert.equal(mapTime('loop', Rat.of(4002), D).toString(), '0');
  assert.equal(mapTime('loop', Rat.of(-1), D).toString(), '0');
});

test('pingpong mapping: turning point D belongs to forward half', () => {
  const D = Rat.of(2);
  assert.equal(mapTime('pingpong', Rat.of(1), D).toString(), '1');
  assert.equal(mapTime('pingpong', Rat.of(2), D).toString(), '2'); // peak
  assert.equal(mapTime('pingpong', Rat.of(3), D).toString(), '1');
  assert.equal(mapTime('pingpong', Rat.of(4), D).toString(), '0'); // trough
  assert.equal(mapTime('pingpong', Rat.of(5), D).toString(), '1');
  assert.equal(mapTime('pingpong', Rat.of(9, 2), D).toString(), '1/2');
  assert.equal(mapTime('pingpong', Rat.of(4001), D).toString(), '1');
});

test('once mapping clamps to [0, D]', () => {
  const D = Rat.of(2);
  assert.equal(mapTime('once', Rat.of(1), D).toString(), '1');
  assert.equal(mapTime('once', Rat.of(100), D).toString(), '2');
  assert.equal(mapTime('once', Rat.of(-1), D).toString(), '0');
});

test('rejects non-increasing keyframe times', () => {
  assert.throws(() => new Timeline([
    { t: Rat.of(1), v: 0 },
    { t: Rat.of(1), v: 1 },
  ]));
});
