'use strict';

const { Frac } = require('./rational');

class CurveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Horner evaluation of a polynomial with Frac coefficients at integer t.
function evalPoly(coefs, t) {
  let acc = new Frac(0n);
  for (let i = coefs.length - 1; i >= 0; i--) {
    acc = acc.mul(t).add(coefs[i]);
  }
  return acc;
}

// Antiderivative coefficients: Q[k] = c[k-1] / k, Q[0] = 0.
function antiderivative(coefs) {
  const q = [new Frac(0n)];
  for (let i = 0; i < coefs.length; i++) {
    q.push(coefs[i].div(BigInt(i + 1)));
  }
  return q;
}

class Segment {
  constructor({ from, to, coefs }) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) {
      throw new CurveError('E_SEG', `invalid segment bounds [${from}, ${to})`);
    }
    if (!Array.isArray(coefs)) {
      throw new CurveError('E_SEG', 'segment coefs must be an array of [num, den]');
    }
    this.from = from;
    this.to = to;
    this.coefs = coefs.map(([num, den]) => new Frac(BigInt(num), BigInt(den === undefined ? 1 : den)));
    this.antideriv = antiderivative(this.coefs);
  }

  // Exact integral of the rate polynomial over [a, b), via Horner on the
  // antiderivative coefficients. a, b are integers (day boundaries).
  integrate(a, b) {
    return evalPoly(this.antideriv, BigInt(b)).sub(evalPoly(this.antideriv, BigInt(a)));
  }

  canonical() {
    return `seg:${this.from}:${this.to}:${this.coefs.map((c) => c.toString()).join(',')}`;
  }
}

class Curve {
  constructor(segments) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new CurveError('E_SEG', 'curve requires a non-empty segments array');
    }
    const segs = segments.map((s) => new Segment(s));
    segs.sort((a, b) => a.from - b.from);
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].from < segs[i - 1].to) {
        throw new CurveError(
          'E_SEG',
          `segments overlap: [${segs[i - 1].from}, ${segs[i - 1].to}) and [${segs[i].from}, ${segs[i].to})`
        );
      }
    }
    this.segments = segs;
  }

  // Boundary ownership is uniform: a day t belongs to the segment with
  // from <= t < to, i.e. intervals are [from, to).
  segmentAt(day) {
    return this.segments.findIndex((s) => s.from <= day && day < s.to);
  }

  covers(day) {
    return this.segmentAt(day) !== -1;
  }

  // Uncovered sub-intervals of [from, to), as [a, b) pairs.
  uncovered(from, to) {
    const gaps = [];
    let cur = from;
    for (const s of this.segments) {
      if (s.to <= cur) continue;
      if (s.from >= to) break;
      if (s.from > cur) gaps.push([cur, Math.min(s.from, to)]);
      cur = Math.max(cur, s.to);
      if (cur >= to) break;
    }
    if (cur < to) gaps.push([cur, to]);
    return gaps;
  }

  canonicalLeaves() {
    return this.segments.map((s) => s.canonical());
  }
}

module.exports = { Curve, CurveError, evalPoly, antiderivative };
