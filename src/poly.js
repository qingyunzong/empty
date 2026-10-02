'use strict';

const { Rational } = require('./rational');

// Polynomial with exact rational coefficients, coeffs[i] is the coefficient of t^i.
class Poly {
  constructor(coeffs) {
    const c = (coeffs || []).map((x) => Rational.from(x));
    let d = c.length;
    while (d > 0 && c[d - 1].isZero()) d--;
    this.coeffs = c.slice(0, d);
    Object.freeze(this.coeffs);
    Object.freeze(this);
  }

  static zero() { return new Poly([]); }
  static one() { return new Poly([Rational.one()]); }
  static from(coeffs) { return coeffs instanceof Poly ? coeffs : new Poly(coeffs); }

  degree() { return this.coeffs.length - 1; } // -1 for the zero polynomial
  isZero() { return this.coeffs.length === 0; }
  isConstant() { return this.coeffs.length <= 1; }
  lead() { return this.coeffs[this.coeffs.length - 1]; }

  eval(x) {
    x = Rational.from(x);
    let acc = Rational.zero();
    for (let i = this.coeffs.length - 1; i >= 0; i--) {
      acc = acc.mul(x).add(this.coeffs[i]);
    }
    return acc;
  }

  derivative() {
    if (this.isZero()) return this;
    const out = [];
    for (let i = 1; i < this.coeffs.length; i++) {
      out.push(this.coeffs[i].mul(Rational.from(BigInt(i))));
    }
    return new Poly(out);
  }

  antiderivative() {
    const out = [Rational.zero()];
    for (let i = 0; i < this.coeffs.length; i++) {
      out.push(this.coeffs[i].div(Rational.from(BigInt(i + 1))));
    }
    return new Poly(out);
  }

  integrate(a, b) {
    const F = this.antiderivative();
    return F.eval(b).sub(F.eval(a));
  }

  add(o) {
    o = Poly.from(o);
    const n = Math.max(this.coeffs.length, o.coeffs.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = i < this.coeffs.length ? this.coeffs[i] : Rational.zero();
      const b = i < o.coeffs.length ? o.coeffs[i] : Rational.zero();
      out.push(a.add(b));
    }
    return new Poly(out);
  }

  neg() { return new Poly(this.coeffs.map((c) => c.neg())); }
  sub(o) { return this.add(Poly.from(o).neg()); }

  mul(o) {
    o = Poly.from(o);
    if (this.isZero() || o.isZero()) return Poly.zero();
    const out = new Array(this.coeffs.length + o.coeffs.length - 1).fill(null).map(() => Rational.zero());
    for (let i = 0; i < this.coeffs.length; i++) {
      for (let j = 0; j < o.coeffs.length; j++) {
        out[i + j] = out[i + j].add(this.coeffs[i].mul(o.coeffs[j]));
      }
    }
    return new Poly(out);
  }

  scale(r) {
    r = Rational.from(r);
    return new Poly(this.coeffs.map((c) => c.mul(r)));
  }

  monic() {
    if (this.isZero()) throw new Error('zero polynomial has no monic form');
    return this.scale(Rational.one().div(this.lead()));
  }

  divmod(o) {
    o = Poly.from(o);
    if (o.isZero()) throw new Error('polynomial division by zero');
    const rem = this.coeffs.slice();
    const qLen = this.coeffs.length - o.coeffs.length + 1;
    const quo = new Array(Math.max(qLen, 0)).fill(null).map(() => Rational.zero());
    while (rem.length >= o.coeffs.length && rem.length > 0) {
      const coeff = rem[rem.length - 1].div(o.lead());
      const shift = rem.length - o.coeffs.length;
      quo[shift] = coeff;
      for (let i = 0; i < o.coeffs.length; i++) {
        rem[shift + i] = rem[shift + i].sub(coeff.mul(o.coeffs[i]));
      }
      while (rem.length > 0 && rem[rem.length - 1].isZero()) rem.pop();
    }
    return [new Poly(quo), new Poly(rem)];
  }

  divExact(o) {
    const [q, r] = this.divmod(o);
    if (!r.isZero()) throw new Error('polynomial division is not exact');
    return q;
  }

  gcd(o) {
    let a = this;
    let b = Poly.from(o);
    while (!b.isZero()) {
      const [, r] = a.divmod(b);
      a = b;
      b = r;
    }
    if (a.isZero()) return a;
    return a.scale(Rational.one().div(a.lead()));
  }

  // Yun's square-free factorization: returns [{ poly, multiplicity }] with
  // this = const * prod poly^multiplicity, each poly squarefree, pairwise coprime.
  squareFreeFactors() {
    if (this.isZero() || this.isConstant()) {
      return this.isZero() ? [] : [{ poly: this.monic(), multiplicity: 1 }];
    }
    const f = this.scale(Rational.one().div(this.lead()));
    const fp = f.derivative();
    const R = f.gcd(fp);
    let B = f.divExact(R);
    let C = fp.divExact(R);
    let D = C.sub(B.derivative());
    const factors = [];
    let multiplicity = 1;
    while (!D.isZero()) {
      const A = B.gcd(D);
      if (A.degree() >= 1) factors.push({ poly: A, multiplicity });
      B = B.divExact(A);
      C = D.divExact(A);
      D = C.sub(B.derivative());
      multiplicity++;
    }
    if (B.degree() >= 1) factors.push({ poly: B, multiplicity });
    return factors;
  }

  // Squarefree polynomial whose roots are exactly the odd-multiplicity roots of this.
  oddPart() {
    let result = Poly.one();
    for (const { poly, multiplicity } of this.squareFreeFactors()) {
      if (multiplicity % 2 === 1) result = result.mul(poly);
    }
    return result;
  }

  sturmSequence() {
    const seq = [this, this.derivative()];
    while (!seq[seq.length - 1].isZero()) {
      const [, rem] = seq[seq.length - 2].divmod(seq[seq.length - 1]);
      if (rem.isZero()) break;
      seq.push(rem.neg());
    }
    return seq;
  }

  static signVariations(values) {
    const signs = values.filter((v) => !v.isZero()).map((v) => v.sign());
    let count = 0;
    for (let i = 1; i < signs.length; i++) {
      if (signs[i] !== signs[i - 1]) count++;
    }
    return count;
  }

  // Number of distinct real roots in the OPEN interval (a, b); this must be squarefree.
  countRootsOpen(a, b) {
    if (this.isZero() || this.isConstant()) return 0;
    if (Rational.from(a).cmp(Rational.from(b)) >= 0) return 0;
    const seq = this.sturmSequence();
    const va = Poly.signVariations(seq.map((p) => p.eval(a)));
    const vb = Poly.signVariations(seq.map((p) => p.eval(b)));
    let n = va - vb;
    if (this.eval(b).isZero()) n -= 1;
    return n;
  }

  // Exact decision: does this polynomial take a negative value anywhere on [a, b]?
  hasNegativeOn(a, b) {
    if (this.isZero()) return false;
    const va = this.eval(a);
    const vb = this.eval(b);
    if (va.sign() < 0 || vb.sign() < 0) return true;
    if (va.isZero()) {
      // v(t) = (t-a)^m q(t), q(a) != 0; for t > a the sign is sign(q(a)).
      let d = this;
      while (d.eval(a).isZero()) d = d.derivative();
      if (d.eval(a).sign() < 0) return true;
    }
    if (vb.isZero()) {
      // for t < b the sign is (-1)^m * sign(q(b)).
      let d = this;
      let m = 0;
      while (d.eval(b).isZero()) { d = d.derivative(); m++; }
      const leftSign = (m % 2 === 0 ? 1 : -1) * d.eval(b).sign();
      if (leftSign < 0) return true;
    }
    // Interior negativity happens iff there is a sign-changing (odd multiplicity)
    // root strictly inside (a, b).
    const odd = this.oddPart();
    if (odd.degree() < 1) return false;
    return odd.countRootsOpen(a, b) > 0;
  }
}

module.exports = { Poly };
