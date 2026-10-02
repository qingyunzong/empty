'use strict';

const { Frac, minFrac, maxFrac } = require('./fraction.js');

// Axis-aligned rectangle with half-open bounds: [x1, x2) x [y1, y2).
class Rect {
  constructor(x1, y1, x2, y2) {
    this.x1 = Frac.from(x1);
    this.y1 = Frac.from(y1);
    this.x2 = Frac.from(x2);
    this.y2 = Frac.from(y2);
    Object.freeze(this);
  }

  static fromArray(arr) {
    if (!Array.isArray(arr) || arr.length !== 4) {
      throw new TypeError(`rect must be [x1, y1, x2, y2], got ${JSON.stringify(arr)}`);
    }
    return new Rect(arr[0], arr[1], arr[2], arr[3]);
  }

  isValid() {
    return this.x1.lt(this.x2) && this.y1.lt(this.y2);
  }

  width() { return this.x2.sub(this.x1); }
  height() { return this.y2.sub(this.y1); }
  area() { return this.width().mul(this.height()); }

  // Half-open intersection; shared edges yield zero-area (empty) result.
  intersect(other) {
    const x1 = maxFrac(this.x1, other.x1);
    const y1 = maxFrac(this.y1, other.y1);
    const x2 = minFrac(this.x2, other.x2);
    const y2 = minFrac(this.y2, other.y2);
    if (x1.cmp(x2) >= 0 || y1.cmp(y2) >= 0) return null;
    return new Rect(x1, y1, x2, y2);
  }

  overlapArea(other) {
    const r = this.intersect(other);
    return r === null ? Frac.zero() : r.area();
  }

  translate(dx, dy) {
    const fdx = Frac.from(dx);
    const fdy = Frac.from(dy);
    return new Rect(this.x1.add(fdx), this.y1.add(fdy), this.x2.add(fdx), this.y2.add(fdy));
  }

  // Scale about an anchor point; factor must be a positive rational.
  scale(factor, anchor) {
    const k = Frac.from(factor);
    if (!k.isPositive()) throw new RangeError(`scale factor must be positive, got ${k}`);
    const ax = Frac.from(anchor.x);
    const ay = Frac.from(anchor.y);
    const map = (v, a) => a.add(v.sub(a).mul(k));
    return new Rect(map(this.x1, ax), map(this.y1, ay), map(this.x2, ax), map(this.y2, ay));
  }

  center() {
    const two = Frac.from(2n);
    return { x: this.x1.add(this.x2).div(two), y: this.y1.add(this.y2).div(two) };
  }

  toArray() { return [this.x1.toString(), this.y1.toString(), this.x2.toString(), this.y2.toString()]; }
  toJSON() { return this.toArray(); }
}

// Cut the range [lo, hi) with the sorted unique coordinates from `coords`
// that fall strictly inside, returning half-open intervals covering [lo, hi).
function cutIntervals(lo, hi, coords) {
  const cuts = [lo];
  const seen = new Set([lo.toString(), hi.toString()]);
  const inner = [];
  for (const c of coords) {
    const key = c.toString();
    if (!seen.has(key) && c.gt(lo) && c.lt(hi)) {
      seen.add(key);
      inner.push(c);
    }
  }
  inner.sort((a, b) => a.cmp(b));
  cuts.push(...inner, hi);
  const intervals = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    intervals.push([cuts[i].toString(), cuts[i + 1].toString()]);
  }
  return intervals;
}

// Certificate for an overlap rectangle: the rect itself plus the x/y cut
// intervals induced by all device/defect coordinates, so the overlap area
// can be re-verified as the sum of the elementary grid cells.
function overlapCertificate(overlap, allRects) {
  const xs = [];
  const ys = [];
  for (const r of allRects) {
    xs.push(r.x1, r.x2);
    ys.push(r.y1, r.y2);
  }
  return {
    rect: overlap.toArray(),
    area: overlap.area().toString(),
    xIntervals: cutIntervals(overlap.x1, overlap.x2, xs),
    yIntervals: cutIntervals(overlap.y1, overlap.y2, ys),
  };
}

module.exports = { Rect, cutIntervals, overlapCertificate };
