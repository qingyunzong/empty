/**
 * Exact rational number backed by BigInt, always stored normalized:
 * denominator > 0 and gcd(|num|, den) = 1.
 */
export declare class Rational {
    readonly num: bigint;
    readonly den: bigint;
    private constructor();
    static of(num: bigint | number, den?: bigint | number): Rational;
    static zero(): Rational;
    isZero(): boolean;
    isPositive(): boolean;
    add(other: Rational): Rational;
    sub(other: Rational): Rational;
    mul(other: Rational): Rational;
    /** -1, 0 or 1 */
    cmp(other: Rational): number;
    equals(other: Rational): boolean;
    /**
     * Round to the nearest integer; exact halves go to the even neighbor
     * (IEEE 754 "round half to even" / banker's rounding).
     */
    roundHalfEven(): bigint;
    toString(): string;
}
