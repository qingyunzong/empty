'use strict';

// Acceptance 4: injecting a fault at any of the three fault points (write
// staging / write index / write certificate) aborts the transaction and
// leaves verify() deterministic and identical to the pre-restore state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ArchiveSystem } = require('../lib/archive');

for (const phase of ['staging', 'index', 'cert']) {
  test(`fault injection at write-${phase} rolls back deterministically`, () => {
    const sys = new ArchiveSystem({ bandwidth: 10, staging: 100 });
    sys.request({ id: 'O', size: 5, retention: 1, requester: 'q' });
    const before = sys.verify();

    const res = sys.restore({ ticks: 1, failAt: phase });
    assert.equal(res.aborted, true);
    assert.equal(res.fault, phase);
    assert.deepEqual(res.failures, [{ reason: 'fault', phase }]);

    // State is exactly the pre-restore state.
    assert.deepEqual(sys.verify(), before);
    assert.equal(sys.objects.get('O').status, 'pending');
    assert.equal(sys.objects.get('O').progress, 0);
    assert.equal(sys.stagingUsed, 0);
    assert.equal(sys.certs.length, 0);
    assert.equal(sys.generation, 0);

    // Repeat: identical outcome.
    const res2 = sys.restore({ ticks: 1, failAt: phase });
    assert.equal(res2.aborted, true);
    assert.deepEqual(sys.verify(), before);

    // Without injection the same restore succeeds and verifies.
    const res3 = sys.restore({ ticks: 1 });
    assert.equal(res3.aborted, false);
    assert.equal(sys.objects.get('O').status, 'verified');
    assert.ok(sys.verify().ok);
  });
}

test('fault injection mid-run aborts the whole generation', () => {
  const sys = new ArchiveSystem({ bandwidth: 1000, staging: 100 });
  sys.request({ id: 'a', size: 5, retention: 1, requester: 'q' });
  sys.request({ id: 'b', size: 5, retention: 1, requester: 'q' });
  const before = sys.verify();
  const res = sys.restore({ ticks: 3, failAt: 'cert' });
  assert.equal(res.aborted, true);
  assert.deepEqual(sys.verify(), before, 'partial tick work is rolled back');
  assert.equal(sys.certs.length, 0);
});
