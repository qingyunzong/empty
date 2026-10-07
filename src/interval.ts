/**
 * Rational interval arithmetic and exact root isolation for quadratic
 * polynomials with BigInt coefficients.
 */
import { Rat } from "./rat.js";

export interface Interval {
  lo: Rat;
  hi: Rat;
}

export function interval(lo: Rat, hi: Rat): Interval {
  return lo.le(hi) ? { lo, hi } : { lo: hi, hi: lo };
}

export function intervalWidth(iv: Interval): Rat {
  return iv.hi.sub(iv.lo);
}

/** Integer square root: floor(sqrt(n)) for n >= 0, exact via Newton iteration. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt: negative input");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Sign of a*t^2 + b*t + c at rational t, computed exactly in BigInt. */
function quadSign(a: bigint, b: bigint, c: bigint, t: Rat): -1 | 0 | 1 {
  const n = t.num;
  const d = t.den;
  const v = a * n * n + b * n * d + c * d * d;
  return v < 0n ? -1 : v > 0n ? 1 : 0;
}

/**
 * Bisection refinement of a bracket [lo, hi] known to contain exactly one
 * root of a*t^2+b*t+c, until the bracket width is <= eps (or the root is
 * hit exactly, collapsing the bracket to a point).
 */
function refineBracket(
  a: bigint,
  b: bigint,
  c: bigint,
  lo: Rat,
  hi: Rat,
  eps: Rat,
): Interval {
  let slo = quadSign(a, b, c, lo);
  for (;;) {
    if (slo === 0) return { lo, hi: lo };
    if (hi.sub(lo).le(eps)) return { lo, hi };
    const mid = lo.mid(hi);
    const sm = quadSign(a, b, c, mid);
    if (sm === 0) return { lo: mid, hi: mid };
    if (sm === slo) {
      lo = mid;
      slo = sm;
    } else {
      hi = mid;
    }
  }
}

/**
 * Isolate all roots of a*t^2 + b*t + c (BigInt coefficients, not all zero)
 * lying in the OPEN interval (0, 1). Each returned interval has rational
 * endpoints, width <= eps (or zero for rational roots), and is guaranteed
 * to contain exactly one root. Roots exactly at t = 0 or t = 1 are excluded.
 */
export function isolateQuadraticRoots(
  a: bigint,
  b: bigint,
  c: bigint,
  eps: Rat,
): Interval[] {
  const out: Interval[] = [];
  if (a === 0n && b === 0n) return out;

  const pushIfInterior = (iv: Interval): void => {
    const zero = Rat.ZERO;
    const one = Rat.ONE;
    // Root is known to lie in [lo, hi]; it is interior iff the whole
    // bracket (clipped) stays strictly inside (0, 1).
    if (iv.hi.le(zero) || iv.lo.ge(one)) return;
    const lo = iv.lo.lt(zero) ? zero : iv.lo;
    const hi = iv.hi.gt(one) ? one : iv.hi;
    if (lo.eq(hi)) {
      // Root exactly at an endpoint of [0,1]: excluded by contract.
      if (lo.eq(zero) || lo.eq(one)) return;
    }
    out.push({ lo, hi });
  };

  if (a === 0n) {
    // Linear: single rational root t = -c/b.
    const t = Rat.of(-c, b);
    if (t.gt(Rat.ZERO) && t.lt(Rat.ONE)) out.push({ lo: t, hi: t });
    return out;
  }

  const disc = b * b - 4n * a * c;
  if (disc < 0n) return out;

  if (disc === 0n) {
    // Tangent double root, rational.
    const t = Rat.of(-b, 2n * a);
    if (t.gt(Rat.ZERO) && t.lt(Rat.ONE)) out.push({ lo: t, hi: t });
    return out;
  }

  const s = isqrt(disc);
  if (s * s === disc) {
    // Both roots rational.
    for (const sigma of [-1n, 1n]) {
      const t = Rat.of(-b + sigma * s, 2n * a);
      if (t.gt(Rat.ZERO) && t.lt(Rat.ONE)) out.push({ lo: t, hi: t });
    }
    return out;
  }

  // Irrational roots: sqrt(disc) in (s, s+1) gives an initial rational
  // bracket of width 1/|2a|, which is narrower than the root separation
  // sqrt(disc)/|a|, so each bracket holds exactly one root.
  for (const sigma of [-1n, 1n]) {
    const r1 = Rat.of(-b + sigma * s, 2n * a);
    const r2 = Rat.of(-b + sigma * (s + 1n), 2n * a);
    let { lo, hi } = interval(r1, r2);

    // Resolve boundary straddling: while the bracket straddles 0 or 1 and
    // the polynomial is nonzero there, keep refining (the root cannot be
    // exactly 0 or 1 in that case, so this terminates).
    for (;;) {
      const straddles0 = lo.lt(Rat.ZERO) && hi.gt(Rat.ZERO) && c !== 0n;
      const straddles1 = lo.lt(Rat.ONE) && hi.gt(Rat.ONE) && a + b + c !== 0n;
      if (!straddles0 && !straddles1) break;
      const refined = refineBracket(a, b, c, lo, hi, eps);
      lo = refined.lo;
      hi = refined.hi;
      if (lo.eq(hi)) break; // exact rational root found
    }

    const refined = refineBracket(a, b, c, lo, hi, eps);
    pushIfInterior(refined);
  }
  return out;
}

/**
 * Exact ranges of the quadratic Bernstein basis functions over
 * [lo, hi] subset of [0, 1]. All bounds are exact rationals.
 */
export function bernsteinRanges(lo: Rat, hi: Rat): [Interval, Interval, Interval] {
  const one = Rat.ONE;
  const half = Rat.of(1n, 2n);
  // B0 = (1-t)^2, decreasing on [0,1].
  const b0: Interval = { lo: one.sub(hi).mul(one.sub(hi)), hi: one.sub(lo).mul(one.sub(lo)) };
  // B2 = t^2, increasing on [0,1].
  const b2: Interval = { lo: lo.mul(lo), hi: hi.mul(hi) };
  // B1 = 2t(1-t), peaks at t = 1/2 with value 1/2.
  const atLo = lo.mul(one.sub(lo)).mul(Rat.of(2n));
  const atHi = hi.mul(one.sub(hi)).mul(Rat.of(2n));
  const b1: Interval = {
    lo: Rat.min(atLo, atHi),
    hi: lo.le(half) && half.le(hi) ? half : Rat.max(atLo, atHi),
  };
  return [b0, b1, b2];
}

function scaleInterval(c: Rat, iv: Interval): Interval {
  if (c.isZero()) return { lo: Rat.ZERO, hi: Rat.ZERO };
  return c.sign() > 0
    ? { lo: c.mul(iv.lo), hi: c.mul(iv.hi) }
    : { lo: c.mul(iv.hi), hi: c.mul(iv.lo) };
}

function addInterval(p: Interval, q: Interval): Interval {
  return { lo: p.lo.add(q.lo), hi: p.hi.add(q.hi) };
}

/**
 * Enclosure of sum_i nc[i]*B_i(t) / sum_i dc[i]*B_i(t) for t in [lo, hi]
 * (subset of [0, 1]). Requires the denominator Bernstein coefficients to
 * be positive so the denominator stays strictly positive on [0, 1].
 * The result is a valid (slightly conservative) rational enclosure.
 */
export function evalRationalBezierInterval(
  nc: readonly [Rat, Rat, Rat],
  dc: readonly [Rat, Rat, Rat],
  lo: Rat,
  hi: Rat,
): Interval {
  const [b0, b1, b2] = bernsteinRanges(lo, hi);
  const basis = [b0, b1, b2] as const;

  let num: Interval = { lo: Rat.ZERO, hi: Rat.ZERO };
  let den: Interval = { lo: Rat.ZERO, hi: Rat.ZERO };
  for (let i = 0; i < 3; i++) {
    num = addInterval(num, scaleInterval(nc[i]!, basis[i]!));
    den = addInterval(den, scaleInterval(dc[i]!, basis[i]!));
  }
  if (den.lo.sign() <= 0) {
    throw new Error("evalRationalBezierInterval: denominator enclosure not positive");
  }
  // Denominator strictly positive: divide endpoint combinations.
  const quotients = [
    num.lo.div(den.lo),
    num.lo.div(den.hi),
    num.hi.div(den.lo),
    num.hi.div(den.hi),
  ];
  return {
    lo: quotients.reduce((m, q) => Rat.min(m, q)),
    hi: quotients.reduce((m, q) => Rat.max(m, q)),
  };
}
