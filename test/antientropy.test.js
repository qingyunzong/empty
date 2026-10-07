import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvents, replay } from '../src/store.js';
import { computeDigest, missingRanges, proveConvergence, divergence } from '../src/digest.js';
import { scenario, shuffle } from './helpers.js';

test('anti-entropy: digest exchange pulls only missing events and proves convergence', () => {
  const all = scenario();
  const replicaA = all.filter((e) => !(e.member === 'beta' && e.seq === 3) && e.id !== 'g3');
  const replicaB = shuffle(all, 99);

  const digestA = computeDigest(replicaA);
  const digestB = computeDigest(replicaB);
  assert.notEqual(digestA.hash, digestB.hash);

  const want = missingRanges(replicaA, digestB);
  assert.deepEqual(want, { beta: [[3, 3]], gamma: [[3, 3]] });

  const pulled = replicaB.filter((e) =>
    (want[e.member] ?? []).some(([lo, hi]) => e.seq >= lo && e.seq <= hi)
  );
  assert.deepEqual(pulled.map((e) => e.id).sort(), ['b3', 'g3']);

  const healed = mergeEvents(replicaA, pulled);
  const proof = proveConvergence(computeDigest(healed), digestB);
  assert.equal(proof.converged, true);
  assert.deepEqual(replay(healed), replay(all));
});

test('divergence reports per-member intervals for mismatched digests', () => {
  const all = scenario();
  const partial = all.filter((e) => e.id !== 'a3' && e.id !== 'b3');
  const div = divergence(computeDigest(all), computeDigest(partial));
  assert.equal(div.equal, false);
  assert.deepEqual(div.members.alpha.interval, [3, 3]);
  assert.deepEqual(div.members.beta.interval, [3, 3]);
  assert.ok(!('gamma' in div.members));
});
