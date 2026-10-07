import { Clock } from "./clock.js";
import { LoopMode, sampleLooped } from "./loop.js";
import { Rational } from "./rational.js";
import { Timeline } from "./timeline.js";

/** Binds a timeline, a logical clock and a loop mode into a sampled value. */
export class Animation {
  constructor(
    readonly timeline: Timeline,
    readonly clock: Clock = new Clock(),
    readonly mode: LoopMode = "none",
  ) {}

  get time(): bigint {
    return this.clock.time;
  }

  get value(): Rational {
    return sampleLooped(this.timeline, this.clock.time, this.mode);
  }
}
