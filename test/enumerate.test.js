import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateSafeConvergence, referenceSafeState, FAULT_POINTS } from '../src/index.js';

// n <= 7 exhaustive enumeration: every subset of dangerous params x every
// fault point must converge to the reference safe state after recovery.
for (let n = 1; n <= 7; n += 1) {
  test(`safe convergence enumeration n=${n} (${2 ** n} subsets x ${FAULT_POINTS.length} fault points)`, () => {
    const { scenarios, converged, failures } = enumerateSafeConvergence(n);
    assert.equal(scenarios, 2 ** n * FAULT_POINTS.length);
    assert.ok(converged, `failures: ${JSON.stringify(failures.slice(0, 3))}`);
  });
}

test('reference safe state is all-safe for n<=7', () => {
  assert.deepEqual(referenceSafeState(3), { k0: 0, k1: 0, k2: 0 });
  assert.throws(() => enumerateSafeConvergence(8), /1\.\.7/);
});
