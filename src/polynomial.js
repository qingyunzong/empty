import { Rat, rat } from './rational.js';
import { E, QError } from './errors.js';

/**
 * Correction polynomials are univariate with rational coefficients, degree <= 2,
 * given in ascending order [c0, c1, c2]:  f(t) = c0 + c1*t + c2*t^2.
 * Shorter arrays are zero-padded; the quadratic coefficient may be zero.
 */
export function parsePolynomial(spec, label = 'polynomial') {
  if (!Array.isArray(spec) || spec.length < 1 || spec.length > 3) {
    throw new QError(E.VALIDATION, `${label} must be an array of 1..3 rational coefficients [c0, c1, c2]`);
  }
  const coeffs = spec.map((c) => rat(c));
  while (coeffs.length < 3) coeffs.push(new Rat(0n));
  return coeffs;
}

export function evalPolynomial(coeffs, t) {
  return coeffs[2].mul(t).add(coeffs[1]).mul(t).add(coeffs[0]);
}

/**
 * Exact image of [lo, hi] under f. Candidates are the endpoints plus the
 * quadratic stationary point t* = -c1 / (2*c2), which is always rational for
 * rational coefficients; it is included only when it lies inside [lo, hi].
 */
export function mapInterval(coeffs, lo, hi) {
  const candidates = [evalPolynomial(coeffs, lo), evalPolynomial(coeffs, hi)];
  let stationary = null;
  if (!coeffs[2].isZero()) {
    const t = coeffs[1].neg().div(coeffs[2].mul(new Rat(2n)));
    if (t.cmp(lo) >= 0 && t.cmp(hi) <= 0) {
      const value = evalPolynomial(coeffs, t);
      stationary = { t, value };
      candidates.push(value);
    }
  }
  let min = candidates[0];
  let max = candidates[0];
  for (const v of candidates) {
    if (v.cmp(min) < 0) min = v;
    if (v.cmp(max) > 0) max = v;
  }
  return { min, max, stationary };
}
