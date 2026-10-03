import { Rational } from './rational.js';
import { Interval } from './interval.js';
import { qerror } from './errors.js';

// Rational polynomial of degree at most 2: c0 + c1*t + c2*t^2.
export class Polynomial {
  constructor(coeffs) {
    if (!Array.isArray(coeffs) || coeffs.length < 1 || coeffs.length > 3) {
      throw qerror(
        'E_CORRECTION',
        'correction polynomial must have 1 to 3 rational coefficients (degree <= 2)'
      );
    }
    const cs = coeffs.map((c) => Rational.from(c));
    while (cs.length > 1 && cs[cs.length - 1].isZero()) cs.pop();
    this.coeffs = Object.freeze(cs);
    Object.freeze(this);
  }

  get degree() {
    return this.coeffs.length - 1;
  }

  evaluate(t) {
    t = Rational.from(t);
    let acc = this.coeffs[this.coeffs.length - 1];
    for (let i = this.coeffs.length - 2; i >= 0; i--) {
      acc = acc.mul(t).add(this.coeffs[i]);
    }
    return acc;
  }

  // Exact image of an interval under this polynomial.
  // For a quadratic, the stationary point -c1/(2*c2) is always rational;
  // it is included only when it lies inside the interval.
  mapInterval(iv) {
    const candidates = [this.evaluate(iv.lo), this.evaluate(iv.hi)];
    if (this.degree === 2) {
      const two = new Rational(2n);
      const vertex = this.coeffs[1].neg().div(this.coeffs[2].mul(two));
      if (iv.contains(vertex)) {
        candidates.push(this.evaluate(vertex));
      }
    }
    let lo = candidates[0];
    let hi = candidates[0];
    for (const v of candidates) {
      if (v.lt(lo)) lo = v;
      if (v.gt(hi)) hi = v;
    }
    return new Interval(lo, hi);
  }

  toJSON() {
    return this.coeffs.map((c) => c.toString());
  }
}
