import { Rat, RAT_ZERO, RAT_ONE, RAT_TWO } from './rational.js';

// Polynomials are arrays of Rat coefficients, index = power, trimmed (no
// trailing zeros). The zero polynomial is the empty array.

export function trim(p) {
  let end = p.length;
  while (end > 0 && p[end - 1].isZero()) end -= 1;
  return p.slice(0, end);
}

export function isZeroPoly(p) {
  return p.length === 0;
}

export function degree(p) {
  return p.length - 1;
}

export function evalPoly(p, x) {
  let acc = RAT_ZERO;
  for (let i = p.length - 1; i >= 0; i -= 1) acc = acc.mul(x).add(p[i]);
  return acc;
}

export function derivative(p) {
  const out = [];
  for (let i = 1; i < p.length; i += 1) out.push(p[i].mul(Rat.int(i)));
  return trim(out);
}

export function antiderivative(p) {
  const out = [RAT_ZERO];
  for (let i = 0; i < p.length; i += 1) out.push(p[i].div(Rat.int(i + 1)));
  return trim(out);
}

export function integral(p, a, b) {
  const anti = antiderivative(p);
  return evalPoly(anti, b).sub(evalPoly(anti, a));
}

function powRat(x, e) {
  let acc = RAT_ONE;
  for (let i = 0; i < e; i += 1) acc = acc.mul(x);
  return acc;
}

// Independent cross-check: direct monomial summation, no antiderivative poly.
export function monomialSumIntegral(p, a, b) {
  let acc = RAT_ZERO;
  for (let i = 0; i < p.length; i += 1) {
    const diff = powRat(b, i + 1).sub(powRat(a, i + 1));
    acc = acc.add(p[i].mul(diff).div(Rat.int(i + 1)));
  }
  return acc;
}

export function negPoly(p) {
  return p.map((c) => c.neg());
}

export function divRem(u, v) {
  const uu = trim(u);
  const vv = trim(v);
  if (isZeroPoly(vv)) throw new Error('polynomial division by zero polynomial');
  if (degree(uu) < degree(vv)) return [[], uu];
  const quot = new Array(degree(uu) - degree(vv) + 1).fill(RAT_ZERO);
  let rem = uu.slice();
  const lcV = vv[degree(vv)];
  while (!isZeroPoly(rem) && degree(rem) >= degree(vv)) {
    const shift = degree(rem) - degree(vv);
    const coeff = rem[degree(rem)].div(lcV);
    quot[shift] = quot[shift].add(coeff);
    const next = new Array(rem.length);
    for (let i = 0; i < rem.length; i += 1) {
      const j = i - shift;
      next[i] = j >= 0 && j < vv.length ? rem[i].sub(coeff.mul(vv[j])) : rem[i];
    }
    rem = trim(next);
  }
  return [trim(quot), rem];
}

// p(a) === 0; returns q with p(t) = (t - a) * q(t) (synthetic division).
export function deflate(p, a) {
  const n = p.length - 1;
  const q = new Array(n);
  let acc = p[n];
  for (let i = n - 1; i >= 0; i -= 1) {
    q[i] = acc;
    acc = p[i].add(acc.mul(a));
  }
  return trim(q);
}

export function sturmSequence(p) {
  const seq = [];
  const p0 = trim(p);
  if (isZeroPoly(p0)) return seq;
  seq.push(p0);
  const p1 = derivative(p0);
  if (isZeroPoly(p1)) return seq;
  seq.push(p1);
  for (;;) {
    const [, r] = divRem(seq[seq.length - 2], seq[seq.length - 1]);
    if (isZeroPoly(r)) break;
    seq.push(negPoly(r));
  }
  return seq;
}

export function signVariations(seq, x) {
  let count = 0;
  let prev = 0;
  for (const q of seq) {
    const s = evalPoly(q, x).sign();
    if (s === 0) continue;
    if (prev !== 0 && s !== prev) count += 1;
    prev = s;
  }
  return count;
}

function midpoint(x, y) {
  return x.add(y).div(RAT_TWO);
}

// Distinct real roots of p in (a, b], as pairwise strictly separated
// isolating intervals with rational endpoints inside (a, b).
export function isolateRoots(p, a, b) {
  const seq = sturmSequence(p);
  const count = (l, r) => signVariations(seq, l) - signVariations(seq, r);
  const total = count(a, b);
  if (total <= 0) return [];
  const isolated = [];
  const stack = [[a, b, total]];
  let guard = 0;
  while (stack.length > 0) {
    guard += 1;
    if (guard > 100000) throw new Error('root isolation did not converge');
    const [l, r, n] = stack.pop();
    if (n === 0) continue;
    if (n === 1) {
      isolated.push([l, r]);
      continue;
    }
    const m = midpoint(l, r);
    stack.push([l, m, count(l, m)], [m, r, count(m, r)]);
  }
  isolated.sort((x, y) => x[0].cmp(y[0]));
  const refineOne = (i) => {
    const [l, r] = isolated[i];
    const m = midpoint(l, r);
    isolated[i] = count(l, m) === 1 ? [l, m] : [m, r];
  };
  guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 100000) throw new Error('root refinement did not converge');
    let needs = false;
    for (let i = 0; i < isolated.length; i += 1) {
      const [l, r] = isolated[i];
      if (
        l.cmp(a) <= 0
        || r.cmp(b) >= 0
        || (i > 0 && isolated[i - 1][1].cmp(l) >= 0)
        || (i + 1 < isolated.length && r.cmp(isolated[i + 1][0]) >= 0)
      ) {
        refineOne(i);
        needs = true;
      }
    }
    if (!needs) return isolated;
  }
}

// Exact decision procedure for "p(t) >= 0 for all t in [a, b]".
export function isNonNegativeOn(p0, a, b) {
  let p = trim(p0);
  if (isZeroPoly(p)) return true;
  if (evalPoly(p, a).sign() < 0 || evalPoly(p, b).sign() < 0) return false;
  // Peel roots at the endpoints. On (a, b), (t - a)^i > 0 and (t - b)^j has
  // constant sign (-1)^j, so p >= 0 iff (-1)^j * q >= 0 for the peeled q.
  while (!isZeroPoly(p) && evalPoly(p, a).isZero()) p = deflate(p, a);
  let flip = false;
  while (!isZeroPoly(p) && evalPoly(p, b).isZero()) {
    p = deflate(p, b);
    flip = !flip;
  }
  if (isZeroPoly(p)) return true;
  if (flip) p = negPoly(p);
  if (evalPoly(p, a).sign() < 0 || evalPoly(p, b).sign() < 0) return false;
  // p now has no roots at a or b; every sign-negative region in (a, b) is
  // bounded by distinct roots, so sampling between isolating intervals of
  // the roots is a complete check.
  const intervals = isolateRoots(p, a, b);
  const samples = [];
  let prev = a;
  for (const [l, r] of intervals) {
    if (prev.cmp(l) < 0) samples.push(midpoint(prev, l));
    prev = r;
  }
  if (prev.cmp(b) < 0) samples.push(midpoint(prev, b));
  for (const s of samples) {
    if (evalPoly(p, s).sign() < 0) return false;
  }
  return true;
}
