/**
 * Exact rational number backed by BigInt, always stored normalized:
 * denominator > 0 and gcd(|num|, den) = 1.
 */
export class Rational {
    num;
    den;
    constructor(num, den) {
        this.num = num;
        this.den = den;
    }
    static of(num, den = 1n) {
        let n = BigInt(num);
        let d = BigInt(den);
        if (d === 0n)
            throw new RangeError("Rational: denominator must not be zero");
        if (d < 0n) {
            n = -n;
            d = -d;
        }
        const g = gcd(n < 0n ? -n : n, d);
        return new Rational(n / g, d / g);
    }
    static zero() {
        return new Rational(0n, 1n);
    }
    isZero() {
        return this.num === 0n;
    }
    isPositive() {
        return this.num > 0n;
    }
    add(other) {
        return Rational.of(this.num * other.den + other.num * this.den, this.den * other.den);
    }
    sub(other) {
        return Rational.of(this.num * other.den - other.num * this.den, this.den * other.den);
    }
    mul(other) {
        return Rational.of(this.num * other.num, this.den * other.den);
    }
    /** -1, 0 or 1 */
    cmp(other) {
        const lhs = this.num * other.den;
        const rhs = other.num * this.den;
        return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
    }
    equals(other) {
        return this.num === other.num && this.den === other.den;
    }
    /**
     * Round to the nearest integer; exact halves go to the even neighbor
     * (IEEE 754 "round half to even" / banker's rounding).
     */
    roundHalfEven() {
        const q = this.den;
        let floor = this.num / q;
        let rem = this.num % q;
        if (rem < 0n) {
            floor -= 1n;
            rem += q;
        }
        const twice = 2n * rem;
        if (twice < q)
            return floor;
        if (twice > q)
            return floor + 1n;
        return floor % 2n === 0n ? floor : floor + 1n;
    }
    toString() {
        return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
    }
}
function gcd(a, b) {
    while (b !== 0n) {
        const t = a % b;
        a = b;
        b = t;
    }
    return a === 0n ? 1n : a;
}
