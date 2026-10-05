/**
 * Exact rational arithmetic on BigInt. No floating point anywhere:
 * every comparison is an exact sign test on a normalized fraction.
 */
function gcd(a, b) {
    let x = a < 0n ? -a : a;
    let y = b < 0n ? -b : b;
    while (y !== 0n) {
        const t = x % y;
        x = y;
        y = t;
    }
    return x === 0n ? 1n : x;
}
export class Frac {
    num;
    den; // invariant: den > 0, gcd(|num|, den) = 1
    constructor(num, den) {
        this.num = num;
        this.den = den;
    }
    static ZERO = new Frac(0n, 1n);
    static ONE = new Frac(1n, 1n);
    static make(num, den) {
        if (den === 0n)
            throw new Error('Frac: zero denominator');
        if (num === 0n)
            return Frac.ZERO;
        let n = num;
        let d = den;
        if (d < 0n) {
            n = -n;
            d = -d;
        }
        const g = gcd(n, d);
        return new Frac(n / g, d / g);
    }
    static from(value) {
        if (value instanceof Frac)
            return value;
        if (typeof value === 'bigint')
            return Frac.make(value, 1n);
        if (typeof value === 'number') {
            if (!Number.isSafeInteger(value)) {
                throw new Error(`Frac.from: number ${value} is not a safe integer; ` +
                    'pass integers, "p/q" or decimal strings to stay exact');
            }
            return Frac.make(BigInt(value), 1n);
        }
        return Frac.parse(value);
    }
    /** Accepts "p/q", integers, and finite decimals like "-12.75". */
    static parse(text) {
        const s = text.trim();
        const fracMatch = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(s);
        if (fracMatch) {
            return Frac.make(BigInt(fracMatch[1]), BigInt(fracMatch[2]));
        }
        const decMatch = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(s);
        if (decMatch && (decMatch[2] !== '' || decMatch[3] !== undefined)) {
            const intPart = decMatch[2] === '' ? '0' : decMatch[2];
            const fracPart = decMatch[3] ?? '';
            const digits = intPart + fracPart;
            const scale = 10n ** BigInt(fracPart.length);
            const value = Frac.make(BigInt(digits), scale);
            return decMatch[1] === '-' ? value.neg() : value;
        }
        throw new Error(`Frac.parse: cannot parse ${JSON.stringify(text)}`);
    }
    add(other) {
        const o = Frac.from(other);
        return Frac.make(this.num * o.den + o.num * this.den, this.den * o.den);
    }
    sub(other) {
        const o = Frac.from(other);
        return Frac.make(this.num * o.den - o.num * this.den, this.den * o.den);
    }
    mul(other) {
        const o = Frac.from(other);
        return Frac.make(this.num * o.num, this.den * o.den);
    }
    div(other) {
        const o = Frac.from(other);
        if (o.num === 0n)
            throw new Error('Frac.div: division by zero');
        return Frac.make(this.num * o.den, this.den * o.num);
    }
    neg() {
        return Frac.make(-this.num, this.den);
    }
    abs() {
        return this.num < 0n ? this.neg() : this;
    }
    /** Exact comparison: returns -1, 0 or 1. */
    cmp(other) {
        const o = Frac.from(other);
        const diff = this.num * o.den - o.num * this.den;
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    }
    equals(other) {
        const o = Frac.from(other);
        return this.num === o.num && this.den === o.den;
    }
    isZero() {
        return this.num === 0n;
    }
    /** Exact sign: -1, 0 or 1. This replaces any floating-point tolerance. */
    sign() {
        return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
    }
    toString() {
        return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
    }
}
export function frac(value) {
    return Frac.from(value);
}
export function fracArray(values) {
    return values.map((v) => Frac.from(v));
}
