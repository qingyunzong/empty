import { Rational, RationalInput } from './rational.js';

/** Closed interval with exact rational endpoints. */
export interface RationalInterval {
  readonly lo: Rational;
  readonly hi: Rational;
}

export function makeInterval(lo: RationalInput, hi: RationalInput): RationalInterval {
  const a = Rational.from(lo);
  const b = Rational.from(hi);
  if (a.cmp(b) > 0) throw new Error(`empty interval: [${a}, ${b}]`);
  return { lo: a, hi: b };
}

export function ivConst(c: RationalInput): RationalInterval {
  const r = Rational.from(c);
  return { lo: r, hi: r };
}

export function ivAdd(x: RationalInterval, y: RationalInterval): RationalInterval {
  return { lo: x.lo.add(y.lo), hi: x.hi.add(y.hi) };
}

export function ivNeg(x: RationalInterval): RationalInterval {
  return { lo: x.hi.neg(), hi: x.lo.neg() };
}

export function ivScale(s: RationalInput, x: RationalInterval): RationalInterval {
  const r = Rational.from(s);
  if (r.sign() >= 0) return { lo: r.mul(x.lo), hi: r.mul(x.hi) };
  return { lo: r.mul(x.hi), hi: r.mul(x.lo) };
}

export function ivMul(x: RationalInterval, y: RationalInterval): RationalInterval {
  const products = [x.lo.mul(y.lo), x.lo.mul(y.hi), x.hi.mul(y.lo), x.hi.mul(y.hi)];
  let lo = products[0]!;
  let hi = products[0]!;
  for (const p of products) {
    if (p.cmp(lo) < 0) lo = p;
    if (p.cmp(hi) > 0) hi = p;
  }
  return { lo, hi };
}

export function ivSquare(x: RationalInterval): RationalInterval {
  if (x.lo.sign() >= 0) return { lo: x.lo.mul(x.lo), hi: x.hi.mul(x.hi) };
  if (x.hi.sign() <= 0) return { lo: x.hi.mul(x.hi), hi: x.lo.mul(x.lo) };
  const a = x.lo.mul(x.lo);
  const b = x.hi.mul(x.hi);
  return { lo: Rational.make(0n), hi: a.cmp(b) >= 0 ? a : b };
}

export function ivContainsZero(x: RationalInterval): boolean {
  return x.lo.sign() <= 0 && x.hi.sign() >= 0;
}

export function ivWidth(x: RationalInterval): Rational {
  return x.hi.sub(x.lo);
}

export function ivMidpoint(x: RationalInterval): Rational {
  return x.lo.add(x.hi).div(2n);
}

export function ivToString(x: RationalInterval): string {
  return `[${x.lo}, ${x.hi}]`;
}
