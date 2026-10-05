/**
 * Exact rational arithmetic on BigInt. No floating point anywhere:
 * every comparison is an exact sign test on a normalized fraction.
 */
export type FracInput = Frac | bigint | number | string;
export declare class Frac {
    readonly num: bigint;
    readonly den: bigint;
    private constructor();
    static readonly ZERO: Frac;
    static readonly ONE: Frac;
    static make(num: bigint, den: bigint): Frac;
    static from(value: FracInput): Frac;
    /** Accepts "p/q", integers, and finite decimals like "-12.75". */
    static parse(text: string): Frac;
    add(other: FracInput): Frac;
    sub(other: FracInput): Frac;
    mul(other: FracInput): Frac;
    div(other: FracInput): Frac;
    neg(): Frac;
    abs(): Frac;
    /** Exact comparison: returns -1, 0 or 1. */
    cmp(other: FracInput): number;
    equals(other: FracInput): boolean;
    isZero(): boolean;
    /** Exact sign: -1, 0 or 1. This replaces any floating-point tolerance. */
    sign(): number;
    toString(): string;
}
export declare function frac(value: FracInput): Frac;
export declare function fracArray(values: readonly FracInput[]): Frac[];
