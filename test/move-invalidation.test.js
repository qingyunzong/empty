'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Engine } = require('../src/engine');
const { reduceOps, evaluateAll, snapshotFrom } = require('../src/reference');

function buildEngine() {
  const eng = new Engine();
  eng.apply({ type: 'addPlate', plate: 'P' });
  eng.apply({ type: 'setWell', plate: 'P', well: 'W1', value: 1.0 });
  eng.apply({ type: 'setWell', plate: 'P', well: 'W2', value: 1.2 });
  eng.apply({ type: 'setWell', plate: 'P', well: 'W3', value: 2.0 });
  eng.apply({ type: 'setWell', plate: 'P', well: 'W4', value: 2.2 });
  eng.apply({ type: 'setControl', plate: 'P', kind: 'neg', well: 'W1' });
  eng.apply({ type: 'setControl', plate: 'P', kind: 'pos', well: 'W4' });
  eng.apply({ type: 'addGroup', group: 'GA' });
  eng.apply({ type: 'addGroup', group: 'GB' });
  eng.apply({ type: 'addToGroup', group: 'GA', plate: 'P', well: 'W2' });
  eng.apply({ type: 'addToGroup', group: 'GA', plate: 'P', well: 'W3' });
  eng.apply({ type: 'addToGroup', group: 'GB', plate: 'P', well: 'W4' });
  return eng;
}

// Acceptance 2: moving a well between replicate groups invalidates exactly
// the old group's and the new group's mean/CV nodes — nothing else.
test('moving a well yields the minimal invalidation set for both groups', () => {
  const eng = buildEngine();
  const cert = eng.apply({ type: 'moveWell', plate: 'P', well: 'W3', from: 'GA', to: 'GB' });

  assert.deepStrictEqual(cert.recomputed, ['rep:GA:cv', 'rep:GA:mean', 'rep:GB:cv', 'rep:GB:mean']);
  assert.deepStrictEqual(Object.keys(cert.changed).sort(), [
    'rep:GA:cv',
    'rep:GA:mean',
    'rep:GB:cv',
    'rep:GB:mean',
  ]);

  // GA is now a single-well group: CV becomes E_QC, mean still computed.
  assert.equal(cert.changed['rep:GA:cv'].error, 'E_QC');
  assert.equal(cert.changed['rep:GA:cv'].reason, 'insufficient replicates');
  assert.equal(cert.changed['rep:GA:mean'].error, null);
  // GB now has two members: CV becomes computable.
  assert.equal(cert.changed['rep:GB:cv'].error, null);
  assert.equal(typeof cert.changed['rep:GB:cv'].value, 'number');

  // Full state still matches the from-scratch reference.
  const snap = eng.snapshot();
  const ref = snapshotFrom(evaluateAll(reduceOps(eng.history())));
  assert.deepStrictEqual(snap.values, ref.values);
  assert.deepStrictEqual(snap.invalid, ref.invalid);
  assert.deepStrictEqual(snap.errors, ref.errors);

  // Undo restores the exact prior state with the mirrored minimal set.
  const undoCert = eng.apply({ type: 'undo' });
  assert.deepStrictEqual(undoCert.recomputed, ['rep:GA:cv', 'rep:GA:mean', 'rep:GB:cv', 'rep:GB:mean']);
  const restored = eng.snapshot();
  assert.equal(restored.values['rep:GB:cv'].error, 'E_QC');
  assert.equal(restored.values['rep:GA:cv'].error, null);
});

// Control re-mapping propagates through corr to the plate mean and to any
// replicate group referencing the plate, but never to unrelated nodes.
test('control re-mapping invalidates exactly the dependent subgraph', () => {
  const eng = buildEngine();
  // A second plate with no groups: its nodes must stay untouched.
  eng.apply({ type: 'addPlate', plate: 'Q' });
  eng.apply({ type: 'setWell', plate: 'Q', well: 'W1', value: 0.5 });

  const cert = eng.apply({ type: 'setControl', plate: 'P', kind: 'neg', well: 'W2' });
  const expected = [
    'corr:P:W1', 'corr:P:W2', 'corr:P:W3', 'corr:P:W4',
    'ctrl:P:neg',
    'mean:P',
    'ratio:P:W1', 'ratio:P:W2', 'ratio:P:W3', 'ratio:P:W4',
    'rep:GA:cv', 'rep:GA:mean', 'rep:GB:cv', 'rep:GB:mean',
  ];
  assert.deepStrictEqual(cert.recomputed, expected);
  assert.ok(cert.recomputed.every((id) => !id.includes(':Q')), 'plate Q must be untouched');
});
