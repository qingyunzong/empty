import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/store.js';
import { certificate } from '../src/digest.js';
import { permutations } from './helpers.js';

const events = [
  { id: 'e1', member: 'alpha', epoch: 1, seq: 1, type: 'join', clock: { alpha: 1 } },
  { id: 'e2', member: 'beta', epoch: 1, seq: 1, type: 'join', clock: { beta: 1 } },
  { id: 'e3', member: 'alpha', epoch: 1, seq: 2, type: 'interlock', clock: { alpha: 2 } },
  { id: 'e4', member: 'beta', epoch: 1, seq: 2, type: 'bypass', key: 'fw-1', clock: { alpha: 2, beta: 2 } },
  { id: 'e5', member: 'alpha', epoch: 1, seq: 3, type: 'unbypass', key: 'fw-1', clock: { alpha: 3, beta: 2 } },
  { id: 'e6', member: 'beta', epoch: 1, seq: 3, type: 'reset', clock: { alpha: 3, beta: 3 } },
  { id: 'e7', member: 'alpha', epoch: 1, seq: 4, type: 'interlock', clock: { alpha: 4, beta: 3 } },
  { id: 'e8', member: 'beta', epoch: 1, seq: 4, type: 'bypass', key: 'fw-2', clock: { alpha: 4, beta: 4 } },
];

test('exhaustive: every permutation of <=8 events yields the identical final state', (t) => {
  for (let n = 1; n <= events.length; n++) {
    const subset = events.slice(0, n);
    const baseline = replay(subset);
    const baselineCert = certificate(subset, baseline);
    let checked = 0;
    for (const perm of permutations(subset)) {
      const state = replay(perm);
      assert.deepEqual(state, baseline, `n=${n} divergent permutation`);
      assert.deepEqual(certificate(perm, state), baselineCert, `n=${n} divergent certificate`);
      checked++;
    }
    t.diagnostic(`n=${n}: ${checked} permutations verified`);
  }
});
