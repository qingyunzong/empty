import { Fraction } from "./fraction.js";
import { Interval, ivAdd, ivMul, ivPoint } from "./interval.js";

/** Polynomial with exact rational coefficients, ascending degree: p[0] + p[1] t + ... */
export type Poly = Fraction[];

export function polyTrim(p: Poly): Poly {
  let deg = p.length - 1;
  while (deg > 0 && p[deg].isZero) deg--;
  return p.slice(0, deg + 1);
}

export function polyAdd(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const ai = i < a.length ? a[i] : Fraction.ZERO;
    const bi = i < b.length ? b[i] : Fraction.ZERO;
    out.push(ai.add(bi));
  }
  return out;
}

export function polySub(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const ai = i < a.length ? a[i] : Fraction.ZERO;
    const bi = i < b.length ? b[i] : Fraction.ZERO;
    out.push(ai.sub(bi));
  }
  return out;
}

export function polyMul(a: Poly, b: Poly): Poly {
  const out: Poly = new Array(a.length + b.length - 1).fill(Fraction.ZERO);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = out[i + j].add(a[i].mul(b[j]));
    }
  }
  return out;
}

export function polyDer(p: Poly): Poly {
  if (p.length <= 1) return [Fraction.ZERO];
  const out: Poly = [];
  for (let i = 1; i < p.length; i++) {
    out.push(p[i].mul(Fraction.of(BigInt(i))));
  }
  return out;
}

/** Exact evaluation at a rational point (Horner). */
export function polyEval(p: Poly, t: Fraction): Fraction {
  let acc = p[p.length - 1];
  for (let i = p.length - 2; i >= 0; i--) {
    acc = acc.mul(t).add(p[i]);
  }
  return acc;
}

/** Conservative evaluation over a rational interval (Horner with interval arithmetic). */
export function polyEvalInterval(p: Poly, t: Interval): Interval {
  let acc = ivPoint(p[p.length - 1]);
  for (let i = p.length - 2; i >= 0; i--) {
    acc = ivAdd(ivMul(acc, t), ivPoint(p[i]));
  }
  return acc;
}
