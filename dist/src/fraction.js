/** Exact rational number backed by BigInt, always kept in lowest terms. */
export class Fraction {
    num;
    /** Denominator, always strictly positive. */
    den;
    constructor(num, den) {
        this.num = num;
        this.den = den;
    }
    static ZERO = new Fraction(0n, 1n);
    static ONE = new Fraction(1n, 1n);
    static of(num, den = 1) {
        if (typeof num === "number" && !Number.isInteger(num)) {
            throw new TypeError("numerator must be an integer");
        }
        if (typeof den === "number" && !Number.isInteger(den)) {
            throw new TypeError("denominator must be an integer");
        }
        let n = BigInt(num);
        let d = BigInt(den);
        if (d === 0n)
            throw new RangeError("fraction with zero denominator");
        if (d < 0n) {
            n = -n;
            d = -d;
        }
        if (n === 0n)
            return Fraction.ZERO;
        const g = gcd(abs(n), d);
        return new Fraction(n / g, d / g);
    }
    static from(value) {
        return value instanceof Fraction ? value : Fraction.of(value);
    }
    add(other) {
        return Fraction.of(this.num * other.den + other.num * this.den, this.den * other.den);
    }
    sub(other) {
        return Fraction.of(this.num * other.den - other.num * this.den, this.den * other.den);
    }
    mul(other) {
        return Fraction.of(this.num * other.num, this.den * other.den);
    }
    div(other) {
        if (other.num === 0n)
            throw new RangeError("division by zero fraction");
        return Fraction.of(this.num * other.den, this.den * other.num);
    }
    neg() {
        return Fraction.of(-this.num, this.den);
    }
    /** Exact linear interpolation: this + (other - this) * t. */
    lerp(other, t) {
        return this.add(other.sub(this).mul(t));
    }
    cmp(other) {
        const d = this.num * other.den - other.num * this.den;
        return d < 0n ? -1 : d > 0n ? 1 : 0;
    }
    equals(other) {
        return this.num === other.num && this.den === other.den;
    }
    toString() {
        return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
    }
}
function abs(x) {
    return x < 0n ? -x : x;
}
function gcd(a, b) {
    let x = a;
    let y = b;
    while (y !== 0n) {
        const r = x % y;
        x = y;
        y = r;
    }
    return x === 0n ? 1n : x;
}
