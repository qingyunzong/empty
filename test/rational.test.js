import test from 'node:test';
import assert from 'node:assert/strict';
import { Frac, roundHalfEvenCents } from '../src/rational.js';

test('parse and normalize', () => {
  assert.equal(Frac.parse('2/4').toString(), '1/2');
  assert.equal(Frac.parse('-6/3').toString(), '-2');
  assert.equal(Frac.parse('1.25').toString(), '5/4');
  assert.equal(Frac.parse('0.005').toString(), '1/200');
  assert.equal(Frac.parse(7).toString(), '7');
  assert.throws(() => Frac.parse('abc'));
  assert.throws(() => Frac.parse('1/0'));
  assert.throws(() => Frac.parse(1.5)); // floats rejected, use exact strings
});

test('arithmetic', () => {
  const a = Frac.parse('1/3'), b = Frac.parse('1/6');
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.cmp(b), 1);
  assert.equal(b.cmp(a), -1);
  assert.equal(a.sub(a).sign(), 0);
});

test('ROUND_HALF_EVEN to cents', () => {
  const r = (s) => roundHalfEvenCents(Frac.parse(s)).toString();
  assert.equal(r('1/200'), '0');      // 0.005 -> tie -> even 0.00
  assert.equal(r('3/200'), '1/50');   // 0.015 -> tie -> even 0.02
  assert.equal(r('1/8'), '3/25');     // 0.125 -> 12.5 -> even 12 -> 0.12
  assert.equal(r('27/200'), '7/50');  // 0.135 -> 13.5 -> even 14 -> 0.14
  assert.equal(r('-3/200'), '-1/50'); // -0.015 -> -0.02
  assert.equal(r('1/160'), '1/100');  // 0.00625 -> 0.01
  assert.equal(r('1/4'), '1/4');      // exact cents unchanged
});
