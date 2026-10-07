import { Rational } from "./rational.js";

export interface Keyframe {
  /** Integer timestamp. */
  readonly time: bigint;
  readonly value: Rational;
}

export const keyframe = (time: bigint | number, value: Rational): Keyframe => ({
  time: BigInt(time),
  value,
});

/**
 * Sorted integer-time keyframes with exact rational linear interpolation.
 *
 * Normalization rules:
 * - frames are sorted by time;
 * - when several frames share one timestamp, the last one declared wins;
 * - sampling before the first frame holds the first value, sampling after
 *   the last frame holds the last value.
 */
export class Timeline {
  readonly frames: readonly Keyframe[];

  constructor(frames: readonly Keyframe[]) {
    if (frames.length === 0) {
      throw new RangeError("timeline needs at least one keyframe");
    }
    const sorted = [...frames].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const byTime = new Map<bigint, Keyframe>();
    for (const frame of sorted) {
      byTime.set(frame.time, frame);
    }
    this.frames = [...byTime.values()].sort((a, b) =>
      a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
    );
  }

  get start(): bigint {
    return this.frames[0]!.time;
  }

  get end(): bigint {
    return this.frames[this.frames.length - 1]!.time;
  }

  /** Loop interval length: end - start. Zero for a single instant. */
  get duration(): bigint {
    return this.end - this.start;
  }

  /** Exact value at integer time t, clamped to the endpoint values outside. */
  sampleAt(t: bigint): Rational {
    const frames = this.frames;
    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    if (t <= first.time) {
      return first.value;
    }
    if (t >= last.time) {
      return last.value;
    }
    let lo = 0;
    let hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid]!.time <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const a = frames[lo]!;
    const b = frames[hi]!;
    const ratio = Rational.of(t - a.time, b.time - a.time);
    return a.value.add(b.value.sub(a.value).mul(ratio));
  }
}
