/**
 * Independent rational reference used to verify the library.
 * Deliberately written as a separate, naive implementation: fractions are
 * plain {n, d} pairs and time is accumulated tick by tick instead of per
 * segment, so the tests cross-check two different computation paths.
 */
export interface RefFrac {
    n: bigint;
    d: bigint;
}
export interface RefSegment {
    tick: number;
    num: bigint;
    den: bigint;
}
export declare function refAdd(a: RefFrac, b: RefFrac): RefFrac;
export declare function refRoundHalfEven(f: RefFrac): bigint;
/** Exact time of `tick`, accumulated one tick at a time. */
export declare function refExactTime(segs: readonly RefSegment[], tick: number): RefFrac;
export declare function refTickToUs(segs: readonly RefSegment[], tick: number): bigint;
/** Deterministic PRNG (mulberry32) for reproducible property tests. */
export declare function mulberry32(seed: number): () => number;
