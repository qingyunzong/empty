import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Polynomial } from '../src/polynomial.js';
import { Rat } from '../src/rational.js';
import { E_CONFIG } from '../src/errors.js';

test('exact evaluation at rational points', () => {
  // P(x) = 1/4 - 2x^2 + x^4
  const p = new Polynomial(['1/4', '0', '-2', '0', '1']);
  assert.equal(p.evaluate(Rat.parse('0')).toString(), '1/4');
  assert.equal(p.evaluate(Rat.parse('1')).toString(), '-3/4');
  assert.equal(p.evaluate(Rat.parse('2')).toString(), '33/4');
  assert.equal(p.evaluate(Rat.parse('1/2')).toString(), '-3/16'); // 1/4 - 1/2 + 1/16
});

test('rational roots of derivative are all found (incl. factored-out zero)', () => {
  // d/dx (1/4 - 2x^2 + x^4) = -4x + 4x^3 = 4x(x-1)(x+1)
  const d = new Polynomial(['0', '-4', '0', '4']);
  assert.deepEqual(d.rationalRoots().map(String), ['-1', '0', '1']);
});

test('extrema come from endpoints and all rational stationary points', () => {
  const p = new Polynomial(['1/4', '0', '-2', '0', '1']);
  const { min, max, argMin, samplePoints } = p.extremaOnInterval('0', '2');
  assert.equal(min.toString(), '-3/4'); // at stationary point x = 1
  assert.equal(max.toString(), '33/4'); // at endpoint x = 2
  assert.equal(argMin.toString(), '1');
  assert.deepEqual(samplePoints.map(String), ['0', '2', '1']);
});

test('degree above 4 returns E_CONFIG', () => {
  assert.throws(() => new Polynomial(['0', '0', '0', '0', '0', '1']), (err) => err.code === E_CONFIG);
});

test('inverted interval returns E_CONFIG', () => {
  const p = new Polynomial(['1']);
  assert.throws(() => p.extremaOnInterval('2', '1'), (err) => err.code === E_CONFIG);
});
