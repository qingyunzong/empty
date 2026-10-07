/** Exact rational number backed by BigInt, always kept in lowest terms. */
export declare class Fraction {
    readonly num: bigint;
    /** Denominator, always strictly positive. */
    readonly den: bigint;
    private constructor();
    static readonly ZERO: Fraction;
    static readonly ONE: Fraction;
    static of(num: bigint | number, den?: bigint | number): Fraction;
    static from(value: Fraction | bigint | number): Fraction;
    add(other: Fraction): Fraction;
    sub(other: Fraction): Fraction;
    mul(other: Fraction): Fraction;
    div(other: Fraction): Fraction;
    neg(): Fraction;
    /** Exact linear interpolation: this + (other - this) * t. */
    lerp(other: Fraction, t: Fraction): Fraction;
    cmp(other: Fraction): number;
    equals(other: Fraction): boolean;
    toString(): string;
}
