"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Fraction = void 0;
const bigAbs = (x) => (x < 0n ? -x : x);
function bigGcd(a, b) {
    a = bigAbs(a);
    b = bigAbs(b);
    while (b !== 0n) {
        const t = a % b;
        a = b;
        b = t;
    }
    return a === 0n ? 1n : a;
}
/** Exact rational number backed by bigint numerator/denominator, always normalized. */
class Fraction {
    num;
    den; // invariant: den > 0, gcd(|num|, den) = 1
    constructor(num, den) {
        if (den === 0n)
            throw new Error("Fraction: denominator is zero");
        if (den < 0n) {
            num = -num;
            den = -den;
        }
        const g = bigGcd(num, den);
        this.num = num / g;
        this.den = den / g;
    }
    static of(num, den = 1) {
        return new Fraction(BigInt(num), BigInt(den));
    }
    /** Accepts "3/4", "-7/2", "1.5", "120", "0.333". */
    static parse(text) {
        const t = text.trim();
        if (t.includes("/")) {
            const parts = t.split("/");
            if (parts.length !== 2)
                throw new Error(`Fraction: bad input "${text}"`);
            return new Fraction(BigInt(parts[0].trim()), BigInt(parts[1].trim()));
        }
        if (t.includes(".")) {
            const neg = t.startsWith("-");
            const body = neg ? t.slice(1) : t;
            const parts = body.split(".");
            if (parts.length !== 2)
                throw new Error(`Fraction: bad input "${text}"`);
            const scale = 10n ** BigInt(parts[1].length);
            const num = BigInt(parts[0] || "0") * scale + BigInt(parts[1]);
            return new Fraction(neg ? -num : num, scale);
        }
        return new Fraction(BigInt(t), 1n);
    }
    static from(value) {
        if (value instanceof Fraction)
            return value;
        if (typeof value === "string")
            return Fraction.parse(value);
        if (typeof value === "bigint")
            return new Fraction(value, 1n);
        if (!Number.isFinite(value))
            throw new Error("Fraction: non-finite number");
        if (Number.isInteger(value))
            return new Fraction(BigInt(value), 1n);
        return Fraction.parse(String(value));
    }
    static get ZERO() {
        return Fraction.of(0);
    }
    add(o) {
        return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
    }
    sub(o) {
        return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den);
    }
    mul(o) {
        return new Fraction(this.num * o.num, this.den * o.den);
    }
    div(o) {
        if (o.num === 0n)
            throw new Error("Fraction: division by zero");
        return new Fraction(this.num * o.den, this.den * o.num);
    }
    neg() {
        return new Fraction(-this.num, this.den);
    }
    cmp(o) {
        const d = this.num * o.den - o.num * this.den;
        return d < 0n ? -1 : d > 0n ? 1 : 0;
    }
    eq(o) {
        return this.num === o.num && this.den === o.den;
    }
    lt(o) {
        return this.cmp(o) < 0;
    }
    lte(o) {
        return this.cmp(o) <= 0;
    }
    gt(o) {
        return this.cmp(o) > 0;
    }
    gte(o) {
        return this.cmp(o) >= 0;
    }
    sign() {
        return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
    }
    toNumber() {
        return Number(this.num) / Number(this.den);
    }
    toString() {
        return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
    }
}
exports.Fraction = Fraction;
