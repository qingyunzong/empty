import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvents, replay } from '../src/store.js';
import { certificate, proveConvergence, computeDigest } from '../src/digest.js';
import { scenario, shuffle } from './helpers.js';

test('three shuffled replicas converge to the same state as canonical full replay', () => {
  const events = scenario();
  const replicaA = shuffle(events, 11);
  const replicaB = shuffle(events, 22);
  const replicaC = shuffle(events, 33);

  const expected = replay(events);
  const merged = mergeEvents(replicaA, replicaB, replicaC);
  const actual = replay(merged);

  assert.deepEqual(actual, expected);
  assert.deepEqual(certificate(merged, actual), certificate(events, expected));

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const shuffled = shuffle(events, seed * 1000 + 7);
    assert.deepEqual(replay(shuffled), expected, `shuffle seed ${seed}`);
  }
});

test('replica digests prove convergence after anti-entropy merge', () => {
  const events = scenario();
  const a = shuffle(events, 1);
  const b = shuffle(events, 2);
  const merged = mergeEvents(a, b);
  const proof = proveConvergence(computeDigest(merged), computeDigest(events));
  assert.equal(proof.converged, true);
});
