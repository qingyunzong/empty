import test from 'node:test';
import assert from 'node:assert/strict';
import { Rat } from '../src/rational';

test('normalizes sign and gcd', () => {
  assert.equal(Rat.of(2, 4).toString(), '1/2');
  assert.equal(Rat.of(-2, 4).toString(), '-1/2');
  assert.equal(Rat.of(2, -4).toString(), '-1/2');
  assert.equal(Rat.of(0, 7).toString(), '0');
  assert.equal(Rat.of(6, 3).toString(), '2');
});

test('arithmetic is exact', () => {
  const a = Rat.of(1, 3);
  const b = Rat.of(1, 6);
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
  // 0.1 + 0.2 style error cannot occur
  const s = Rat.of(1, 10).add(Rat.of(2, 10));
  assert.equal(s.toString(), '3/10');
});

test('floor/ceil round toward infinities', () => {
  assert.equal(Rat.of(7, 2).floor(), 3n);
  assert.equal(Rat.of(-7, 2).floor(), -4n);
  assert.equal(Rat.of(7, 2).ceil(), 4n);
  assert.equal(Rat.of(-7, 2).ceil(), -3n);
  assert.equal(Rat.of(4, 2).floor(), 2n);
  assert.equal(Rat.of(4, 2).ceil(), 2n);
});

test('divFloor matches floor of quotient', () => {
  assert.equal(Rat.of(7, 2).divFloor(Rat.of(2)), 1n);
  assert.equal(Rat.of(4).divFloor(Rat.of(2)), 2n);
  assert.equal(Rat.of(1).divFloor(Rat.of(3)), 0n);
});

test('comparison', () => {
  assert.ok(Rat.of(1, 3).lt(Rat.of(1, 2)));
  assert.ok(Rat.of(2, 4).eq(Rat.of(1, 2)));
  assert.ok(Rat.of(5).gt(Rat.of(-5)));
  assert.throws(() => Rat.of(1, 0));
});
