import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInstruction, quantizeValue } from '../src/quantize.js';
import { Polynomial } from '../src/polynomial.js';
import { Rat } from '../src/rational.js';
import { E_AMBIGUOUS, E_CONFIG, E_RATIONAL } from '../src/errors.js';

// Acceptance 1: quartic polynomial on a small interval quantizes
// successfully, cross-checked by independent endpoint + stationary-point
// enumeration.
test('quartic on small interval quantizes; verified by endpoint/stationary enumeration', () => {
  // P(x) = 1/4 - 2x^2 + x^4, interval [9/10, 11/10] around stationary x=1.
  const coeffs = ['1/4', '0', '-2', '0', '1'];
  const lo = '9/10';
  const hi = '11/10';
  const k = 1;

  const result = computeInstruction(coeffs, lo, hi, k);

  // Independent check: enumerate endpoints and every rational stationary
  // point of the derivative inside the interval, evaluate exactly.
  const poly = new Polynomial(coeffs);
  const loRat = Rat.parse(lo);
  const hiRat = Rat.parse(hi);
  const points = [loRat, hiRat];
  for (const root of poly.derivative().rationalRoots()) {
    if (root.cmp(loRat) > 0 && root.cmp(hiRat) < 0) points.push(root);
  }
  assert.deepEqual(points.map(String), ['9/10', '11/10', '1']);
  const values = points.map((x) => poly.evaluate(x));
  const min = values.reduce((a, b) => (a.cmp(b) <= 0 ? a : b));
  const max = values.reduce((a, b) => (a.cmp(b) >= 0 ? a : b));
  assert.equal(min.toString(), '-3/4');
  assert.equal(max.toString(), '-7059/10000');

  // Library result must match the independent enumeration exactly.
  assert.equal(result.interval.min.toString(), min.toString());
  assert.equal(result.interval.max.toString(), max.toString());

  // Whole interval rounds to the single tick -7/10 at k=1.
  assert.equal(result.quantized.toString(), '-7/10');
  assert.equal(result.k, 1);
  assert.equal(result.quantum.toString(), '1/10');

  // Strict error bound: max distance from any interval value to the output.
  // max(|-7/10 - (-3/4)|, |-7059/10000 - (-7/10)|) = max(1/20, 59/10000).
  assert.equal(result.errorBound.toString(), '1/20');
  assert.ok(result.errorBound.cmp(Rat.parse('1/10')) < 0, 'error bound below one quantum');
});

// Acceptance 2: interval exactly spanning two quantization ticks is
// rejected with E_AMBIGUOUS.
test('interval spanning two quantization ticks returns E_AMBIGUOUS', () => {
  // P(x) = x on [0, 1/10] with k=1: endpoints round to 0/10 and 1/10.
  assert.throws(
    () => computeInstruction(['0', '1'], '0', '1/10', 1),
    (err) => err.code === E_AMBIGUOUS
  );
  // P(x) = x on [1/4, 3/4] with k=0: rounds to 0 and 1.
  assert.throws(
    () => computeInstruction(['0', '1'], '1/4', '3/4', 0),
    (err) => err.code === E_AMBIGUOUS
  );
});

// Acceptance 3: half-value boundary rounds up (toward +Infinity).
test('half-value boundary rounds up', () => {
  // Constant P(x) = 5/2, k=0 -> 3.
  const up = computeInstruction(['5/2'], '0', '1', 0);
  assert.equal(up.quantized.toString(), '3');
  assert.equal(up.errorBound.toString(), '1/2');

  // Constant P(x) = -5/2, k=0 -> -2 (up means toward +Infinity).
  const neg = computeInstruction(['-5/2'], '0', '1', 0);
  assert.equal(neg.quantized.toString(), '-2');

  // Interval whose maximum lands exactly on the half tick still resolves.
  // P(x) = x on [5/2, 5/2], k=0 -> 3.
  const point = computeInstruction(['0', '1'], '5/2', '5/2', 0);
  assert.equal(point.quantized.toString(), '3');

  // quantizeValue: 25/10 at k=1 is exactly 5/2 -> 3? No: 2.5 -> 3.
  assert.equal(quantizeValue(Rat.parse('5/2'), 0).toString(), '3');
  assert.equal(quantizeValue(Rat.parse('1/20'), 1).toString(), '1/10'); // 0.05 -> 0.1
  assert.equal(quantizeValue(Rat.parse('-1/20'), 1).toString(), '0'); // -0.05 -> 0
});

test('k < 0 returns E_CONFIG', () => {
  assert.throws(() => computeInstruction(['1'], '0', '1', -1), (err) => err.code === E_CONFIG);
  assert.throws(() => computeInstruction(['1'], '0', '1', -3), (err) => err.code === E_CONFIG);
});

test('zero denominator returns E_RATIONAL', () => {
  assert.throws(() => computeInstruction(['1/0'], '0', '1', 1), (err) => err.code === E_RATIONAL);
  assert.throws(() => computeInstruction(['1'], '1/0', '1', 1), (err) => err.code === E_RATIONAL);
});
