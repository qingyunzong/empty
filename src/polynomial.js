'use strict';

const { Rational, lcmBig, absBig } = require('./rational');
const { E_DEGREE } = require('./errors');

const MAX_DEGREE = 4;

// Polynomial with rational coefficients: coeffs[i] is the coefficient of x^i.
class Polynomial {
  constructor(coeffs) {
    if (!Array.isArray(coeffs) || coeffs.length === 0) {
      throw E_DEGREE('coefficient list must be a non-empty array');
    }
    const rs = coeffs.map((c) => Rational.from(c));
    while (rs.length > 1 && rs[rs.length - 1].sign() === 0) rs.pop();
    if (rs.length - 1 > MAX_DEGREE) {
      throw E_DEGREE(`degree ${rs.length - 1} exceeds maximum ${MAX_DEGREE}`);
    }
    this.coeffs = Object.freeze(rs);
    Object.freeze(this);
  }

  degree() {
    return this.coeffs.length - 1;
  }

  // Exact evaluation at a rational point via Horner's rule.
  evaluate(x) {
    x = Rational.from(x);
    let acc = Rational.zero();
    for (let i = this.coeffs.length - 1; i >= 0; i -= 1) {
      acc = acc.mul(x).add(this.coeffs[i]);
    }
    return acc;
  }

  derivative() {
    if (this.degree() === 0) return new Polynomial([Rational.zero()]);
    const d = [];
    for (let i = 1; i < this.coeffs.length; i += 1) {
      d.push(this.coeffs[i].mul(new Rational(BigInt(i))));
    }
    return new Polynomial(d);
  }

  // Exact min/max over [lo, hi]: candidates are the endpoints plus every
  // rational stationary point inside the interval. No floating point anywhere.
  rangeOnInterval(lo, hi) {
    lo = Rational.from(lo);
    hi = Rational.from(hi);
    if (lo.cmp(hi) > 0) {
      throw E_DEGREE('interval lower bound exceeds upper bound');
    }
    const candidates = [lo, hi];
    for (const root of this.derivative().rationalRoots()) {
      if (root.cmp(lo) > 0 && root.cmp(hi) < 0) candidates.push(root);
    }
    let min = null;
    let max = null;
    for (const c of candidates) {
      const v = this.evaluate(c);
      if (min === null || v.cmp(min) < 0) min = v;
      if (max === null || v.cmp(max) > 0) max = v;
    }
    return { min, max };
  }

  // All rational roots via the rational root theorem (exact, BigInt only).
  rationalRoots() {
    const intCoeffs = this.#toIntegerCoefficients();
    const n = intCoeffs.length - 1;
    if (n === 0) return [];

    // Strip zero constant terms: x=0 is a root for each.
    const roots = [];
    let coeffs = intCoeffs;
    while (coeffs[0] === 0n) {
      roots.push(Rational.zero());
      coeffs = coeffs.slice(1);
    }
    if (coeffs.length === 1) return dedupe(roots);

    const a0 = coeffs[0];
    const an = coeffs[coeffs.length - 1];
    for (const p of divisors(absBig(a0))) {
      for (const q of divisors(absBig(an))) {
        for (const sign of [1n, -1n]) {
          const num = sign * p;
          if (evalInteger(coeffs, num, q) === 0n) {
            roots.push(new Rational(num, q));
          }
        }
      }
    }
    return dedupe(roots);
  }

  // Scale by the LCM of denominators to get integer coefficients.
  #toIntegerCoefficients() {
    let lcm = 1n;
    for (const c of this.coeffs) lcm = lcmBig(lcm, c.den);
    return this.coeffs.map((c) => c.num * (lcm / c.den));
  }
}

// Exact integer evaluation of sum a_i * (num/den)^i, cleared by den^n.
function evalInteger(coeffs, num, den) {
  const n = coeffs.length - 1;
  let acc = 0n;
  for (let i = n; i >= 0; i -= 1) {
    acc = acc * num + coeffs[i] * den ** BigInt(n - i);
  }
  return acc;
}

function divisors(a) {
  const out = [];
  for (let i = 1n; i * i <= a; i += 1n) {
    if (a % i === 0n) {
      out.push(i);
      if (i * i !== a) out.push(a / i);
    }
  }
  return out;
}

function dedupe(rationals) {
  const seen = new Set();
  const out = [];
  for (const r of rationals) {
    const key = r.toString();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

module.exports = { Polynomial, MAX_DEGREE };
