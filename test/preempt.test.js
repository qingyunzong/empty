'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Archive } = require('../src/archive');

test('acceptance 2: staging full, high retention preempts low retention and undo restores', () => {
  const archive = new Archive({ stagingCapacity: 100, bandwidthPerTick: 16 });
  archive.request({ id: 'low1', size: 60, retention: 1, requester: 'r1' });
  archive.request({ id: 'low2', size: 40, retention: 2, requester: 'r1' });
  archive.restore();
  assert.equal(archive.state.objects.low1.status, 'staged');
  assert.equal(archive.state.objects.low2.status, 'staged');

  archive.request({ id: 'high', size: 80, retention: 9, requester: 'r2' });
  const result = archive.restore();

  assert.equal(archive.state.objects.high.status, 'staged');
  assert.equal(archive.state.objects.low1.status, 'evicted');
  assert.equal(archive.state.objects.low2.status, 'evicted');
  assert.deepEqual(result.evicted.sort(), ['low1', 'low2']);

  // eviction proofs recorded in the certificate chain
  const proofs = archive.state.certificates.filter((c) => c.action === 'evict');
  assert.equal(proofs.length, 2);
  assert.deepEqual(proofs.map((p) => p.objectId).sort(), ['low1', 'low2']);
  assert.ok(proofs.every((p) => p.detail.reason === 'preemption'));
  assert.ok(archive.verify().chainOk);

  // undo rolls back the preemption generation
  archive.undo(1);
  assert.equal(archive.state.objects.low1.status, 'staged');
  assert.equal(archive.state.objects.low2.status, 'staged');
  assert.equal(archive.state.objects.high.status, 'pending');
  assert.equal(archive.state.certificates.filter((c) => c.action === 'evict').length, 0);
  assert.ok(archive.verify().ok);
});

test('locked objects are never preempted', () => {
  const archive = new Archive({ stagingCapacity: 100, bandwidthPerTick: 16 });
  archive.request({ id: 'locked-low', size: 90, retention: 1, requester: 'r1', locked: true });
  archive.restore();
  archive.request({ id: 'high', size: 50, retention: 9, requester: 'r2' });
  const result = archive.restore();
  assert.equal(archive.state.objects['locked-low'].status, 'staged');
  assert.equal(archive.state.objects.high.status, 'pending');
  assert.deepEqual(result.evicted, []);
});

test('oversized object reports disk-full failure', () => {
  const archive = new Archive({ stagingCapacity: 10, bandwidthPerTick: 16 });
  archive.request({ id: 'huge', size: 50, retention: 9, requester: 'r1' });
  const result = archive.restore();
  assert.deepEqual(result.failures, [{ id: 'huge', reason: 'disk-full' }]);
  assert.equal(archive.state.objects.huge.failReason, 'disk-full');
});
