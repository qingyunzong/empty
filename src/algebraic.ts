import { gcd3, squarefreePart } from './bigint-util.js';
import { Rational } from './rational.js';

/**
 * Exact algebraic coordinate of the form
 *
 *     value = (p + q * sqrt(radicand)) / r
 *
 * Invariants after normalization:
 *  - r > 0
 *  - if q === 0 the value is rational (radicand === 0) and p/r is in lowest terms
 *  - if q !== 0 then radicand > 1 is square-free (for all factors up to the
 *    extraction bound) and gcd(|p|, |q|, r) === 1
 */
export interface ExactCoord {
  readonly p: bigint;
  readonly q: bigint;
  readonly r: bigint;
  readonly radicand: bigint;
}

export function makeExactCoord(p: bigint, q: bigint, r: bigint, radicand: bigint): ExactCoord {
  if (r === 0n) throw new RangeError('ExactCoord with zero denominator');
  if (radicand < 0n) throw new RangeError('ExactCoord with negative radicand');
  if (q === 0n || radicand === 0n) {
    const g = gcd3(p, 0n, r) || 1n;
    let np = p / g;
    let nr = r / g;
    if (nr < 0n) {
      np = -np;
      nr = -nr;
    }
    return { p: np, q: 0n, r: nr, radicand: 0n };
  }
  const { root, squarefree } = squarefreePart(radicand);
  if (squarefree === 1n) {
    // sqrt(radicand) = root is an integer: collapse to a rational.
    return makeExactCoord(p + q * root, 0n, r, 0n);
  }
  let np = p;
  let nq = q * root;
  let nr = r;
  const g = gcd3(np, nq, nr);
  if (g > 1n) {
    np /= g;
    nq /= g;
    nr /= g;
  }
  if (nr < 0n) {
    np = -np;
    nq = -nq;
    nr = -nr;
  }
  return { p: np, q: nq, r: nr, radicand: squarefree };
}

export function rationalCoord(value: Rational): ExactCoord {
  return { p: value.num, q: 0n, r: value.den, radicand: 0n };
}

export function isRationalCoord(c: ExactCoord): boolean {
  return c.q === 0n;
}

export function coordToRational(c: ExactCoord): Rational {
  if (c.q !== 0n) throw new Error('not a rational coordinate');
  return Rational.make(c.p, c.r);
}

/** Floating-point approximation (display / sanity checks only). */
export function approxCoord(c: ExactCoord): number {
  return (Number(c.p) + Number(c.q) * Math.sqrt(Number(c.radicand))) / Number(c.r);
}

export function coordToString(c: ExactCoord): string {
  if (c.q === 0n) return Rational.make(c.p, c.r).toString();
  const rad = `sqrt(${c.radicand})`;
  let num: string;
  if (c.p === 0n) {
    num = c.q === 1n ? rad : c.q === -1n ? `-${rad}` : `${c.q}*${rad}`;
  } else {
    const qAbs = c.q < 0n ? -c.q : c.q;
    const qTerm = qAbs === 1n ? rad : `${qAbs}*${rad}`;
    num = c.q > 0n ? `${c.p} + ${qTerm}` : `${c.p} - ${qTerm}`;
  }
  return c.r === 1n ? `(${num})` : `(${num})/${c.r}`;
}
