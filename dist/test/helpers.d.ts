import type { Recipient } from "../src/split.js";
/** Deterministic PRNG so test runs are reproducible. */
export declare function mulberry32(seed: number): () => number;
export declare function randInt(rng: () => number, lo: number, hi: number): number;
export interface EnumRecipient {
    id: number;
    w: number;
    min: number;
    max: number;
}
export declare function toRecipients(rs: EnumRecipient[]): Recipient[];
/** Exact squared-deviation cost (integer math; matches src/split.ts scaling). */
export declare function costOf(rs: EnumRecipient[], total: number, x: number[]): bigint;
/**
 * Full enumeration of every allocation within bounds summing to `total`;
 * returns the minimum exact squared-deviation cost, or null if infeasible.
 */
export declare function bruteForceMinCost(rs: EnumRecipient[], total: number): bigint | null;
/**
 * Meet-in-the-middle full enumeration: exact minimum cost over ALL
 * allocations, feasible for 8 recipients and total 100.  The objective is
 * separable per recipient, so each half only needs the best cost per
 * partial sum.
 */
export declare function bruteForceMinCostMITM(rs: EnumRecipient[], total: number): bigint | null;
