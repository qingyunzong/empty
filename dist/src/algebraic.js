"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlgNum = void 0;
const rational_1 = require("./rational");
/** An algebraic number of the form  rat + coeff * sqrt(radicand),
 *  where rat, coeff, radicand are rational and radicand > 0.
 *  coeff = 0 encodes a plain rational (radicand is then irrelevant, kept 1). */
class AlgNum {
    rat;
    coeff;
    radicand;
    constructor(rat, coeff, radicand) {
        this.rat = rat;
        this.coeff = coeff;
        this.radicand = radicand;
    }
    static rational(r) {
        return new AlgNum(r, rational_1.Rat.ZERO, rational_1.Rat.ONE);
    }
    /** value = rat + coeff * sqrt(radicand); requires radicand > 0. */
    static of(rat, coeff, radicand) {
        if (radicand.sign() <= 0)
            throw new Error("radicand must be positive");
        if (coeff.isZero())
            return AlgNum.rational(rat);
        return new AlgNum(rat, coeff, radicand);
    }
    isRational() { return this.coeff.isZero(); }
    /** Affine map: t -> k * t + c with rational k, c. */
    affine(k, c) {
        if (k.isZero())
            return AlgNum.rational(c);
        return AlgNum.of(this.rat.mul(k).add(c), this.coeff.mul(k), this.radicand);
    }
    /** Approximate value (for display only; all logic is exact). */
    approx() {
        return this.rat.toNumber() + this.coeff.toNumber() * Math.sqrt(this.radicand.toNumber());
    }
    toString() {
        if (this.coeff.isZero())
            return this.rat.toString();
        const absC = this.coeff.abs();
        const c = absC.eq(rational_1.Rat.ONE) ? "" : `${absC}*`;
        const sign = this.coeff.sign() < 0 ? "-" : "+";
        if (this.rat.isZero()) {
            return `${this.coeff.sign() < 0 ? "-" : ""}${c}sqrt(${this.radicand})`;
        }
        return `${this.rat} ${sign} ${c}sqrt(${this.radicand})`;
    }
}
exports.AlgNum = AlgNum;
