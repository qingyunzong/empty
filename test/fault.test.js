'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Archive, FaultError } = require('../src/archive');

const FAULT_POINTS = ['staging', 'index', 'cert'];

function build() {
  const archive = new Archive({ stagingCapacity: 100, bandwidthPerTick: 8 });
  archive.request({ id: 'a', size: 10, retention: 5, requester: 'r1' });
  archive.request({ id: 'b', size: 10, retention: 7, requester: 'r2' });
  return archive;
}

test('acceptance 4: verify is deterministic after fault injection at each write point', () => {
  for (const point of FAULT_POINTS) {
    const archive = build();
    const generationBefore = archive.state.generation;
    const before = archive.verify();

    assert.throws(() => archive.restore({ failAt: point }), (err) => {
      assert.ok(err instanceof FaultError);
      assert.equal(err.point, point);
      return true;
    });

    const after = archive.verify();
    assert.deepEqual(after, before, `state diverged after fault at ${point}`);
    assert.equal(archive.state.generation, generationBefore);
    assert.equal(archive.state.objects.a.status, 'pending');
    assert.equal(archive.state.objects.b.status, 'pending');
    assert.equal(archive.state.certificates.length, 0);

    // a clean retry succeeds and verifies
    const result = archive.restore();
    assert.equal(result.placement.length, 2);
    const report = archive.verify();
    assert.ok(report.ok);
    assert.ok(report.chainOk);
  }
});

test('undo rolls back transaction generations in order', () => {
  const archive = build();
  archive.restore();
  const genAfterRestore = archive.state.generation;
  archive.correct('a', '0'.repeat(64));
  archive.undo(1);
  assert.equal(archive.state.generation, genAfterRestore);
  assert.notEqual(archive.state.objects.a.checksum, '0'.repeat(64));
  archive.undo(1);
  assert.equal(archive.state.objects.a.status, 'pending');
  assert.equal(archive.state.certificates.length, 0);
  assert.throws(() => archive.undo(99), /cannot undo/);
});
