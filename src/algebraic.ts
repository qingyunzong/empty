import { Rat } from "./rational";

/** An algebraic number of the form  rat + coeff * sqrt(radicand),
 *  where rat, coeff, radicand are rational and radicand > 0.
 *  coeff = 0 encodes a plain rational (radicand is then irrelevant, kept 1). */
export class AlgNum {
  readonly rat: Rat;
  readonly coeff: Rat;
  readonly radicand: Rat;

  private constructor(rat: Rat, coeff: Rat, radicand: Rat) {
    this.rat = rat;
    this.coeff = coeff;
    this.radicand = radicand;
  }

  static rational(r: Rat): AlgNum {
    return new AlgNum(r, Rat.ZERO, Rat.ONE);
  }

  /** value = rat + coeff * sqrt(radicand); requires radicand > 0. */
  static of(rat: Rat, coeff: Rat, radicand: Rat): AlgNum {
    if (radicand.sign() <= 0) throw new Error("radicand must be positive");
    if (coeff.isZero()) return AlgNum.rational(rat);
    return new AlgNum(rat, coeff, radicand);
  }

  isRational(): boolean { return this.coeff.isZero(); }

  /** Affine map: t -> k * t + c with rational k, c. */
  affine(k: Rat, c: Rat): AlgNum {
    if (k.isZero()) return AlgNum.rational(c);
    return AlgNum.of(this.rat.mul(k).add(c), this.coeff.mul(k), this.radicand);
  }

  /** Approximate value (for display only; all logic is exact). */
  approx(): number {
    return this.rat.toNumber() + this.coeff.toNumber() * Math.sqrt(this.radicand.toNumber());
  }

  toString(): string {
    if (this.coeff.isZero()) return this.rat.toString();
    const absC = this.coeff.abs();
    const c = absC.eq(Rat.ONE) ? "" : `${absC}*`;
    const sign = this.coeff.sign() < 0 ? "-" : "+";
    if (this.rat.isZero()) {
      return `${this.coeff.sign() < 0 ? "-" : ""}${c}sqrt(${this.radicand})`;
    }
    return `${this.rat} ${sign} ${c}sqrt(${this.radicand})`;
  }
}
