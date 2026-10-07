import { Fraction } from "./fraction.js";
export type TimeInput = bigint | number;
export type ValueInput = Fraction | bigint | number;
export interface KeyframeInit {
    time: TimeInput;
    value: ValueInput;
}
export declare function toTime(t: TimeInput): bigint;
/**
 * A track of keyframes on integer time with exact rational values.
 *
 * Sampling rules:
 * - before the first keyframe the first value holds, at or after the last
 *   keyframe the last value holds (endpoint clamping);
 * - when several keyframes share one timestamp the last one wins;
 * - between keyframes the value is linearly interpolated with exact
 *   rational arithmetic.
 */
export declare class Track {
    private readonly keys;
    constructor(keyframes: KeyframeInit[]);
    get keyframes(): ReadonlyArray<{
        time: bigint;
        value: Fraction;
    }>;
    valueAt(t: TimeInput): Fraction;
}
