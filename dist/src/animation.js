import { loopTime, reverseLoopTime } from "./loop.js";
import { toTime } from "./track.js";
/** A track sampled through an optional looping time mapping. */
export class Animation {
    track;
    mode;
    region;
    constructor(track, options = {}) {
        this.track = track;
        this.mode = options.mode ?? "none";
        if (this.mode !== "none") {
            if (!options.region)
                throw new TypeError("looping animation needs a region");
            const start = toTime(options.region.start);
            const end = toTime(options.region.end);
            if (end <= start)
                throw new RangeError("loop end must be greater than loop start");
            this.region = { start, end };
        }
    }
    /** Maps integer time through the loop mode, then samples the track. */
    valueAt(t) {
        const time = toTime(t);
        if (this.mode === "loop")
            return this.track.valueAt(loopTime(time, this.region));
        if (this.mode === "reverse")
            return this.track.valueAt(reverseLoopTime(time, this.region));
        return this.track.valueAt(time);
    }
}
