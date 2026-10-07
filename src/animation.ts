import { Fraction } from "./fraction.js";
import { loopTime, reverseLoopTime, type LoopRegion } from "./loop.js";
import { Track, toTime, type TimeInput } from "./track.js";

export type LoopMode = "none" | "loop" | "reverse";

export interface AnimationOptions {
  mode?: LoopMode;
  /** Required when mode is "loop" or "reverse". */
  region?: LoopRegion;
}

/** A track sampled through an optional looping time mapping. */
export class Animation {
  readonly track: Track;
  readonly mode: LoopMode;
  readonly region?: { start: bigint; end: bigint };

  constructor(track: Track, options: AnimationOptions = {}) {
    this.track = track;
    this.mode = options.mode ?? "none";
    if (this.mode !== "none") {
      if (!options.region) throw new TypeError("looping animation needs a region");
      const start = toTime(options.region.start);
      const end = toTime(options.region.end);
      if (end <= start) throw new RangeError("loop end must be greater than loop start");
      this.region = { start, end };
    }
  }

  /** Maps integer time through the loop mode, then samples the track. */
  valueAt(t: TimeInput): Fraction {
    const time = toTime(t);
    if (this.mode === "loop") return this.track.valueAt(loopTime(time, this.region!));
    if (this.mode === "reverse") return this.track.valueAt(reverseLoopTime(time, this.region!));
    return this.track.valueAt(time);
  }
}
