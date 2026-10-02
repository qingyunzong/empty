'use strict';

// Acceptance 3: correcting a parent volume's checksum re-verifies only the
// affected child volumes; unrelated objects are untouched. A pending parent
// never makes a child unrecoverable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ArchiveSystem } = require('../lib/archive');

function buildVerifiedTree() {
  const sys = new ArchiveSystem({ bandwidth: 1000, staging: 1000 });
  sys.request({ id: 'P', size: 10, retention: 3, requester: 'q' });
  sys.request({ id: 'A', size: 10, retention: 3, requester: 'q', parent: 'P' });
  sys.request({ id: 'B', size: 10, retention: 3, requester: 'q', parent: 'P' });
  sys.request({ id: 'G', size: 10, retention: 3, requester: 'q', parent: 'A' }); // grandchild
  sys.request({ id: 'U', size: 10, retention: 3, requester: 'q' }); // unrelated
  sys.restore({ ticks: 3 });
  for (const id of ['P', 'A', 'B', 'G', 'U']) {
    assert.equal(sys.objects.get(id).status, 'verified', `${id} verified`);
  }
  return sys;
}

test('parent correction re-verifies only affected child volumes', () => {
  const sys = buildVerifiedTree();
  const before = sys.verify();
  const genBefore = before.generation;
  assert.equal(before.objects.U.verifiedGen, genBefore);

  const result = sys.correct('P');
  const affected = result.reverified.map((r) => r.id).sort();
  assert.deepEqual(affected, ['A', 'B', 'G', 'P'], 'subtree re-verified');
  assert.ok(result.reverified.every((r) => r.ok));

  const after = sys.verify();
  assert.ok(after.ok);
  const genAfter = after.generation;
  assert.ok(genAfter > genBefore);
  for (const id of ['P', 'A', 'B', 'G']) {
    assert.equal(after.objects[id].verifiedGen, genAfter, `${id} re-verified at new generation`);
  }
  assert.equal(after.objects.U.verifiedGen, genBefore, 'unrelated object untouched');
  assert.ok(sys.certs.some((c) => c.action === 'correct' && c.object === 'P'));
});

test('correct fixes a bad checksum so the object can restore', () => {
  const sys = new ArchiveSystem({ bandwidth: 1000, staging: 1000 });
  sys.request({ id: 'X', size: 10, retention: 1, requester: 'q', checksum: 'deadbeef' });
  const res = sys.restore({ ticks: 1 });
  assert.deepEqual(res.failures, [{ object: 'X', reason: 'checksum-error' }]);
  assert.equal(sys.objects.get('X').status, 'failed');

  sys.correct('X');
  assert.equal(sys.objects.get('X').status, 'pending');
  const res2 = sys.restore({ ticks: 1 });
  assert.equal(res2.failures.length, 0);
  assert.equal(sys.objects.get('X').status, 'verified');
  assert.ok(sys.verify().ok);
});

test('pending parent volume does not make child unrecoverable', () => {
  const sys = new ArchiveSystem({ bandwidth: 1000, staging: 1000 });
  sys.request({ id: 'parent', size: 10, retention: 1, requester: 'q' });
  sys.request({ id: 'child', size: 10, retention: 1, requester: 'q', parent: 'parent' });
  // Parent too big to ever restore? No: parent simply never scheduled because
  // we fail it via a bad checksum. Child must wait, not be judged failed.
  sys.objects.get('parent').checksum = 'bogus';
  sys.restore({ ticks: 2 });
  assert.equal(sys.objects.get('parent').status, 'failed');
  assert.equal(sys.objects.get('child').status, 'pending');
  assert.equal(sys.objects.get('child').failReason, null);
  // Once the parent is corrected and restored, the child recovers.
  sys.correct('parent');
  sys.restore({ ticks: 2 });
  assert.equal(sys.objects.get('parent').status, 'verified');
  assert.equal(sys.objects.get('child').status, 'verified');
  assert.ok(sys.verify().ok);
});
