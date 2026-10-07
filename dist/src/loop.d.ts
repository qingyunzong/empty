import { type TimeInput } from "./track.js";
export interface LoopRegion {
    start: TimeInput;
    /** Exclusive end for "loop", inclusive turning point for "reverse". */
    end: TimeInput;
}
/**
 * Forward loop over [start, end): time wraps around and the interval end
 * maps back to the start, so sampling is continuous across the boundary.
 */
export declare function loopTime(t: TimeInput, region: LoopRegion): bigint;
/**
 * Reverse (ping-pong) loop, defined separately from the forward loop:
 * time runs start -> end -> start with period 2 * (end - start), touching
 * both endpoints exactly once per turn.
 */
export declare function reverseLoopTime(t: TimeInput, region: LoopRegion): bigint;
