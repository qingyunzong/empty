import { Rational } from "./rational.js";
export interface TempoSegment {
    /** First tick (inclusive) covered by this segment. */
    readonly tick: number;
    /** Microseconds per tick for this segment, as an exact rational. */
    readonly usPerTick: Rational;
}
/**
 * Piecewise-constant tempo map over integer ticks.
 *
 * Each segment carries a rational microseconds-per-tick rate. The time of a
 * tick is the exact rational integral of the rate over [0, tick); conversion
 * to integer microseconds applies a single round-half-even at the very end,
 * never per segment.
 *
 * The map only defines the tick -> time conversion; it never rewrites tick
 * values, so editing segments cannot move events (which store plain ticks).
 */
export declare class TempoMap {
    private segs;
    constructor(initialUsPerTick: Rational);
    /** Insert a segment starting at `tick`, or replace the one already there. */
    setTempo(tick: number, usPerTick: Rational): void;
    /** Remove the segment starting at `tick` (the tick-0 segment cannot go). */
    removeTempo(tick: number): boolean;
    get segments(): readonly TempoSegment[];
    /** Exact accumulated time of `tick` as a rational number of microseconds. */
    tickToRational(tick: number): Rational;
    /** Microsecond time of `tick`: exact integral, rounded half-to-even once. */
    tickToUs(tick: number): bigint;
    /**
     * Reverse lookup: the earliest tick whose (rounded) microsecond time is
     * greater than or equal to `us`. Rates are strictly positive, so rounded
     * time is non-decreasing in tick and binary search is exact.
     */
    usToTick(us: bigint | number): number;
}
