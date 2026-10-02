'use strict';

// Quota fairness: completed-byte deficit plus wait cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankRequesters } = require('../lib/scheduler');
const { ArchiveSystem } = require('../lib/archive');

test('deficit: requester with fewer completed bytes goes first', () => {
  const ranked = rankRequesters([
    { name: 'rich', weight: 1, completedBytes: 100, waitExceeded: false, longestWait: 0 },
    { name: 'poor', weight: 1, completedBytes: 0, waitExceeded: false, longestWait: 0 },
  ]);
  assert.deepEqual(ranked, ['poor', 'rich']);
});

test('wait cap overrides deficit', () => {
  const ranked = rankRequesters([
    { name: 'rich', weight: 1, completedBytes: 100, waitExceeded: true, longestWait: 7 },
    { name: 'poor', weight: 1, completedBytes: 0, waitExceeded: false, longestWait: 0 },
  ]);
  assert.deepEqual(ranked, ['rich', 'poor']);
});

test('quota weights scale the fair share', () => {
  const ranked = rankRequesters([
    { name: 'a', weight: 1, completedBytes: 50, waitExceeded: false, longestWait: 0 },
    { name: 'b', weight: 3, completedBytes: 50, waitExceeded: false, longestWait: 0 },
  ]);
  assert.deepEqual(ranked, ['b', 'a']);
});

test('scheduler serves the deficit requester first in the time slice', () => {
  const sys = new ArchiveSystem({ bandwidth: 10, staging: 1000, quotas: { q1: 1, q2: 1 } });
  sys.request({ id: 'seed', size: 10, retention: 1, requester: 'q1' });
  sys.restore({ ticks: 1 }); // q1 completes 10 bytes
  sys.request({ id: 'A', size: 10, retention: 1, requester: 'q1' });
  sys.request({ id: 'B', size: 10, retention: 1, requester: 'q2' });
  const res = sys.restore({ ticks: 1 });
  const allocs = res.timeSlices[0].allocations;
  assert.equal(allocs.length, 2);
  assert.equal(allocs[0].requester, 'q2', 'deficit requester scheduled first');
  assert.equal(allocs[0].bytes, 5);
  assert.equal(allocs[1].bytes, 5);
});

test('bandwidth time slices make progress and finish exactly', () => {
  const sys = new ArchiveSystem({ bandwidth: 7, staging: 1000 });
  sys.request({ id: 'x', size: 20, retention: 1, requester: 'q' });
  const res = sys.restore({ ticks: 3 });
  const bytes = res.timeSlices.map((s) => s.allocations.reduce((a, b) => a + b.bytes, 0));
  assert.deepEqual(bytes, [7, 7, 6]);
  assert.equal(sys.objects.get('x').status, 'verified');
});
