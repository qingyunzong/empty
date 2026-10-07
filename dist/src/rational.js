"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Rat = void 0;
exports.gcd = gcd;
/** Exact rational arithmetic on BigInt. Rationals are always normalized:
 *  den > 0, gcd(|num|, den) = 1, zero is 0/1. */
class Rat {
    num;
    den;
    constructor(num, den) {
        this.num = num;
        this.den = den;
    }
    static ZERO = new Rat(0n, 1n);
    static ONE = new Rat(1n, 1n);
    static of(num, den = 1n) {
        let n = BigInt(num);
        let d = BigInt(den);
        if (d === 0n)
            throw new Error("rational with zero denominator");
        if (d < 0n) {
            n = -n;
            d = -d;
        }
        if (n === 0n)
            return Rat.ZERO;
        const g = gcd(n < 0n ? -n : n, d);
        return new Rat(n / g, d / g);
    }
    /** Parse "a", "a/b", "-3/4" etc. */
    static parse(s) {
        const t = s.trim();
        const slash = t.indexOf("/");
        if (slash < 0)
            return Rat.of(BigInt(t));
        return Rat.of(BigInt(t.slice(0, slash)), BigInt(t.slice(slash + 1)));
    }
    add(o) { return Rat.of(this.num * o.den + o.num * this.den, this.den * o.den); }
    sub(o) { return Rat.of(this.num * o.den - o.num * this.den, this.den * o.den); }
    mul(o) { return Rat.of(this.num * o.num, this.den * o.den); }
    div(o) {
        if (o.num === 0n)
            throw new Error("division by zero rational");
        return Rat.of(this.num * o.den, this.den * o.num);
    }
    neg() { return Rat.of(-this.num, this.den); }
    abs() { return this.num < 0n ? this.neg() : this; }
    inv() {
        if (this.num === 0n)
            throw new Error("inverse of zero");
        return Rat.of(this.den, this.num);
    }
    isZero() { return this.num === 0n; }
    /** -1, 0, 1 */
    sign() { return this.num < 0n ? -1 : this.num > 0n ? 1 : 0; }
    cmp(o) {
        const d = this.num * o.den - o.num * this.den;
        return d < 0n ? -1 : d > 0n ? 1 : 0;
    }
    lt(o) { return this.cmp(o) < 0; }
    le(o) { return this.cmp(o) <= 0; }
    gt(o) { return this.cmp(o) > 0; }
    ge(o) { return this.cmp(o) >= 0; }
    eq(o) { return this.num === o.num && this.den === o.den; }
    toString() {
        return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
    }
    toNumber() { return Number(this.num) / Number(this.den); }
}
exports.Rat = Rat;
function gcd(a, b) {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b !== 0n) {
        const t = a % b;
        a = b;
        b = t;
    }
    return a === 0n ? 1n : a;
}
