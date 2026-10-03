import { Rat } from './rational.js';
import { configError } from './errors.js';

export const MAX_DEGREE = 4;

const absBig = (v) => (v < 0n ? -v : v);

function lcmBig(a, b) {
  if (a === 0n || b === 0n) return 0n;
  let x = absBig(a);
  let y = absBig(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return absBig(a) / x * absBig(b);
}

// Trim leading zero coefficients; returns [] for the zero polynomial.
function trim(coeffs) {
  let end = coeffs.length;
  while (end > 0 && coeffs[end - 1].num === 0n) end -= 1;
  return coeffs.slice(0, end);
}

function divisors(n) {
  const out = [];
  const a = absBig(n);
  for (let i = 1n; i * i <= a; i += 1n) {
    if (a % i === 0n) {
      out.push(i);
      if (i * i !== a) out.push(a / i);
    }
  }
  return out;
}

// Polynomial with exact rational coefficients, degree <= 4.
// coeffs[i] is the coefficient of x^i.
export class Polynomial {
  constructor(coeffs) {
    if (!Array.isArray(coeffs) || coeffs.length === 0) {
      throw configError('E_CONFIG: coefficient list must be a non-empty array');
    }
    const parsed = coeffs.map((c) => Rat.parse(c));
    const trimmed = trim(parsed);
    const effective = trimmed.length === 0 ? [Rat.zero()] : trimmed;
    if (effective.length - 1 > MAX_DEGREE) {
      throw configError(`E_CONFIG: degree ${effective.length - 1} exceeds maximum ${MAX_DEGREE}`);
    }
    this.coeffs = effective;
    Object.freeze(this.coeffs);
    Object.freeze(this);
  }

  degree() {
    return this.coeffs.length - 1;
  }

  // Exact evaluation at a rational point (Horner, exact rational arithmetic).
  evaluate(x) {
    let acc = Rat.zero();
    for (let i = this.coeffs.length - 1; i >= 0; i -= 1) {
      acc = acc.mul(x).add(this.coeffs[i]);
    }
    return acc;
  }

  derivative() {
    if (this.degree() === 0) {
      return new Polynomial([Rat.zero()]);
    }
    const d = [];
    for (let i = 1; i < this.coeffs.length; i += 1) {
      d.push(this.coeffs[i].mul(Rat.fromBigInt(BigInt(i))));
    }
    return new Polynomial(d);
  }

  // All rational roots of this polynomial, via the rational root theorem.
  // Exact BigInt arithmetic only; irrational roots are not representable and
  // are intentionally never approximated (no floating point anywhere).
  rationalRoots() {
    const coeffs = trim(this.coeffs);
    if (coeffs.length === 0) return []; // zero polynomial: no isolated roots
    // Scale to integer coefficients (roots are unchanged).
    let scale = 1n;
    for (const c of coeffs) scale = lcmBig(scale, c.den);
    let intCoeffs = coeffs.map((c) => c.num * (scale / c.den));

    const candidates = [];
    const seen = new Set();
    const push = (rat) => {
      const key = rat.toString();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(rat);
      }
    };
    // Full integer coefficients are kept for exact candidate checking.
    const fullCoeffs = intCoeffs;
    const fullN = fullCoeffs.length - 1;
    // Factor out x^m when the constant term is zero so the remaining
    // rational roots are still enumerated; 0 itself is a root.
    while (intCoeffs.length > 1 && intCoeffs[0] === 0n) {
      push(Rat.zero());
      intCoeffs = intCoeffs.slice(1);
    }
    const constant = intCoeffs[0];
    const leading = intCoeffs[intCoeffs.length - 1];
    if (constant === 0n) {
      push(Rat.zero()); // polynomial is a monomial c*x^n
    }
    const ps = constant === 0n ? [] : divisors(constant);
    for (const p of ps) {
      for (const q of divisors(leading)) {
        push(new Rat(p, q));
        push(new Rat(-p, q));
      }
    }

    const roots = [];
    for (const cand of candidates) {
      // q^n * P(p/q) = sum a_i p^i q^(n-i), an exact integer.
      let exact = 0n;
      for (let i = 0; i <= fullN; i += 1) {
        exact += fullCoeffs[i] * (cand.num ** BigInt(i)) * (cand.den ** BigInt(fullN - i));
      }
      if (exact === 0n) roots.push(cand);
    }
    roots.sort((a, b) => a.cmp(b));
    return roots;
  }

  // Exact extrema on [lo, hi]: evaluates P at both endpoints and at every
  // rational stationary point inside the interval, then takes min/max.
  // Required method for odd-degree or otherwise hard-to-classify cases.
  extremaOnInterval(lo, hi) {
    const loRat = Rat.parse(lo);
    const hiRat = Rat.parse(hi);
    if (loRat.cmp(hiRat) > 0) {
      throw configError(`E_CONFIG: empty interval [${loRat}, ${hiRat}] (lo > hi)`);
    }
    const points = [loRat, hiRat];
    for (const root of this.derivative().rationalRoots()) {
      if (root.cmp(loRat) > 0 && root.cmp(hiRat) < 0) points.push(root);
    }
    let min = null;
    let max = null;
    let argMin = null;
    let argMax = null;
    for (const point of points) {
      const value = this.evaluate(point);
      if (min === null || value.cmp(min) < 0) {
        min = value;
        argMin = point;
      }
      if (max === null || value.cmp(max) > 0) {
        max = value;
        argMax = point;
      }
    }
    return { min, max, argMin, argMax, samplePoints: points };
  }
}
