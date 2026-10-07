'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Archive, sha256 } = require('../src/archive');

test('acceptance 3: correcting a parent re-verifies only affected child volumes', () => {
  const archive = new Archive({ stagingCapacity: 1000, bandwidthPerTick: 16 });
  archive.request({ id: 'parent', size: 10, retention: 5, requester: 'r1' });
  archive.request({ id: 'child1', size: 10, retention: 5, requester: 'r1', parent: 'parent' });
  archive.request({ id: 'child2', size: 10, retention: 5, requester: 'r1', parent: 'parent' });
  archive.request({ id: 'grandchild', size: 10, retention: 5, requester: 'r1', parent: 'child1' });
  archive.request({ id: 'unrelated', size: 10, retention: 5, requester: 'r2' });
  archive.restore();
  archive.restore();
  archive.restore();
  let report = archive.verify();
  assert.ok(report.ok);
  for (const entry of report.objects) assert.equal(entry.verifyCount, 1);

  const correction = archive.correct('parent', sha256('parent-v2'));
  assert.deepEqual(correction.affected, ['parent', 'child1', 'child2', 'grandchild']);

  archive.state.objects.parent.data = 'parent-v2';
  report = archive.verify();
  assert.ok(report.ok);
  const counts = Object.fromEntries(report.objects.map((o) => [o.id, o.verifyCount]));
  assert.equal(counts.parent, 2);
  assert.equal(counts.child1, 2);
  assert.equal(counts.child2, 2);
  assert.equal(counts.grandchild, 2);
  assert.equal(counts.unrelated, 1, 'unrelated volume must not be re-verified');
});

test('correcting to a wrong checksum fails verification as checksum error', () => {
  const archive = new Archive({ stagingCapacity: 100, bandwidthPerTick: 16 });
  archive.request({ id: 'obj', size: 10, retention: 5, requester: 'r1' });
  archive.restore();
  assert.ok(archive.verify().ok);
  archive.correct('obj', sha256('tampered'));
  const report = archive.verify();
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures, ['obj']);
});
