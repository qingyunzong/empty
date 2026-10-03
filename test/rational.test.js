import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rat, roundHalfUp } from '../src/rational.js';
import { E_RATIONAL } from '../src/errors.js';

test('parses integers and fractions, normalizes sign and gcd', () => {
  assert.equal(Rat.parse('3').toString(), '3');
  assert.equal(Rat.parse('-2').toString(), '-2');
  assert.equal(Rat.parse('3/4').toString(), '3/4');
  assert.equal(Rat.parse('6/8').toString(), '3/4');
  assert.equal(Rat.parse('2/-4').toString(), '-1/2');
  assert.equal(Rat.parse('-2/-4').toString(), '1/2');
  assert.equal(Rat.parse(' 5/10 ').toString(), '1/2');
});

test('zero denominator returns E_RATIONAL', () => {
  assert.throws(() => Rat.parse('1/0'), (err) => err.code === E_RATIONAL);
  assert.throws(() => Rat.parse('0/0'), (err) => err.code === E_RATIONAL);
  assert.throws(() => new Rat(1n, 0n), (err) => err.code === E_RATIONAL);
});

test('malformed rationals return E_RATIONAL', () => {
  for (const bad of ['', 'a', '1/2/3', '1.5', '1e3', '/', '1/']) {
    assert.throws(() => Rat.parse(bad), (err) => err.code === E_RATIONAL, bad);
  }
});

test('exact arithmetic without floating point', () => {
  const a = Rat.parse('1/3');
  const b = Rat.parse('1/6');
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
  assert.equal(Rat.parse('-2/3').abs().toString(), '2/3');
});

test('roundHalfUp rounds ties toward +Infinity exactly', () => {
  assert.equal(roundHalfUp(Rat.parse('5/2')), 3n);
  assert.equal(roundHalfUp(Rat.parse('-5/2')), -2n);
  assert.equal(roundHalfUp(Rat.parse('7/2')), 4n);
  assert.equal(roundHalfUp(Rat.parse('12/5')), 2n); // 2.4 -> 2
  assert.equal(roundHalfUp(Rat.parse('13/5')), 3n); // 2.6 -> 3
  assert.equal(roundHalfUp(Rat.parse('-12/5')), -2n); // -2.4 -> -2
  assert.equal(roundHalfUp(Rat.parse('0')), 0n);
});
