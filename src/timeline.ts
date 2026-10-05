import { Rational, cmp, div, rat, sub, toNumber } from "./rational.js";
import { Easing, linear } from "./easing.js";

export interface Keyframe {
  readonly time: Rational;
  readonly value: number;
  /** Easing of the segment that starts at this keyframe (default: linear). */
  readonly easing?: Easing;
}

/**
 * A piecewise-interpolated value track over exact rational keyframe times.
 *
 * Evaluation is a pure function of time:
 *  - t before the first key yields the first key's value;
 *  - t at/after the last key yields the last key's value;
 *  - inside segment i, u = (t - t_i) / (t_{i+1} - t_i) is computed exactly
 *    as a rational, then eased and linearly blended between the two values.
 * At a keyframe time the key's own value is returned exactly (the segment
 * to the right owns its left endpoint), so results never depend on which
 * side the time was approached from.
 */
export class Track {
  readonly keys: readonly Keyframe[];

  constructor(keys: Keyframe[]) {
    if (keys.length === 0) throw new RangeError("track needs at least one keyframe");
    const sorted = [...keys].sort((a, b) => cmp(a.time, b.time));
    for (let i = 1; i < sorted.length; i++) {
      if (cmp(sorted[i - 1]!.time, sorted[i]!.time) === 0) {
        throw new RangeError("duplicate keyframe time");
      }
    }
    this.keys = sorted;
  }

  /** Time of the last keyframe; the natural duration of the track. */
  get duration(): Rational {
    return this.keys[this.keys.length - 1]!.time;
  }

  evaluate(t: Rational): number {
    const keys = this.keys;
    const first = keys[0]!;
    const last = keys[keys.length - 1]!;
    if (cmp(t, first.time) <= 0) return first.value;
    if (cmp(t, last.time) >= 0) return last.value;
    // Binary search: keys[i].time <= t < keys[i+1].time
    let lo = 0;
    let hi = keys.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cmp(keys[mid]!.time, t) <= 0) lo = mid;
      else hi = mid;
    }
    const a = keys[lo]!;
    const b = keys[hi]!;
    const u = toNumber(div(sub(t, a.time), sub(b.time, a.time)));
    const eased = (a.easing ?? linear)(u);
    return a.value + (b.value - a.value) * eased;
  }
}

export const keyframe = (
  n: bigint | number,
  d: bigint | number,
  value: number,
  easing?: Easing,
): Keyframe => ({ time: rat(n, d), value, ...(easing ? { easing } : {}) });
