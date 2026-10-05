/**
 * Core split: divide an integer `total` into integer shares, one per
 * recipient, proportionally to rational weights and subject to per-recipient
 * [min, max] bounds.
 *
 * Objective (exact): minimize the sum of squared deviations from the ideal
 * rational shares  q_i = total * w_i / W.  Ties are broken by recipient ID
 * (ascending).  The implementation is a unit-greedy marginal-cost allocator,
 * which for this separable strictly-convex objective is exact and behaves as
 * "largest remainder first; saturated recipients exit; equal remainders go
 * to the smaller ID".
 */
export type Weight = number | bigint | {
    num: number | bigint;
    den: number | bigint;
};
export interface Recipient {
    id: string | number;
    weight: Weight;
    min?: number;
    max?: number;
}
export interface AllocationEntry {
    id: string | number;
    amount: number;
}
export declare class InfeasibleError extends Error {
    constructor(message: string);
}
export declare function compareIds(a: string | number, b: string | number): number;
/**
 * Exact squared-deviation cost of an allocation, scaled by W^2 (a common
 * positive factor), so comparisons are exact integer comparisons.
 * When all weights are zero the ideal share is defined as 0 for everyone.
 */
export declare function squaredDeviation(total: number, recipients: Recipient[], allocation: ReadonlyMap<string | number, number> | AllocationEntry[]): bigint;
/** Split `total`; returns entries sorted by recipient ID. */
export declare function splitDetailed(total: number, recipients: Recipient[]): AllocationEntry[];
/** Split `total`; returns a Map from recipient ID to integer share. */
export declare function split(total: number, recipients: Recipient[]): Map<string | number, number>;
