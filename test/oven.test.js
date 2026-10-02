'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Rational } = require('../src/rational');
const { Polynomial } = require('../src/polynomial');
const { quantizeValue } = require('../src/quantize');
const { OvenController } = require('../src/controller');
const { run } = require('../src/cli');

const r = (s) => Rational.parse(s);

// Independent cross-check: enumerate endpoints and all rational stationary
// points, evaluate, and take exact min/max.
function bruteForceRange(poly, lo, hi) {
  const candidates = [r(lo), r(hi)];
  for (const root of poly.derivative().rationalRoots()) {
    if (root.cmp(r(lo)) > 0 && root.cmp(r(hi)) < 0) candidates.push(root);
  }
  const values = candidates.map((c) => poly.evaluate(c));
  return {
    min: values.reduce((a, b) => (b.cmp(a) < 0 ? b : a)),
    max: values.reduce((a, b) => (b.cmp(a) > 0 ? b : a)),
  };
}

test('acceptance 1: quartic on small interval quantizes; matches endpoint/stationary enumeration', () => {
  // P(x) = x^4 - 2x^3 + x^2 = (x^2 - x)^2; P' = 2x(2x-1)(x-1).
  const controller = new OvenController(['0', '0', '1', '-2', '1']);
  const result = controller.instruction('1/4', '3/4', 0);

  // Interior rational stationary point x=1/2 attains the max 1/16;
  // endpoints attain the min 9/256.
  assert.equal(result.interval.min.toString(), '9/256');
  assert.equal(result.interval.max.toString(), '1/16');
  assert.equal(result.value.toString(), '0');
  assert.equal(result.errorBound.toString(), '1/16');

  const poly = new Polynomial(['0', '0', '1', '-2', '1']);
  const check = bruteForceRange(poly, '1/4', '3/4');
  assert.ok(check.min.equals(result.interval.min));
  assert.ok(check.max.equals(result.interval.max));

  // The stationary point x=1/2 must be among the derivative's rational roots.
  const roots = poly.derivative().rationalRoots().map(String);
  assert.ok(roots.includes('1/2'));
});

test('acceptance 2: interval spanning exactly two quantization ticks is E_AMBIGUOUS', () => {
  const controller = new OvenController(['0', '1']); // P(x) = x
  assert.throws(
    () => controller.instruction('1/100', '2/100', 2),
    (err) => err.code === 'E_AMBIGUOUS'
  );
});

test('acceptance 3: half-value boundary rounds up', () => {
  // 0.005 at k=2 rounds up to 0.01.
  assert.equal(quantizeValue(r('1/200'), 2).toString(), '1/100');
  // -0.005 rounds up (toward +infinity) to 0.
  assert.equal(quantizeValue(r('-1/200'), 2).toString(), '0');
  // 1/2 at k=0 rounds up to 1.
  assert.equal(quantizeValue(r('1/2'), 0).toString(), '1');

  // End-to-end: constant polynomial pinned at the half tick.
  const controller = new OvenController(['1/200']);
  const result = controller.instruction('0', '0', 2);
  assert.equal(result.value.toString(), '1/100');
  assert.equal(result.errorBound.toString(), '1/200');
});

test('acceptance 4: undo restores the original instruction', () => {
  const controller = new OvenController(['1/2']);
  const original = controller.instruction('0', '0', 0);
  assert.equal(original.value.toString(), '1');

  const tx = controller.beginTransaction();
  tx.setCoefficient(0, '1/4');
  tx.commit();
  assert.equal(controller.instruction('0', '0', 0).value.toString(), '0');

  controller.undo();
  const restored = controller.instruction('0', '0', 0);
  assert.equal(restored.value.toString(), original.value.toString());
  assert.equal(restored.errorBound.toString(), original.errorBound.toString());
  assert.ok(restored.interval.min.equals(original.interval.min));

  controller.redo();
  assert.equal(controller.instruction('0', '0', 0).value.toString(), '0');
});

test('acceptance 5: k<0 gives E_CONFIG; zero denominator gives E_RATIONAL', () => {
  const controller = new OvenController(['1']);
  assert.throws(() => controller.instruction('0', '1', -1), (err) => err.code === 'E_CONFIG');
  assert.throws(() => new Rational(1n, 0n), (err) => err.code === 'E_RATIONAL');
  assert.throws(() => Rational.parse('1/0'), (err) => err.code === 'E_RATIONAL');
  assert.throws(() => r('1/2').div(r('0')), (err) => err.code === 'E_RATIONAL');
});

test('invalid transaction does not change the active version', () => {
  const controller = new OvenController(['1', '2']);
  const before = controller.activeCoefficients().map(String);

  // Degree 5 exceeds the maximum of 4: commit must fail atomically.
  const tx = controller.beginTransaction();
  tx.setCoefficients(['1', '0', '0', '0', '0', '1']);
  assert.throws(() => tx.commit(), (err) => err.code === 'E_DEGREE');
  assert.deepEqual(controller.activeCoefficients().map(String), before);

  // A rolled-back transaction cannot commit, and changes are discarded.
  const tx2 = controller.beginTransaction();
  tx2.setCoefficient(0, '99');
  tx2.rollback();
  assert.throws(() => tx2.commit(), (err) => err.code === 'E_TRANSACTION');
  assert.deepEqual(controller.activeCoefficients().map(String), before);

  // Undo/redo with empty history raises E_TRANSACTION.
  assert.throws(() => controller.undo(), (err) => err.code === 'E_TRANSACTION');
  assert.throws(() => controller.redo(), (err) => err.code === 'E_TRANSACTION');
});

test('rational roots of a cubic derivative are all found exactly', () => {
  // P' = 6x^2 - 5x + 1 has roots 1/2 and 1/3.
  const poly = new Polynomial(['0', '1', '-5/2', '2']);
  const roots = poly.derivative().rationalRoots().map(String).sort();
  assert.deepEqual(roots, ['1/2', '1/3']);
});

test('CLI: quantize prints exact JSON; ambiguous interval exits 1 with E_AMBIGUOUS', () => {
  const okRes = run(['quantize', '--coeffs', '0,0,1,-2,1', '--lo', '1/4', '--hi', '3/4', '--k', '0']);
  assert.equal(okRes.code, 0);
  const ok = JSON.parse(okRes.stdout);
  assert.deepEqual(ok, {
    interval: { min: '9/256', max: '1/16' },
    value: '0',
    errorBound: '1/16',
  });

  const bad = run(['quantize', '--coeffs', '0,1', '--lo', '1/100', '--hi', '2/100', '--k', '2']);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stderr).error, 'E_AMBIGUOUS');
});
