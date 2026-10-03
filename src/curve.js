import { rat, add, sub, mul, div } from './rational.js';
import { segError, pendingError } from './errors.js';
import { canon, sha256hex } from './canon.js';

// A curve is a sorted list of half-open segments [from, to) with rational
// polynomial coefficients coefs[i] = coefficient of t^i.
export function loadSegments(rawSegments) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    throw segError('segments must be a non-empty array');
  }
  const segs = rawSegments.map((s, i) => {
    if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || s.from < 0 || s.from >= s.to) {
      throw segError(`segment ${i}: invalid bounds [${s.from}, ${s.to})`);
    }
    if (!Array.isArray(s.coefs) || s.coefs.length === 0) {
      throw segError(`segment ${i}: coefs must be a non-empty array of [num, den]`);
    }
    const coefs = s.coefs.map((c, j) => {
      if (!Array.isArray(c) || c.length !== 2) throw segError(`segment ${i} coef ${j}: expected [num, den]`);
      return rat(BigInt(c[0]), BigInt(c[1]));
    });
    return { from: s.from, to: s.to, coefs };
  });
  segs.sort((a, b) => a.from - b.from);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].from < segs[i - 1].to) {
      throw segError(`segments overlap: [${segs[i - 1].from}, ${segs[i - 1].to}) and [${segs[i].from}, ${segs[i].to})`);
    }
  }
  return segs;
}

export function curveRoot(segments) {
  return sha256hex(canon(segments.map((s) => ({
    from: s.from,
    to: s.to,
    coefs: s.coefs.map((c) => [c.n, c.d]),
  }))));
}

// Exact Horner evaluation of sum coefs[i] * t^i at rational t.
export function horner(coefs, t) {
  let acc = rat(0n);
  for (let i = coefs.length - 1; i >= 0; i--) {
    acc = add(mul(acc, t), coefs[i]);
  }
  return acc;
}

// Exact integral of the segment polynomial over [a, b] via the antiderivative
// P(t) = sum coefs[i]/(i+1) * t^(i+1), evaluated with Horner: P(b) - P(a).
export function integral(seg, a, b) {
  const anti = [rat(0n), ...seg.coefs.map((c, i) => div(c, rat(BigInt(i + 1))))];
  return sub(horner(anti, rat(BigInt(b))), horner(anti, rat(BigInt(a))));
}

export function segmentAt(segments, day) {
  for (const s of segments) {
    if (day >= s.from && day < s.to) return s;
  }
  return null;
}

// Exact integral of the rate over [from, to), splitting on segment boundaries.
// Throws E_PENDING if any sub-day is not covered by the curve.
export function rateIntegral(segments, from, to) {
  let acc = rat(0n);
  for (let d = from; d < to; d++) {
    const seg = segmentAt(segments, d);
    if (!seg) throw pendingError(`day ${d} is not covered by the loaded curve`);
    acc = add(acc, integral(seg, d, d + 1));
  }
  return acc;
}
