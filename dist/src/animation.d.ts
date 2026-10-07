import { Fraction } from "./fraction.js";
import { type LoopRegion } from "./loop.js";
import { Track, type TimeInput } from "./track.js";
export type LoopMode = "none" | "loop" | "reverse";
export interface AnimationOptions {
    mode?: LoopMode;
    /** Required when mode is "loop" or "reverse". */
    region?: LoopRegion;
}
/** A track sampled through an optional looping time mapping. */
export declare class Animation {
    readonly track: Track;
    readonly mode: LoopMode;
    readonly region?: {
        start: bigint;
        end: bigint;
    };
    constructor(track: Track, options?: AnimationOptions);
    /** Maps integer time through the loop mode, then samples the track. */
    valueAt(t: TimeInput): Fraction;
}
