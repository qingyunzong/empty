import test from 'node:test';
import assert from 'node:assert/strict';
import { Rat } from '../src/rational.js';
import {
  integral,
  monomialSumIntegral,
  isNonNegativeOn,
  isolateRoots,
  trim,
} from '../src/polynomial.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const toRats = (arr) => arr.map((c) => Rat.of(c));

test('acceptance 1: degree <= 4 integral matches direct monomial sum', () => {
  const rand = lcg(42);
  const rc = () => Rat.of(`${Math.floor(rand() * 11) - 5}/${1 + Math.floor(rand() * 6)}`);
  for (let iter = 0; iter < 300; iter += 1) {
    const deg = Math.floor(rand() * 5); // 0..4
    const p = trim(Array.from({ length: deg + 1 }, rc));
    const a = rc();
    const b = a.add(Rat.of(`1/${1 + Math.floor(rand() * 4)}`));
    const viaAntiderivative = integral(p, a, b);
    const viaMonomialSum = monomialSumIntegral(p, a, b);
    assert.ok(
      viaAntiderivative.eq(viaMonomialSum),
      `mismatch for degree ${deg}: ${viaAntiderivative} vs ${viaMonomialSum}`,
    );
  }
});

test('degree 5 integral also matches monomial sum', () => {
  const rand = lcg(7);
  const rc = () => Rat.of(`${Math.floor(rand() * 7) - 3}/${1 + Math.floor(rand() * 5)}`);
  for (let iter = 0; iter < 100; iter += 1) {
    const p = trim(Array.from({ length: 6 }, rc));
    const a = rc();
    const b = a.add(Rat.of('1/3'));
    assert.ok(integral(p, a, b).eq(monomialSumIntegral(p, a, b)));
  }
});

test('isNonNegativeOn exact decisions', () => {
  const cases = [
    [['1'], '0', '1', true], // constant positive
    [['-1'], '0', '1', false], // constant negative
    [['0'], '0', '1', true], // zero polynomial
    [['-1', '1'], '0', '2', false], // t - 1: negative on [0, 1)
    [['2', '-1'], '0', '1', true], // 2 - t stays positive
    [['2', '-1'], '0', '3', false], // 2 - t: negative at endpoint t=3
    [['3', '-4', '1'], '0', '4', false], // (t-1)(t-3): interior dip, endpoints positive
    [['1/4', '-1', '1'], '0', '1', true], // (t - 1/2)^2 touches zero
    [['0', '-2', '1'], '0', '2', false], // t(t-2): endpoint roots, negative inside
    [['2', '-3', '1'], '0', '3', false], // (t-1)(t-2): negative on (1, 2)
    [['0', '0', '0', '1'], '0', '1', true], // t^3 >= 0 on [0, 1]
    [['0', '0', '0', '1'], '-1', '1', false], // t^3 negative for t < 0
    [['0', '0', '1'], '-2', '-1', true], // t^2 positive on negative interval
    [['1', '0', '0', '0', '0', '1'], '0', '1', true], // t^5 + 1 on [0, 1]
    [['-1/8', '1', '-2', '1'], '0', '3', false], // (t-1/2)(t-1)(t-2)... dips below
  ];
  for (const [coeffs, a, b, expected] of cases) {
    const p = toRats(coeffs);
    assert.equal(
      isNonNegativeOn(p, Rat.of(a), Rat.of(b)),
      expected,
      `coeffs=${JSON.stringify(coeffs)} on [${a}, ${b}]`,
    );
  }
});

test('isolateRoots finds distinct roots with separation', () => {
  const p = toRats(['3', '-4', '1']); // (t-1)(t-3)
  const intervals = isolateRoots(p, Rat.of('0'), Rat.of('4'));
  assert.equal(intervals.length, 2);
  const one = Rat.of('1');
  const three = Rat.of('3');
  assert.ok(intervals[0][0].cmp(one) < 0 && intervals[0][1].cmp(one) >= 0);
  assert.ok(intervals[1][0].cmp(three) < 0 && intervals[1][1].cmp(three) >= 0);
  assert.ok(intervals[0][1].cmp(intervals[1][0]) < 0); // strictly separated
});
