import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OvenStore } from '../src/store.js';
import { E_CONFIG, E_RATIONAL, E_STATE } from '../src/errors.js';

const LO = '9/10';
const HI = '11/10';
const K = 1;

function instructionOf(store) {
  const r = store.instruction(LO, HI, K);
  return { quantized: r.quantized.toString(), errorBound: r.errorBound.toString() };
}

// Acceptance 4: undoing a revision restores the original instruction.
test('undo restores the original instruction', () => {
  const store = new OvenStore(['1/4', '0', '-2', '0', '1']); // original zone law
  const original = instructionOf(store);
  assert.equal(original.quantized, '-7/10');

  store.begin();
  store.stage(['3', '0', '-2', '0', '1']); // revised constant term
  store.commit();
  const revised = instructionOf(store);
  assert.notDeepEqual(revised, original);

  store.undo();
  assert.deepEqual(instructionOf(store), original);
  assert.deepEqual(store.activeCoefficients(), ['1/4', '0', '-2', '0', '1']);
});

test('redo re-applies an undone revision; new commit truncates redo tail', () => {
  const store = new OvenStore(['1']);
  store.begin();
  store.stage(['2']);
  store.commit();
  store.undo();
  assert.deepEqual(store.activeCoefficients(), ['1']);
  store.redo();
  assert.deepEqual(store.activeCoefficients(), ['2']);
  store.undo();
  store.begin();
  store.stage(['3']);
  store.commit();
  assert.equal(store.canRedo(), false);
  assert.deepEqual(store.activeCoefficients(), ['3']);
});

// Illegal transactions must not change the active version.
test('illegal commit leaves the active version unchanged', () => {
  const store = new OvenStore(['1/4', '0', '-2', '0', '1']);
  const before = store.activeCoefficients();
  const beforeInstr = instructionOf(store);

  // Degree 5 -> E_CONFIG.
  store.begin();
  store.stage(['1', '2', '3', '4', '5', '6']);
  assert.throws(() => store.commit(), (err) => err.code === E_CONFIG);
  assert.deepEqual(store.activeCoefficients(), before);
  assert.deepEqual(instructionOf(store), beforeInstr);

  // Zero denominator -> E_RATIONAL.
  store.begin();
  store.stage(['1/0', '2']);
  assert.throws(() => store.commit(), (err) => err.code === E_RATIONAL);
  assert.deepEqual(store.activeCoefficients(), before);
  assert.deepEqual(instructionOf(store), beforeInstr);

  // Store still usable after failed transactions.
  store.begin();
  store.stage(['1/2']);
  store.commit();
  assert.deepEqual(store.activeCoefficients(), ['1/2']);
});

test('transaction protocol violations return E_STATE', () => {
  const store = new OvenStore(['1']);
  assert.throws(() => store.commit(), (err) => err.code === E_STATE);
  assert.throws(() => store.rollback(), (err) => err.code === E_STATE);
  assert.throws(() => store.stage(['2']), (err) => err.code === E_STATE);
  store.begin();
  assert.throws(() => store.begin(), (err) => err.code === E_STATE);
  store.rollback();
  assert.throws(() => store.undo(), (err) => err.code === E_STATE);
  assert.throws(() => store.redo(), (err) => err.code === E_STATE);
});

test('commit with nothing staged returns E_STATE and keeps version', () => {
  const store = new OvenStore(['7']);
  store.begin();
  assert.throws(() => store.commit(), (err) => err.code === E_STATE);
  assert.deepEqual(store.activeCoefficients(), ['7']);
});

test('persistence round-trip preserves history and index', () => {
  const store = new OvenStore(['1']);
  store.begin();
  store.stage(['2']);
  store.commit();
  store.undo();
  const restored = OvenStore.fromJSON(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(restored.activeCoefficients(), ['1']);
  restored.redo();
  assert.deepEqual(restored.activeCoefficients(), ['2']);
});
