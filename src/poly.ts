import { Fraction } from "./fraction";

/** Polynomial with exact rational coefficients: coeff[i] multiplies x^i. */
export type Poly = Fraction[];

export function normalize(p: Poly): Poly {
  let n = p.length;
  while (n > 0 && p[n - 1].isZero()) n--;
  return p.slice(0, n);
}

export function isZero(p: Poly): boolean {
  return p.length === 0;
}

export function isConstant(p: Poly): boolean {
  return p.length <= 1;
}

export function degree(p: Poly): number {
  return p.length - 1;
}

export function add(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out = new Array<Fraction>(n);
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i] : Fraction.ZERO;
    const y = i < b.length ? b[i] : Fraction.ZERO;
    out[i] = x.add(y);
  }
  return normalize(out);
}

export function negate(a: Poly): Poly {
  return a.map((c) => c.neg());
}

export function sub(a: Poly, b: Poly): Poly {
  return add(a, negate(b));
}

export function scale(a: Poly, s: Fraction): Poly {
  if (s.isZero()) return [];
  return normalize(a.map((c) => c.mul(s)));
}

export function mul(a: Poly, b: Poly): Poly {
  if (isZero(a) || isZero(b)) return [];
  const out = new Array<Fraction>(a.length + b.length - 1).fill(Fraction.ZERO);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = out[i + j].add(a[i].mul(b[j]));
    }
  }
  return normalize(out);
}

export function divmod(a: Poly, b: Poly): [Poly, Poly] {
  if (isZero(b)) throw new Error("polynomial division by zero");
  let r = normalize(a);
  const q = new Array<Fraction>(Math.max(1, a.length - b.length + 1)).fill(
    Fraction.ZERO,
  );
  const d = b.length - 1;
  const leadInv = Fraction.ONE.div(b[d]);
  while (r.length > d) {
    const k = r.length - 1 - d;
    const c = r[r.length - 1].mul(leadInv);
    q[k] = c;
    for (let i = 0; i <= d; i++) {
      r[k + i] = r[k + i].sub(c.mul(b[i]));
    }
    r = normalize(r);
  }
  return [normalize(q), r];
}

export function divExact(a: Poly, b: Poly): Poly {
  const [q, r] = divmod(a, b);
  if (!isZero(r)) throw new Error("polynomial division is not exact");
  return q;
}

export function derivative(p: Poly): Poly {
  const out: Fraction[] = [];
  for (let i = 1; i < p.length; i++) {
    out.push(p[i].mul(Fraction.of(i)));
  }
  return normalize(out);
}

export function makeMonic(p: Poly): Poly {
  if (isZero(p)) return [];
  return scale(p, Fraction.ONE.div(p[p.length - 1]));
}

export function gcd(a: Poly, b: Poly): Poly {
  let x = normalize(a);
  let y = normalize(b);
  while (!isZero(y)) {
    const [, r] = divmod(x, y);
    x = y;
    y = r;
  }
  return makeMonic(x);
}

export function evalAt(p: Poly, x: Fraction): Fraction {
  let acc = Fraction.ZERO;
  for (let i = p.length - 1; i >= 0; i--) {
    acc = acc.mul(x).add(p[i]);
  }
  return acc;
}

/** Number of sign changes in the coefficient list, zeros skipped. */
export function signVariations(p: Poly): number {
  let count = 0;
  let prev = 0;
  for (const c of p) {
    const s = c.sign();
    if (s === 0) continue;
    if (prev !== 0 && s !== prev) count++;
    prev = s;
  }
  return count;
}

/**
 * Mobius transform mapping the open interval (a, b) to (0, +inf):
 * g(x) = (1 + x)^n * f((a + b*x) / (1 + x)), n = deg(f).
 * Roots of f in (a, b) correspond bijectively to positive roots of g,
 * so Descartes' rule on g bounds the number of roots of f in (a, b).
 */
export function mobius(f: Poly, a: Fraction, b: Fraction): Poly {
  const n = f.length - 1;
  const ab: Poly = [a, b];
  const oneX: Poly = [Fraction.ONE, Fraction.ONE];
  const pows1x: Poly[] = [[Fraction.ONE]];
  for (let k = 1; k <= n; k++) {
    pows1x.push(mul(pows1x[k - 1], oneX));
  }
  let result: Poly = [];
  let powAB: Poly = [Fraction.ONE];
  for (let i = 0; i <= n; i++) {
    result = add(result, scale(mul(powAB, pows1x[n - i]), f[i]));
    powAB = mul(powAB, ab);
  }
  return normalize(result);
}

/**
 * Yun's square-free factorization over Q (characteristic 0):
 * returns factors f_i such that f = prod f_i^i, each f_i square-free
 * with roots of multiplicity exactly i in f.
 */
export function squareFree(f: Poly): { factor: Poly; multiplicity: number }[] {
  const df = derivative(f);
  let c = gcd(f, df);
  let w = divExact(f, c);
  const out: { factor: Poly; multiplicity: number }[] = [];
  let m = 1;
  while (!isConstant(w)) {
    const y = gcd(w, c);
    const z = divExact(w, y);
    if (!isConstant(z)) out.push({ factor: makeMonic(z), multiplicity: m });
    w = y;
    c = divExact(c, y);
    m++;
  }
  return out;
}
