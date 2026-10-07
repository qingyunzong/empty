import { Fraction } from "./fraction.js";

/** Closed interval with exact rational endpoints, lo <= hi. */
export interface Interval {
  readonly lo: Fraction;
  readonly hi: Fraction;
}

export function ivPoint(f: Fraction): Interval {
  return { lo: f, hi: f };
}

export function ivOf(lo: Fraction, hi: Fraction): Interval {
  return lo.cmp(hi) <= 0 ? { lo, hi } : { lo: hi, hi: lo };
}

export function ivAdd(a: Interval, b: Interval): Interval {
  return { lo: a.lo.add(b.lo), hi: a.hi.add(b.hi) };
}

export function ivSub(a: Interval, b: Interval): Interval {
  return { lo: a.lo.sub(b.hi), hi: a.hi.sub(b.lo) };
}

export function ivMul(a: Interval, b: Interval): Interval {
  const p1 = a.lo.mul(b.lo);
  const p2 = a.lo.mul(b.hi);
  const p3 = a.hi.mul(b.lo);
  const p4 = a.hi.mul(b.hi);
  return {
    lo: Fraction.min(Fraction.min(p1, p2), Fraction.min(p3, p4)),
    hi: Fraction.max(Fraction.max(p1, p2), Fraction.max(p3, p4)),
  };
}

export function ivContainsZero(a: Interval): boolean {
  return a.lo.sign() <= 0 && a.hi.sign() >= 0;
}

/** Division; throws if the denominator interval contains zero. */
export function ivDiv(a: Interval, b: Interval): Interval {
  if (ivContainsZero(b)) {
    throw new Error("interval division by an interval containing zero");
  }
  const inv = ivOf(Fraction.ONE.div(b.lo), Fraction.ONE.div(b.hi));
  return ivMul(a, inv);
}

export function ivUnion(a: Interval, b: Interval): Interval {
  return { lo: Fraction.min(a.lo, b.lo), hi: Fraction.max(a.hi, b.hi) };
}

export function ivWidth(a: Interval): Fraction {
  return a.hi.sub(a.lo);
}

/** Intersection with [lo, hi]; null when disjoint. */
export function ivClamp(a: Interval, lo: Fraction, hi: Fraction): Interval | null {
  if (a.hi.cmp(lo) < 0 || a.lo.cmp(hi) > 0) return null;
  return { lo: Fraction.max(a.lo, lo), hi: Fraction.min(a.hi, hi) };
}

export function ivContainsValue(a: Interval, v: Fraction): boolean {
  return a.lo.cmp(v) <= 0 && v.cmp(a.hi) <= 0;
}
