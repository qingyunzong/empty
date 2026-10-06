import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamEvent, WatermarkTracker, isMonotonic, replay } from '../src/index';

const data = (partition: string, timestamp: number): StreamEvent => ({
  type: 'data',
  partition,
  timestamp,
});
const idle = (partition: string): StreamEvent => ({ type: 'idle', partition });
const active = (partition: string): StreamEvent => ({ type: 'active', partition });

test('global watermark is the minimum across active partitions', () => {
  const result = replay([
    data('p2', 5),
    data('p1', 10),
    data('p1', 12),
    data('p2', 7),
  ]);
  assert.deepEqual(result.trajectory.map((p) => p.watermark), [5, 7]);
  assert.equal(result.finalWatermark, 7);
  assert.equal(result.rejections.length, 0);
});

test('a lagging partition holds the watermark back (no wall-clock guessing)', () => {
  const result = replay([data('p2', 5), data('p1', 100), data('p1', 200), data('p1', 300)]);
  assert.equal(result.finalWatermark, 5);
  assert.deepEqual(result.trajectory.map((p) => p.watermark), [5]);
});

test('explicit idle event excludes the partition and lets the watermark advance', () => {
  const result = replay([
    data('p2', 5),
    data('p1', 10),
    idle('p2'),
    data('p1', 20),
  ]);
  assert.deepEqual(result.trajectory.map((p) => p.watermark), [5, 10, 20]);
  assert.equal(result.finalWatermark, 20);
});

test('recovery behind the published watermark is rejected and the partition stays idle', () => {
  const result = replay([
    data('p2', 5),
    data('p1', 10),
    idle('p2'),
    data('p1', 20),
    active('p2'),
  ]);
  assert.equal(result.rejections.length, 1);
  const rejection = result.rejections[0]!;
  assert.equal(rejection.reason, 'recovery-behind-published-watermark');
  assert.equal(rejection.eventIndex, 4);
  assert.equal(rejection.publishedWatermark, 20);
  const p2 = result.partitions.find((p) => p.id === 'p2')!;
  assert.equal(p2.status, 'idle');
  assert.equal(result.finalWatermark, 20);
});

test('recovered partition rejoins once its data catches up to the published watermark', () => {
  const result = replay([
    data('p2', 5),
    data('p1', 10),
    idle('p2'),
    data('p1', 20),
    active('p2'),
    data('p2', 25),
    data('p1', 30),
  ]);
  assert.equal(result.rejections.length, 1);
  assert.deepEqual(result.trajectory.map((p) => p.watermark), [5, 10, 20, 25]);
  const p2 = result.partitions.find((p) => p.id === 'p2')!;
  assert.equal(p2.status, 'active');
  assert.equal(p2.watermark, 25);
});

test('data on an idle partition reactivates it, but data before the published watermark is rejected', () => {
  const result = replay([
    data('p2', 5),
    data('p1', 10),
    idle('p2'),
    data('p1', 20),
    data('p2', 15),
  ]);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0]!.reason, 'data-before-published-watermark');
  const p2 = result.partitions.find((p) => p.id === 'p2')!;
  assert.equal(p2.status, 'idle');
  assert.equal(p2.watermark, 5);
});

test('late data below the partition watermark is rejected', () => {
  const result = replay([data('p1', 10), data('p1', 4)]);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0]!.reason, 'late-data-below-partition-watermark');
  assert.equal(result.finalWatermark, 10);
});

test('data with a timestamp equal to the partition watermark is accepted', () => {
  const result = replay([data('p1', 10), data('p1', 10)]);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.finalWatermark, 10);
});

test('watermark is not published until at least one active partition reports data', () => {
  const tracker = new WatermarkTracker();
  tracker.apply(idle('p1'));
  assert.equal(tracker.watermark, null);
  assert.equal(tracker.trajectory.length, 0);
  tracker.apply(data('p2', 3));
  assert.equal(tracker.watermark, 3);
});

test('replay verifies trajectory monotonicity over a mixed event log', () => {
  const events: StreamEvent[] = [
    data('a', 1),
    data('b', 4),
    data('c', 2),
    data('a', 8),
    idle('c'),
    data('b', 6),
    idle('b'),
    data('a', 12),
    active('b'),
    data('b', 15),
    data('a', 20),
    active('c'),
    data('c', 30),
    data('b', 40),
  ];
  const result = replay(events);
  assert.ok(result.monotonic);
  assert.ok(isMonotonic(result.trajectory));
  const watermarks = result.trajectory.map((p) => p.watermark);
  for (let i = 1; i < watermarks.length; i++) {
    assert.ok(watermarks[i]! > watermarks[i - 1]!);
  }
  assert.deepEqual(
    result.rejections.map((r) => r.reason),
    ['recovery-behind-published-watermark', 'recovery-behind-published-watermark'],
  );
  assert.equal(result.finalWatermark, 20);
});

test('replaying the same log twice yields identical trajectory and rejections', () => {
  const events: StreamEvent[] = [
    data('x', 3),
    data('y', 9),
    idle('x'),
    data('y', 11),
    active('x'),
    data('x', 2),
    data('x', 14),
  ];
  const first = replay(events);
  const second = replay(events);
  assert.deepEqual(second.trajectory, first.trajectory);
  assert.deepEqual(second.rejections, first.rejections);
  assert.equal(first.monotonic, true);
});
