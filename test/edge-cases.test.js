'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Engine } = require('../src/engine');
const { reduceOps, evaluateAll, snapshotFrom } = require('../src/reference');

function assertMatchesReference(eng) {
  const snap = eng.snapshot();
  const ref = snapshotFrom(evaluateAll(reduceOps(eng.history())));
  assert.deepStrictEqual(snap.values, ref.values);
  assert.deepStrictEqual(snap.invalid, ref.invalid);
  assert.deepStrictEqual(snap.errors, ref.errors);
}

// Acceptance 3a: missing control => E_QC on everything downstream, stable.
test('missing control produces E_QC that propagates and later recovers', () => {
  const eng = new Engine();
  eng.apply({ type: 'addPlate', plate: 'P' });
  eng.apply({ type: 'setWell', plate: 'P', well: 'W1', value: 1.5 });
  eng.apply({ type: 'addGroup', group: 'G' });
  eng.apply({ type: 'addToGroup', group: 'G', plate: 'P', well: 'W1' });

  let snap = eng.snapshot();
  for (const id of ['ctrl:P:neg', 'ctrl:P:pos', 'corr:P:W1', 'ratio:P:W1', 'mean:P', 'rep:G:mean', 'rep:G:cv']) {
    assert.equal(snap.values[id].error, 'E_QC', id);
  }
  assertMatchesReference(eng);

  // Map the negative control: corr/mean/rep mean recover, ratio still E_QC.
  eng.apply({ type: 'setControl', plate: 'P', kind: 'neg', well: 'W1' });
  snap = eng.snapshot();
  assert.equal(snap.values['corr:P:W1'].error, null);
  assert.equal(snap.values['corr:P:W1'].value, 0);
  assert.equal(snap.values['ratio:P:W1'].error, 'E_QC');
  assertMatchesReference(eng);

  // Control mapping pointing at a non-existent well => E_QC again.
  eng.apply({ type: 'setControl', plate: 'P', kind: 'neg', well: 'NOPE' });
  snap = eng.snapshot();
  assert.equal(snap.values['ctrl:P:neg'].error, 'E_QC');
  assert.equal(snap.values['ctrl:P:neg'].reason, 'neg control well missing');
  assert.equal(snap.values['corr:P:W1'].error, 'E_QC');
  assertMatchesReference(eng);
});

// Acceptance 3b: single-well replicate group => mean ok, CV is E_QC.
test('single-well replicate group keeps mean but flags CV as E_QC', () => {
  const eng = new Engine();
  eng.apply({ type: 'addPlate', plate: 'P' });
  eng.apply({ type: 'setWell', plate: 'P', well: 'W1', value: 2.0 });
  eng.apply({ type: 'setControl', plate: 'P', kind: 'neg', well: 'W1' });
  eng.apply({ type: 'setControl', plate: 'P', kind: 'pos', well: 'W1' });
  eng.apply({ type: 'addGroup', group: 'G' });
  const cert = eng.apply({ type: 'addToGroup', group: 'G', plate: 'P', well: 'W1' });
  assert.equal(cert.changed['rep:G:mean'].error, null);
  assert.equal(cert.changed['rep:G:cv'].error, 'E_QC');
  assert.equal(cert.changed['rep:G:cv'].reason, 'insufficient replicates');
  assertMatchesReference(eng);
});

// CV denominator (mean) of zero => invalid, not an error.
test('CV with zero denominator is marked invalid', () => {
  const eng = new Engine();
  eng.apply({ type: 'addPlate', plate: 'P' });
  eng.apply({ type: 'setWell', plate: 'P', well: 'N', value: 1.0 });
  eng.apply({ type: 'setWell', plate: 'P', well: 'A', value: 0.0 }); // corr -1
  eng.apply({ type: 'setWell', plate: 'P', well: 'B', value: 2.0 }); // corr +1
  eng.apply({ type: 'setControl', plate: 'P', kind: 'neg', well: 'N' });
  eng.apply({ type: 'addGroup', group: 'G' });
  eng.apply({ type: 'addToGroup', group: 'G', plate: 'P', well: 'A' });
  const cert = eng.apply({ type: 'addToGroup', group: 'G', plate: 'P', well: 'B' });
  assert.equal(cert.changed['rep:G:cv'].invalid, true);
  assert.equal(cert.changed['rep:G:cv'].error, null);
  assert.deepStrictEqual(eng.snapshot().invalid, ['rep:G:cv']);
  assertMatchesReference(eng);
});

// Empty replicate group => E_QC on both aggregate nodes.
test('empty replicate group returns E_QC', () => {
  const eng = new Engine();
  eng.apply({ type: 'addGroup', group: 'G' });
  const snap = eng.snapshot();
  assert.equal(snap.values['rep:G:mean'].error, 'E_QC');
  assert.equal(snap.values['rep:G:mean'].reason, 'empty replicate group');
  assert.equal(snap.values['rep:G:cv'].error, 'E_QC');
  assertMatchesReference(eng);
});

// Acceptance 3c: empty plate stays stable; undo of its creation removes nodes.
test('empty plate is stable and fully undoable', () => {
  const eng = new Engine();
  const cert = eng.apply({ type: 'addPlate', plate: 'P' });
  const snap = eng.snapshot();
  assert.equal(snap.values['mean:P'].error, 'E_QC');
  assert.equal(snap.values['mean:P'].reason, 'empty plate');
  assert.equal(snap.values['ctrl:P:neg'].error, 'E_QC');
  assert.deepStrictEqual(Object.keys(snap.values).sort(), ['ctrl:P:neg', 'ctrl:P:pos', 'mean:P']);
  assertMatchesReference(eng);

  const undoCert = eng.apply({ type: 'undo' });
  assert.deepStrictEqual(eng.snapshot().values, {});
  assert.deepStrictEqual(undoCert.changed, {
    'ctrl:P:neg': null,
    'ctrl:P:pos': null,
    'mean:P': null,
  });
  assert.ok(cert.seq + 1 === undoCert.seq);
});

// Acceptance 3d: undo then a fresh modification clears the redo stack;
// redo afterwards is a stable no-op.
test('modify after undo clears redo; empty undo/redo are stable no-ops', () => {
  const eng = new Engine();
  eng.apply({ type: 'addPlate', plate: 'P' });
  eng.apply({ type: 'setWell', plate: 'P', well: 'W1', value: 1.0 });
  eng.apply({ type: 'undo' }); // remove W1
  eng.apply({ type: 'setWell', plate: 'P', well: 'W2', value: 2.0 }); // clears redo

  const before = eng.snapshot();
  const redoCert = eng.apply({ type: 'redo' }); // nothing to redo
  assert.deepStrictEqual(redoCert.changed, {});
  assert.deepStrictEqual(redoCert.recomputed, []);
  assert.deepStrictEqual(eng.snapshot(), before);

  // Undo on an exhausted stack is also a stable no-op.
  const fresh = new Engine();
  const c = fresh.apply({ type: 'undo' });
  assert.deepStrictEqual(c.changed, {});
  assert.deepStrictEqual(fresh.snapshot().values, {});
  const c2 = fresh.apply({ type: 'redo' });
  assert.deepStrictEqual(c2.changed, {});
});

// Undo/redo round-trips through a multi-op history exactly.
test('undo/redo round-trip reproduces every intermediate state', () => {
  const eng = new Engine();
  const ops = [
    { type: 'addPlate', plate: 'P' },
    { type: 'setWell', plate: 'P', well: 'W1', value: 0.5 },
    { type: 'setWell', plate: 'P', well: 'W2', value: 1.5 },
    { type: 'setControl', plate: 'P', kind: 'neg', well: 'W1' },
    { type: 'setControl', plate: 'P', kind: 'pos', well: 'W2' },
    { type: 'addGroup', group: 'G' },
    { type: 'addToGroup', group: 'G', plate: 'P', well: 'W1' },
    { type: 'addToGroup', group: 'G', plate: 'P', well: 'W2' },
    { type: 'removeWell', plate: 'P', well: 'W2' },
  ];
  const states = [];
  for (const op of ops) {
    eng.apply(op);
    states.push(eng.snapshot());
  }
  for (let i = ops.length - 1; i >= 1; i--) {
    eng.apply({ type: 'undo' });
    assert.deepStrictEqual(eng.snapshot(), states[i - 1], `after ${ops.length - i} undo(s)`);
  }
  for (let i = 1; i < ops.length; i++) {
    eng.apply({ type: 'redo' });
    assert.deepStrictEqual(eng.snapshot(), states[i], `after ${i} redo(s)`);
  }
  assertMatchesReference(eng);
});
