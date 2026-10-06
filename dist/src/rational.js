"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Rat = void 0;
exports.gcdBig = gcdBig;
exports.parseRat = parseRat;
/** Exact rational arithmetic on BigInt. All values are kept reduced with d > 0. */
class Rat {
    n;
    d;
    constructor(n, d) {
        this.n = n;
        this.d = d;
    }
    static of(n, d = 1n) {
        let num = BigInt(n);
        let den = BigInt(d);
        if (den === 0n)
            throw new Error("rational with zero denominator");
        if (den < 0n) {
            num = -num;
            den = -den;
        }
        const g = gcdBig(num < 0n ? -num : num, den);
        return new Rat(num / g, den / g);
    }
    static zero() {
        return Rat.of(0n);
    }
    static one() {
        return Rat.of(1n);
    }
    isZero() {
        return this.n === 0n;
    }
    sign() {
        return this.n > 0n ? 1 : this.n < 0n ? -1 : 0;
    }
    neg() {
        return Rat.of(-this.n, this.d);
    }
    abs() {
        return this.n < 0n ? this.neg() : this;
    }
    add(o) {
        return Rat.of(this.n * o.d + o.n * this.d, this.d * o.d);
    }
    sub(o) {
        return Rat.of(this.n * o.d - o.n * this.d, this.d * o.d);
    }
    mul(o) {
        return Rat.of(this.n * o.n, this.d * o.d);
    }
    div(o) {
        if (o.n === 0n)
            throw new Error("division by zero rational");
        return Rat.of(this.n * o.d, this.d * o.n);
    }
    cmp(o) {
        const lhs = this.n * o.d;
        const rhs = o.n * this.d;
        return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
    }
    lt(o) {
        return this.cmp(o) < 0;
    }
    lte(o) {
        return this.cmp(o) <= 0;
    }
    eq(o) {
        return this.n === o.n && this.d === o.d;
    }
    toString() {
        return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
    }
    toJSON() {
        return this.toString();
    }
}
exports.Rat = Rat;
function gcdBig(a, b) {
    let x = a < 0n ? -a : a;
    let y = b < 0n ? -b : b;
    while (y !== 0n) {
        const t = x % y;
        x = y;
        y = t;
    }
    return x === 0n ? 1n : x;
}
/** Parse a rational from JSON input: integer number, "p", "p/q", decimal string, or [p, q]. */
function parseRat(v) {
    if (typeof v === "number") {
        if (!Number.isFinite(v))
            throw new Error(`invalid number: ${v}`);
        return parseRat(v.toString());
    }
    if (typeof v === "string") {
        const s = v.trim();
        if (/^[+-]?\d+$/.test(s))
            return Rat.of(BigInt(s));
        const frac = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(s);
        if (frac)
            return Rat.of(BigInt(frac[1]), BigInt(frac[2]));
        const dec = /^([+-]?)(\d*)\.(\d+)$/.exec(s);
        if (dec) {
            const scale = 10n ** BigInt(dec[3].length);
            const intPart = dec[2] === "" ? 0n : BigInt(dec[2]);
            const num = intPart * scale + BigInt(dec[3]);
            return Rat.of(dec[1] === "-" ? -num : num, scale);
        }
        throw new Error(`cannot parse rational: ${v}`);
    }
    if (Array.isArray(v) && v.length === 2) {
        return Rat.of(BigInt(v[0]), BigInt(v[1]));
    }
    throw new Error(`cannot parse rational from: ${JSON.stringify(v)}`);
}
