import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SlidingWindow,
  maxWindowUsage,
} from '../src/index.js';

test('sliding window uses the half-open interval (t-W, t]', () => {
  const window = new SlidingWindow(10);
  window.add({ id: 'left-edge', at: 0, state: 'passed' });
  window.add({ id: 'inside', at: 5, state: 'passed' });
  window.add({ id: 'right-edge', at: 10, state: 'passed' });

  assert.equal(window.usageAt(10), 2);
  assert.equal(window.remainingAt(10, 3), 1);
  assert.equal(window.usageAt(11), 2);
  assert.equal(window.usageAt(20), 0);
  assert.equal(window.usageAt(21), 0);
});

test('reserved and passed records both consume quota until released', () => {
  const window = new SlidingWindow(10);
  window.add({ id: 'a', at: 1, state: 'reserved' });
  window.add({ id: 'b', at: 2, state: 'passed' });

  assert.equal(window.admit(3, 2), false);
  assert.equal(window.usageAt(3), 2);
  assert.equal(window.commit('a'), true);
  assert.equal(window.usageAt(3), 2);
  assert.equal(window.release('a'), true);
  assert.equal(window.usageAt(3), 1);
  assert.equal(window.admit(3, 2), true);
});

test('admission checks every window containing a backdated candidate', () => {
  const window = new SlidingWindow(10);
  window.add({ id: 'early', at: 0, state: 'passed' });
  window.add({ id: 'late', at: 9, state: 'passed' });

  assert.equal(window.usageAt(5), 1);
  assert.equal(window.admit(5, 2), false);
  assert.equal(window.maxUsageWith(5), 3);
});

test('max window usage finds the densest window', () => {
  assert.equal(maxWindowUsage([0, 1, 2, 9, 10, 11], 10), 4);
  assert.equal(maxWindowUsage([], 10), 0);
  assert.equal(maxWindowUsage([5], 1), 1);
});

test('compaction only removes passed records outside the window', () => {
  const window = new SlidingWindow(10);
  window.add({ id: 'old-passed', at: 0, state: 'passed' });
  window.add({ id: 'old-reserved', at: 1, state: 'reserved' });
  window.add({ id: 'recent', at: 15, state: 'passed' });

  assert.equal(window.compact(20), 1);
  assert.deepEqual(
    window.records().map((record) => record.id),
    ['old-reserved', 'recent'],
  );
});

test('maxUsageWith agrees with brute force for arbitrary backdated times', () => {
  let state = 0x12345678;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const windowMs = 1 + Math.floor(random() * 12);
    const window = new SlidingWindow(windowMs);
    const count = Math.floor(random() * 7);
    const times: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const at = Math.floor(random() * 30);
      times.push(at);
      window.add({ id: `r${index}`, at, state: 'passed' });
    }
    const candidate = Math.floor(random() * 30);

    const starts = [candidate - windowMs];
    for (const time of times) {
      const start = time - windowMs;
      if (start >= candidate - windowMs && start < candidate) {
        starts.push(start);
      }
    }
    let brute = 0;
    for (const start of starts) {
      brute = Math.max(
        brute,
        times.filter((time) => time > start && time <= start + windowMs).length,
      );
    }

    assert.equal(window.maxUsageWith(candidate), brute + 1);
    assert.equal(window.maxUsage(), maxWindowUsage(times, windowMs));
  }
});
