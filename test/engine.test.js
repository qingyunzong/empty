'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { fullRecompute } = require('../src/reference');

function setup() {
  const eng = new Engine();
  eng.addPlate('P1');
  eng.addWell('P1', 'A1', 0.1);
  eng.addWell('P1', 'A2', 0.5);
  eng.addWell('P1', 'A3', 1.0);
  eng.addWell('P1', 'A4', 2.0);
  eng.setControl('P1', 'neg', 'A1');
  eng.setControl('P1', 'pos', 'A3');
  return eng;
}

const val = (eng, id) => eng.outputs.get(id);

test('derived values: corrected, ratio, plate mean', () => {
  const eng = setup();
  assert.equal(val(eng, 'corr:P1:A2').value, 0.4);
  assert.equal(val(eng, 'ratio:P1:A2').value, 0.5);
  assert.equal(val(eng, 'plateMean:P1').value, (0 + 0.4 + 0.9 + 1.9) / 4);
});

test('replicate mean and CV', () => {
  const eng = setup();
  eng.addReplicate('G1', ['P1/A2', 'P1/A3']);
  // corrected values: 0.4, 0.9 -> mean 0.65, population sd 0.25
  assert.equal(val(eng, 'repMean:G1').value, 0.65);
  assert.ok(Math.abs(val(eng, 'repCV:G1').value - 0.25 / 0.65) < 1e-12);
});

test('missing control yields E_QC and propagates to dependents', () => {
  const eng = new Engine();
  eng.addPlate('P1');
  eng.addWell('P1', 'A1', 0.5);
  assert.equal(val(eng, 'negCtrl:P1').error, 'E_QC');
  assert.equal(val(eng, 'corr:P1:A1').error, 'E_QC');
  assert.equal(val(eng, 'ratio:P1:A1').error, 'E_QC');
  assert.equal(val(eng, 'plateMean:P1').error, 'E_QC');
  eng.setControl('P1', 'neg', 'A1');
  assert.equal(val(eng, 'corr:P1:A1').value, 0);
  assert.equal(val(eng, 'ratio:P1:A1').error, 'E_QC'); // pos still missing
  // control pointing at a nonexistent well also errors
  eng.setControl('P1', 'pos', 'NOPE');
  assert.equal(val(eng, 'posCtrl:P1').error, 'E_QC');
  assert.equal(val(eng, 'ratio:P1:A1').error, 'E_QC');
});

test('empty replicate yields E_QC', () => {
  const eng = setup();
  eng.addReplicate('G1', []);
  assert.equal(val(eng, 'repMean:G1').error, 'E_QC');
  assert.equal(val(eng, 'repCV:G1').error, 'E_QC');
});

test('single-well replicate is stable: CV = 0, not invalid', () => {
  const eng = setup();
  const res = eng.addReplicate('G1', ['P1/A2']);
  assert.equal(val(eng, 'repMean:G1').value, 0.4);
  assert.equal(val(eng, 'repCV:G1').value, 0);
  assert.equal(val(eng, 'repCV:G1').invalid, false);
  assert.deepEqual(eng.getSnapshot().invalid, []);
  assert.ok(res.certificate.hash);
});

test('CV with zero denominator is marked invalid', () => {
  const eng = new Engine();
  eng.addPlate('P1');
  eng.addWell('P1', 'A1', 1.0);
  eng.addWell('P1', 'A2', 2.0);
  eng.addWell('P1', 'A3', 0.0);
  eng.setControl('P1', 'neg', 'A1');
  eng.setControl('P1', 'pos', 'A2');
  eng.addReplicate('G1', ['P1/A2', 'P1/A3']); // corrected: +1, -1 -> mean 0
  assert.equal(val(eng, 'repMean:G1').value, 0);
  assert.equal(val(eng, 'repCV:G1').invalid, true);
  assert.equal(val(eng, 'repCV:G1').value, null);
  assert.deepEqual(eng.getSnapshot().invalid, ['repCV:G1']);
});

test('ratio with zero positive control is marked invalid', () => {
  const eng = new Engine();
  eng.addPlate('P1');
  eng.addWell('P1', 'A1', 0.0);
  eng.addWell('P1', 'A2', 0.5);
  eng.setControl('P1', 'neg', 'A2');
  eng.setControl('P1', 'pos', 'A1');
  assert.equal(val(eng, 'ratio:P1:A2').invalid, true);
});

test('acceptance 2: moving a well invalidates exactly the two replicate groups', () => {
  const eng = setup();
  eng.addReplicate('G1', ['P1/A3', 'P1/A4']);
  eng.addReplicate('G2', ['P1/A2']);
  const before = eng.getSnapshot().hash;
  const res = eng.moveWell('G1', 'G2', 'P1/A4');
  assert.notEqual(res.certificate.hash, before);
  assert.deepEqual(
    res.certificate.invalidated,
    ['repMean:G1', 'repMean:G2', 'repCV:G1', 'repCV:G2'],
  );
  // the moved well's own corrected value is untouched
  assert.ok(!res.certificate.invalidated.some((id) => id.includes('corr')));
  // incremental state matches full enumeration
  const ref = fullRecompute(eng.state);
  for (const [id, out] of ref) assert.deepEqual(val(eng, id), out);
  // undo restores both groups
  eng.undo();
  assert.deepEqual([...eng.state.reps.get('G1')], ['P1/A3', 'P1/A4']);
  assert.deepEqual([...eng.state.reps.get('G2')], ['P1/A2']);
});

test('undo/redo round-trips state and hash', () => {
  const eng = setup();
  const h0 = eng.getSnapshot().hash;
  eng.setAbsorbance('P1', 'A2', 0.9);
  assert.equal(val(eng, 'corr:P1:A2').value, 0.8);
  const r1 = eng.undo();
  assert.equal(val(eng, 'corr:P1:A2').value, 0.4);
  assert.equal(eng.getSnapshot().hash, h0);
  assert.ok(r1.diff.some((d) => d.node === 'corr:P1:A2'));
  eng.redo();
  assert.equal(val(eng, 'corr:P1:A2').value, 0.8);
});

test('acceptance 3: undo then modify clears the redo stack', () => {
  const eng = setup();
  eng.setAbsorbance('P1', 'A2', 0.9);
  eng.undo();
  const res = eng.setAbsorbance('P1', 'A3', 1.5);
  assert.ok(!res.error);
  const redo = eng.redo();
  assert.equal(redo.error, 'E_OP');
  // state is consistent with full recompute after the divergent edit
  const ref = fullRecompute(eng.state);
  for (const [id, out] of ref) assert.deepEqual(val(eng, id), out);
});

test('acceptance 3: empty plate is a stable E_QC state', () => {
  const eng = new Engine();
  eng.addPlate('P1');
  assert.equal(val(eng, 'plateMean:P1').error, 'E_QC');
  const s1 = eng.getSnapshot();
  const s2 = eng.getSnapshot();
  assert.deepEqual(s1, s2);
  // recovers once wells and controls arrive
  eng.addWell('P1', 'A1', 0.2);
  eng.setControl('P1', 'neg', 'A1');
  eng.setControl('P1', 'pos', 'A1');
  assert.equal(val(eng, 'plateMean:P1').value, 0);
});

test('control correction is incremental and matches full recompute', () => {
  const eng = setup();
  const res = eng.setControl('P1', 'neg', 'A2');
  assert.ok(res.certificate.invalidated.includes('negCtrl:P1'));
  assert.ok(res.certificate.changed.includes('plateMean:P1'));
  const ref = fullRecompute(eng.state);
  for (const [id, out] of ref) assert.deepEqual(val(eng, id), out);
});

test('op-level errors do not mutate state', () => {
  const eng = setup();
  const h = eng.getSnapshot().hash;
  assert.equal(eng.addWell('P9', 'A1', 1).error, 'E_OP');
  assert.equal(eng.moveWell('G1', 'G2', 'P1/A1').error, 'E_OP');
  assert.equal(eng.undoStack.length > 0, true);
  assert.equal(eng.getSnapshot().hash, h);
});
