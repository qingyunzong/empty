'use strict';

// Acceptance 2: when staging is full, a higher-retention object preempts a
// lower-retention unlocked object (with an eviction proof), and undo rolls
// the whole generation back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ArchiveSystem } = require('../lib/archive');

test('staging full: high retention preempts low retention, undoable', () => {
  const sys = new ArchiveSystem({ bandwidth: 1000, staging: 100, maxWait: 50 });

  sys.request({ id: 'L', size: 60, retention: 1, requester: 'q' });
  const first = sys.restore({ ticks: 1 });
  assert.equal(sys.objects.get('L').status, 'verified');
  assert.equal(sys.stagingUsed, 60);
  assert.equal(first.failures.length, 0);

  sys.request({ id: 'H', size: 50, retention: 5, requester: 'q' });
  const second = sys.restore({ ticks: 1 });

  // L was evicted to make room for H; eviction proof is on the cert chain.
  assert.equal(sys.objects.get('L').status, 'evicted');
  assert.equal(sys.objects.get('H').status, 'verified');
  assert.equal(sys.stagingUsed, 50);
  const slice = second.timeSlices[0];
  assert.equal(slice.evicted.length, 1);
  assert.equal(slice.evicted[0].object, 'L');
  assert.match(slice.evicted[0].reason, /preempted-by:H/);
  const evictCert = sys.certs.find((c) => c.action === 'evict' && c.object === 'L');
  assert.ok(evictCert, 'eviction proof certificate exists');
  assert.equal(slice.evicted[0].proof, evictCert.hash);
  assert.ok(sys.verify().ok);

  // Undo the preemption generation: L is restored, H goes back to pending.
  sys.undo();
  assert.equal(sys.objects.get('L').status, 'verified');
  assert.equal(sys.objects.get('L').allocated, true);
  assert.equal(sys.objects.get('H').status, 'pending');
  assert.equal(sys.objects.get('H').allocated, false);
  assert.equal(sys.stagingUsed, 60);
  assert.ok(!sys.certs.some((c) => c.action === 'evict'), 'eviction proof rolled back');
  assert.ok(sys.verify().ok);
});

test('locked objects are never preempted', () => {
  const sys = new ArchiveSystem({ bandwidth: 1000, staging: 100 });
  sys.request({ id: 'locked-low', size: 80, retention: 1, requester: 'q', locked: true });
  sys.restore({ ticks: 1 });
  sys.request({ id: 'high', size: 50, retention: 9, requester: 'q' });
  const res = sys.restore({ ticks: 1 });
  assert.equal(sys.objects.get('locked-low').status, 'verified');
  assert.equal(sys.objects.get('high').status, 'pending'); // waits, cannot preempt
  assert.equal(res.timeSlices[0].evicted.length, 0);
});

test('object larger than staging fails with disk-full', () => {
  const sys = new ArchiveSystem({ bandwidth: 1000, staging: 100 });
  sys.request({ id: 'huge', size: 101, retention: 9, requester: 'q' });
  const res = sys.restore({ ticks: 1 });
  assert.equal(sys.objects.get('huge').status, 'failed');
  assert.equal(sys.objects.get('huge').failReason, 'disk-full');
  assert.deepEqual(res.failures, [{ object: 'huge', reason: 'disk-full' }]);
});
