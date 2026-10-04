import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParamRegistry } from '../src/registry.js';
import { Store, FAULT_POINTS } from '../src/store.js';
import { tmpdir } from './helpers.js';

// Exhaustive safety-convergence check: for n = 1..7 safety-critical params,
// enumerate every subset of params corrupted to dangerous values, crash at
// every persistence fault point, recover, and compare against an independent
// brute-force reference of the expected safe state.

const SAFE_VALUE = 5;
const GOOD_VALUE = 3;
const DANGEROUS_VALUE = 999;

function enumRegistry(n) {
  return new ParamRegistry(
    Array.from({ length: n }, (_, i) => ({
      key: `p${i}`,
      type: 'number',
      min: 0,
      max: 10,
      safetyCritical: true,
    })),
  );
}

// Independent reference: corrupted keys converge to the safe value,
// everything else keeps its last good value.
function referenceState(n, corruptedMask) {
  const expected = {};
  for (let i = 0; i < n; i++) {
    expected[`p${i}`] = corruptedMask & (1 << i) ? SAFE_VALUE : GOOD_VALUE;
  }
  return expected;
}

test('n<=7 enumeration: safety convergence across all fault points', () => {
  let cases = 0;
  for (let n = 1; n <= 7; n++) {
    const registry = enumRegistry(n);
    const manifest = {
      values: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, SAFE_VALUE])),
    };
    for (let mask = 0; mask < 2 ** n; mask++) {
      for (const faultAt of FAULT_POINTS) {
        const dir = tmpdir();
        const store = new Store(dir, registry);
        for (let i = 0; i < n; i++) store.set(`p${i}`, GOOD_VALUE);
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i)) store.forceSet(`p${i}`, DANGEROUS_VALUE);
        }
        store.faultAt = faultAt;
        const fixesNeeded = mask !== 0;
        const crashesHere =
          faultAt === 'after-safe-commit' || fixesNeeded;
        if (crashesHere) {
          assert.throws(() => store.commitSafeSet(manifest), (e) => e.code === 'CRASH');
        } else {
          store.commitSafeSet(manifest);
        }
        const recovered = Store.load(dir, registry);
        const expected = referenceState(n, mask);
        const actual = Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`p${i}`, recovered.state.values[`p${i}`]]),
        );
        assert.deepEqual(actual, expected, `n=${n} mask=${mask.toString(2)} fault=${faultAt}`);
        cases++;
      }
    }
  }
  assert.equal(cases, 4 * (2 ** 8 - 2)); // 4 fault points * sum(2^n, n=1..7)
});
