import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../src/lineage.js';
import { minimizeDfa, findWitness, reachableDefectSet } from '../src/dfa.js';
import { equivViews } from '../src/system.js';

// Acceptance 1: isomorphic but differently-named lineages minimize to the
// same number of states.
test('isomorphic lineages with different names minimize to the same count', () => {
  const recordsA = [
    { batch: 'a0', defects: [], on: { merge: 'a1' } },
    { batch: 'a1', parents: ['a0'], defects: ['d1'], on: { test: 'a2' } },
    { batch: 'a2', parents: ['a1'], defects: [], on: { ship: 'a2' } },
  ];
  const recordsB = [
    { batch: 'LOT-7', defects: [], on: { merge: 'LOT-9' } },
    { batch: 'LOT-9', parents: ['LOT-7'], defects: ['d1'], on: { test: 'LOT-11' } },
    { batch: 'LOT-11', parents: ['LOT-9'], defects: [], on: { ship: 'LOT-11' } },
  ];
  const minA = minimizeDfa(buildView(recordsA));
  const minB = minimizeDfa(buildView(recordsB));
  assert.equal(minA.minStates, minB.minStates);
  // 3 batch states + the implicit sink (partial transitions totalize to it).
  assert.equal(minA.minStates, 4);

  const { equal, witness, minStates } = equivViews(buildView(recordsA), buildView(recordsB));
  assert.equal(equal, true);
  assert.equal(witness, null);
  assert.deepEqual(minStates, [4, 4]);
});

test('minimization merges equivalent states and preserves defect sets', () => {
  const records = [
    { batch: 'root', defects: [], on: { merge: 'm1', split: 'm2' } },
    { batch: 'm1', parents: ['root'], defects: ['d1'], on: { test: 'end' } },
    { batch: 'm2', parents: ['root'], defects: ['d1'], on: { test: 'end' } },
    { batch: 'end', parents: ['m1', 'm2'], defects: [], on: { ship: 'end' } },
  ];
  const view = buildView(records);
  const { minStates, classOf, view: minView } = minimizeDfa(view);
  // m1 and m2 merge; the implicit sink is not reachable here (all reachable
  // transitions are defined, except m1/m2/end have no merge/split -> sink).
  assert.equal(classOf.get('m1'), classOf.get('m2'));
  for (const name of view.states.keys()) {
    assert.deepEqual(
      reachableDefectSet(minView, classOf.get(name)),
      reachableDefectSet(view, name),
    );
  }
  assert.ok(minStates < view.states.size + 1);
});

// Acceptance 2: non-equivalent views yield the shortest distinguishing
// symbol string (defect sets differ only after "merge test").
test('non-equivalent views produce the shortest witness', () => {
  const recordsA = [
    { batch: 's0', defects: [], on: { merge: 's1' } },
    { batch: 's1', parents: ['s0'], defects: [], on: { test: 's2' } },
    { batch: 's2', parents: ['s1'], defects: ['dx'], on: { ship: 's2' } },
  ];
  const recordsB = [
    { batch: 't0', defects: [], on: { merge: 't1' } },
    { batch: 't1', parents: ['t0'], defects: [], on: { test: 't2' } },
    { batch: 't2', parents: ['t1'], defects: [], on: { ship: 't2' } },
  ];
  const { equal, witness } = equivViews(buildView(recordsA), buildView(recordsB));
  assert.equal(equal, false);
  assert.deepEqual(witness, ['merge', 'test']);

  // Minimality: no shorter string distinguishes the two views.
  const viewA = buildView(recordsA);
  const viewB = buildView(recordsB);
  assert.deepEqual(viewA.states.get('s0').defects, viewB.states.get('t0').defects);
  assert.deepEqual(viewA.states.get('s1').defects, viewB.states.get('t1').defects);
  assert.equal(findWitness(viewA, viewB).length, 2);
});

test('pending states are real states, never pruned as unsatisfiable', () => {
  const records = [
    { batch: 'root', defects: [], on: { test: 'awaiting', ship: 'done' } },
    { batch: 'awaiting', parents: ['root'], defects: [], pending: true },
    { batch: 'done', parents: ['root'], defects: [], on: { ship: 'done' } },
  ];
  const view = buildView(records);
  const { minStates, classOf } = minimizeDfa(view);
  // awaiting (pending, no outgoing) must survive minimization and must not
  // merge with any non-pending state. done is bisimilar to the sink (both
  // are terminal views with an empty defect set), so they share a class.
  assert.ok(classOf.has('awaiting'));
  assert.notEqual(classOf.get('awaiting'), classOf.get('done'));
  assert.notEqual(classOf.get('awaiting'), classOf.get(null));
  assert.equal(classOf.get('done'), classOf.get(null));
  assert.equal(minStates, 3); // root, awaiting, done==sink
});

test('empty view minimizes to zero states', () => {
  const { minStates } = minimizeDfa(buildView([]));
  assert.equal(minStates, 0);
});
