'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rational } = require('../src/rational');
const { Poly } = require('../src/poly');

// Independent cross-check: integrate by direct monomial summation
// sum_i c_i * (b^(i+1) - a^(i+1)) / (i+1), computed without Poly.integrate.
function monomialSumIntegral(coeffs, a, b) {
  const ra = Rational.from(a);
  const rb = Rational.from(b);
  let acc = Rational.zero();
  for (let i = 0; i < coeffs.length; i++) {
    const term = Rational.from(coeffs[i])
      .mul(rb.pow(i + 1).sub(ra.pow(i + 1)))
      .div(Rational.from(BigInt(i + 1)));
    acc = acc.add(term);
  }
  return acc;
}

test('antiderivative matches independent monomial summation (degree <= 4)', () => {
  const cases = [
    { coeffs: ['1', '1/2', '1/3', '1/4', '1/5'], a: '1/3', b: '2' },
    { coeffs: ['3', '-2', '0', '7/8'], a: '-1', b: '3/2' },
    { coeffs: ['5'], a: '0', b: '10' },
    { coeffs: ['0', '0', '0', '0', '9'], a: '-2', b: '-1/7' },
    { coeffs: ['1/2', '-3/4', '5/6', '-7/8', '9/10'], a: '0', b: '1' },
  ];
  for (const { coeffs, a, b } of cases) {
    const poly = new Poly(coeffs);
    assert.ok(poly.degree() <= 4);
    const viaAntiderivative = poly.integrate(a, b);
    const viaMonomials = monomialSumIntegral(coeffs, a, b);
    assert.equal(
      viaAntiderivative.toString(),
      viaMonomials.toString(),
      `mismatch for ${JSON.stringify(coeffs)} on [${a}, ${b}]`,
    );
  }
});

test('square-free factorization recovers multiplicities', () => {
  // (t-1)^2 (t-2)^3 expanded: roots 1 (mult 2), 2 (mult 3)
  const p = new Poly(['1', '-1']).mul(new Poly(['1', '-1']))
    .mul(new Poly(['-2', '1'])).mul(new Poly(['-2', '1'])).mul(new Poly(['-2', '1']));
  const factors = p.squareFreeFactors();
  const byMult = new Map(factors.map((f) => [f.multiplicity, f.poly.toString ? f.poly.coeffs.map(String) : null]));
  assert.equal(factors.length, 2);
  const m2 = factors.find((f) => f.multiplicity === 2).poly;
  const m3 = factors.find((f) => f.multiplicity === 3).poly;
  assert.deepEqual(m2.coeffs.map(String), ['-1', '1']);
  assert.deepEqual(m3.coeffs.map(String), ['-2', '1']);
  assert.ok(byMult instanceof Map);
});

test('oddPart keeps only odd-multiplicity roots', () => {
  // (t-1)^2 (t-3) -> oddPart proportional to (t-3)
  const p = new Poly(['1', '-1']).mul(new Poly(['1', '-1'])).mul(new Poly(['-3', '1']));
  const odd = p.oddPart();
  assert.equal(odd.degree(), 1);
  assert.ok(odd.eval('3').isZero());
});

test('sturm root counting on open intervals', () => {
  // roots at 1, 2, 3
  const p = new Poly(['-6', '11', '-6', '1']);
  assert.equal(p.countRootsOpen(Rational.from(0), Rational.from(4)), 3);
  assert.equal(p.countRootsOpen(Rational.from(1), Rational.from(3)), 1);
  assert.equal(p.countRootsOpen(Rational.from(2), Rational.from(2)), 0);
  assert.equal(p.countRootsOpen(Rational.from('3/2'), Rational.from('5/2')), 1);
});

test('negative velocity detection on closed windows', () => {
  const cases = [
    { coeffs: ['-1/2', '1'], expect: true, note: 'dips below zero at t=0' },
    { coeffs: ['1/4', '-1', '1'], expect: false, note: '(t-1/2)^2 touches zero' },
    { coeffs: ['0', '-1', '1'], expect: true, note: 't(t-1) negative inside' },
    { coeffs: ['0', '0', '1'], expect: false, note: 't^2 >= 0' },
    { coeffs: ['1', '-1'], expect: false, note: '1-t >= 0 on [0,1]' },
    { coeffs: ['-1', '1'], expect: true, note: 't-1 < 0 inside' },
    { coeffs: ['3/16', '-1', '1'], expect: true, note: 'two odd roots inside' },
    { coeffs: ['5'], expect: false, note: 'positive constant' },
    { coeffs: ['-5'], expect: true, note: 'negative constant' },
    { coeffs: ['0'], expect: false, note: 'zero velocity allowed' },
    { coeffs: ['1', '0', '0', '0', '0', '-1'], expect: false, note: '1 - t^5 >= 0 on [0,1]' },
  ];
  for (const { coeffs, expect, note } of cases) {
    const poly = new Poly(coeffs);
    assert.equal(
      poly.hasNegativeOn(Rational.from(0), Rational.from(1)),
      expect,
      `${note}: ${JSON.stringify(coeffs)}`,
    );
  }
});

test('negative velocity detection: 1 - t^5 on [0,2] is negative past 1', () => {
  const poly = new Poly(['1', '0', '0', '0', '0', '-1']);
  assert.equal(poly.hasNegativeOn(Rational.from(0), Rational.from(2)), true);
  assert.equal(poly.hasNegativeOn(Rational.from(0), Rational.from(1)), false);
});
