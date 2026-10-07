import { Fraction } from "./fraction.js";

export type TimeInput = bigint | number;
export type ValueInput = Fraction | bigint | number;

export interface KeyframeInit {
  time: TimeInput;
  value: ValueInput;
}

interface Keyframe {
  time: bigint;
  value: Fraction;
}

export function toTime(t: TimeInput): bigint {
  if (typeof t === "number" && !Number.isInteger(t)) {
    throw new TypeError(`time must be an integer, got ${t}`);
  }
  return BigInt(t);
}

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
export class Track {
  private readonly keys: Keyframe[];

  constructor(keyframes: KeyframeInit[]) {
    if (keyframes.length === 0) throw new TypeError("track needs at least one keyframe");
    const keys = keyframes.map((k) => ({ time: toTime(k.time), value: Fraction.from(k.value) }));
    // Stable sort keeps insertion order among equal timestamps, so the
    // "last frame wins" rule is well defined for duplicate times.
    keys.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    this.keys = keys;
  }

  get keyframes(): ReadonlyArray<{ time: bigint; value: Fraction }> {
    return this.keys;
  }

  valueAt(t: TimeInput): Fraction {
    const time = toTime(t);
    const keys = this.keys;
    const first = keys[0]!;
    if (time < first.time) return first.value;

    // Index of the last keyframe with key.time <= time.
    let lo = 0;
    let hi = keys.length; // search in [lo, hi)
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid]!.time <= time) lo = mid;
      else hi = mid;
    }
    const curr = keys[lo]!;
    if (curr.time === time || lo === keys.length - 1) return curr.value;

    const next = keys[lo + 1]!;
    const span = next.time - curr.time;
    const ratio = Fraction.of(time - curr.time, span);
    return curr.value.lerp(next.value, ratio);
  }
}
