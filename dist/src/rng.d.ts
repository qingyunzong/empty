/**
 * Serializable seeded PRNG (xoshiro128** over a 4x32-bit state).
 * The whole generator state is four uint32 numbers, so a seed or a
 * mid-stream snapshot round-trips through JSON losslessly.
 */
export type Seed = number;
export interface RngSnapshot {
    s: [number, number, number, number];
}
export declare class Rng {
    private state;
    constructor(seed: Seed);
    static fromSnapshot(snap: RngSnapshot): Rng;
    snapshot(): RngSnapshot;
    clone(): Rng;
    nextU32(): number;
    /** Uniform integer in [minInclusive, maxInclusive]. */
    nextInt(minInclusive: number, maxInclusive: number): number;
    nextBool(): boolean;
    /** Derive an independent child stream (used per generated case). */
    fork(): Rng;
}
/** Deterministically derive the RNG for generated case #runIndex of a check. */
export declare function caseRng(seed: Seed, runIndex: number): Rng;
