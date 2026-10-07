import { Rational } from "./rational.js";
import { Timeline } from "./timeline.js";

/**
 * Loop modes:
 * - "none":    sample the timeline directly (endpoints clamp);
 * - "repeat":  loop over [start, end); the interval end maps back to start;
 * - "reverse": ping-pong over [start, end] then back, period 2 * duration,
 *              turning points hit the endpoint values exactly once each.
 */
export type LoopMode = "none" | "repeat" | "reverse";

const floorMod = (value: bigint, modulus: bigint): bigint => {
  const r = value % modulus;
  return r < 0n ? r + modulus : r;
};

export function sampleLooped(timeline: Timeline, t: bigint, mode: LoopMode): Rational {
  const duration = timeline.duration;
  if (mode === "none" || duration === 0n) {
    return timeline.sampleAt(t);
  }
  const start = timeline.start;
  if (mode === "repeat") {
    return timeline.sampleAt(start + floorMod(t - start, duration));
  }
  const period = 2n * duration;
  const phase = floorMod(t - start, period);
  const offset = phase <= duration ? phase : period - phase;
  return timeline.sampleAt(start + offset);
}
