import { Rat } from "./rational";

/** Polynomial in power basis: p[i] is the coefficient of t^i. Canonical form has no trailing zeros; [] is the zero polynomial. */
export type Poly = Rat[];

export function trim(p: Poly): Poly {
  let end = p.length;
  while (end > 0 && p[end - 1]!.isZero()) end--;
  return p.slice(0, end);
}

export function deg(p: Poly): number {
  return trim(p).length - 1;
}

export function isZeroPoly(p: Poly): boolean {
  return trim(p).length === 0;
}

export function evalPoly(p: Poly, x: Rat): Rat {
  let acc = Rat.zero();
  for (let i = p.length - 1; i >= 0; i--) acc = acc.mul(x).add(p[i]!);
  return acc;
}

export function deriv(p: Poly): Poly {
  const out: Rat[] = [];
  for (let i = 1; i < p.length; i++) out.push(p[i]!.mul(Rat.of(i)));
  return trim(out);
}

export function addPoly(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out: Rat[] = [];
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i]! : Rat.zero();
    const y = i < b.length ? b[i]! : Rat.zero();
    out.push(x.add(y));
  }
  return trim(out);
}

export function subPoly(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out: Rat[] = [];
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i]! : Rat.zero();
    const y = i < b.length ? b[i]! : Rat.zero();
    out.push(x.sub(y));
  }
  return trim(out);
}

export function scalePoly(p: Poly, s: Rat): Poly {
  return trim(p.map((c) => c.mul(s)));
}

export function mulPoly(a: Poly, b: Poly): Poly {
  if (isZeroPoly(a) || isZeroPoly(b)) return [];
  const out: Rat[] = Array.from({ length: a.length + b.length - 1 }, () => Rat.zero());
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) out[i + j] = out[i + j]!.add(a[i]!.mul(b[j]!));
  return trim(out);
}

/** Exact polynomial division over the rationals. Returns [quotient, remainder]. */
export function divmodPoly(a: Poly, b: Poly): [Poly, Poly] {
  const dividend = trim(a).slice();
  const divisor = trim(b);
  if (divisor.length === 0) throw new Error("polynomial division by zero");
  const q: Rat[] = Array.from({ length: Math.max(0, dividend.length - divisor.length + 1) }, () =>
    Rat.zero(),
  );
  let rem = dividend;
  while (rem.length >= divisor.length && rem.length > 0) {
    const shift = rem.length - divisor.length;
    const factor = rem[rem.length - 1]!.div(divisor[divisor.length - 1]!);
    q[shift] = factor;
    const sub: Rat[] = Array.from({ length: shift }, () => Rat.zero());
    for (let i = 0; i < divisor.length; i++) sub.push(divisor[i]!.mul(factor));
    rem = trim(subPoly(rem, sub));
  }
  return [trim(q), trim(rem)];
}

export function divExact(a: Poly, b: Poly): Poly {
  const [q, r] = divmodPoly(a, b);
  if (!isZeroPoly(r)) throw new Error("expected exact polynomial division");
  return q;
}

/** Monic greatest common divisor of two polynomials over the rationals. */
export function gcdPoly(a: Poly, b: Poly): Poly {
  let x = trim(a);
  let y = trim(b);
  if (x.length === 0) return y;
  if (y.length === 0) return x;
  while (y.length > 0) {
    const [, r] = divmodPoly(x, y);
    x = y;
    y = r;
  }
  const lc = x[x.length - 1]!;
  return scalePoly(x, Rat.one().div(lc));
}

/** Order of vanishing of p at x (0 if p(x) != 0). Exact. */
export function multiplicityAt(p: Poly, x: Rat): number {
  if (isZeroPoly(p)) throw new Error("zero polynomial has infinite multiplicity");
  let m = 0;
  let cur = trim(p);
  const linear: Poly = [x.neg(), Rat.one()];
  while (cur.length > 0 && evalPoly(cur, x).isZero()) {
    m++;
    cur = divExact(cur, linear);
  }
  return m;
}
