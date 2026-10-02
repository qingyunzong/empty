import test from 'node:test';
import assert from 'node:assert/strict';
import { isConcurrent } from '../src/clock.js';
import { compareVersions } from '../src/store.js';
import { makeStore, doOp, doMerge, dump, visible, canonical } from './helpers.js';

const NODES = ['A', 'B', 'C'];

// Three replicas concurrently correct the same observation; merging the
// replicas in every possible order must converge to the same visible state,
// and that state must equal the deterministic reference winner.
test('acceptance 1: three-way concurrent corrections converge under all merge permutations', () => {
  const dA = makeStore(NODES, { node: 'A' });
  const dB = makeStore(NODES, { node: 'B' });
  const dC = makeStore(NODES, { node: 'C' });

  doOp(dA, 'put', [{ key: 'obs-1', value: 'v0' }]);
  const base = dump(dA);
  doMerge(dB, base);
  doMerge(dC, base);

  doOp(dA, 'correct', [{ key: 'obs-1', value: 'va' }]);
  doOp(dB, 'correct', [{ key: 'obs-1', value: 'vb' }]);
  doOp(dC, 'correct', [{ key: 'obs-1', value: 'vc' }]);

  const dumps = { A: dump(dA), B: dump(dB), C: dump(dC) };
  const currentOf = (d) => d.find((l) => l.type === 'record' && l.record.key === 'obs-1').record;

  // The three corrections are pairwise concurrent (vector clocks).
  const clocks = ['A', 'B', 'C'].map((n) => currentOf(dumps[n]).clock);
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      assert.ok(isConcurrent(clocks[i], clocks[j]), `corrections ${i} and ${j} must be concurrent`);
    }
  }

  // Reference winner: max under the causality-consistent total order
  // (lamport, origin, value) — no physical clocks involved.
  const versions = ['A', 'B', 'C'].map((n) => currentOf(dumps[n]).history.at(-1));
  const reference = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));

  const permutations = [
    ['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C'],
    ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A'],
  ];
  const outcomes = permutations.map((perm) => {
    const dir = makeStore([...NODES, 'R'], { node: 'R' });
    for (const n of perm) doMerge(dir, dumps[n]);
    return { visible: visible(dir), canonical: canonical(dir) };
  });

  for (let i = 1; i < outcomes.length; i++) {
    assert.deepEqual(outcomes[i].visible, outcomes[0].visible, `permutation ${permutations[i]} diverged`);
    assert.deepEqual(outcomes[i].canonical, outcomes[0].canonical, `permutation ${permutations[i]} state diverged`);
  }
  assert.deepEqual(outcomes[0].visible, { 'obs-1': reference.value });
  assert.equal(reference.value, 'vc'); // lamport ties at 2, origin 'C' wins deterministically

  // Full history is preserved on every replica (corrections leave a trace).
  const merged = makeStore([...NODES, 'R'], { node: 'R' });
  for (const n of ['A', 'B', 'C']) doMerge(merged, dumps[n]);
  const rec = dump(merged).find((l) => l.type === 'record').record;
  assert.equal(rec.history.length, 4); // put + 3 concurrent corrections
  assert.deepEqual(rec.history.map((v) => v.value).sort(), ['v0', 'va', 'vb', 'vc']);
});

test('merge is associative across groupings and idempotent on redelivery', () => {
  const dA = makeStore(NODES, { node: 'A' });
  const dB = makeStore(NODES, { node: 'B' });
  const dC = makeStore(NODES, { node: 'C' });
  doOp(dA, 'put', [{ key: 'k1', value: 1 }, { key: 'k2', value: 2 }]);
  doOp(dB, 'put', [{ key: 'k3', value: 3 }]);
  doOp(dC, 'put', [{ key: 'k4', value: 4 }]);
  const [dumpA, dumpB, dumpC] = [dump(dA), dump(dB), dump(dC)];

  // (A ∪ B) ∪ C
  const left = makeStore([...NODES, 'R'], { node: 'R' });
  doMerge(left, dumpA);
  doMerge(left, dumpB);
  doMerge(left, dumpC);
  // A ∪ (B ∪ C)
  const right = makeStore([...NODES, 'R'], { node: 'R' });
  doMerge(right, dumpB);
  doMerge(right, dumpC);
  doMerge(right, dumpA);
  assert.deepEqual(canonical(left), canonical(right));

  // Idempotent: merging the same dumps again changes nothing.
  const before = canonical(left);
  doMerge(left, dumpA);
  doMerge(left, dumpB);
  doMerge(left, dumpC);
  assert.deepEqual(canonical(left), before);

  // Merge outcomes report concurrency; replayed deliveries are "kept".
  const fresh = makeStore(NODES, { node: 'B' });
  doOp(fresh, 'put', [{ key: 'x', value: 'local' }]);
  const remote = makeStore(NODES, { node: 'A' });
  doOp(remote, 'put', [{ key: 'x', value: 'remote' }]);
  const r1 = doMerge(fresh, dump(remote));
  // Concurrent puts: deterministic loser (origin 'A' < 'B') is superseded but
  // the merge still reports that the two histories were concurrent.
  assert.equal(r1[0].outcome, 'superseded');
  assert.equal(r1[0].concurrent, true);
  assert.equal(visible(fresh).x, 'local');
  // Redelivering the same dump is still 'superseded' but changes nothing.
  const stateBefore = canonical(fresh);
  const r2 = doMerge(fresh, dump(remote));
  assert.equal(r2[0].outcome, 'superseded');
  assert.deepEqual(canonical(fresh), stateBefore);
  // Echoing a store's own dump back reports 'kept' and changes nothing.
  const r3 = doMerge(fresh, dump(fresh));
  assert.ok(r3.every((r) => r.outcome === 'kept'));
  assert.deepEqual(canonical(fresh), stateBefore);
});
