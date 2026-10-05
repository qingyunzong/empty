import {
  Rational,
  ZERO,
  add,
  clamp,
  cmp,
  floorDiv,
  mod,
  scale,
  sub,
} from "./rational.js";

export type PlayMode = "once" | "loop" | "pingpong";

export interface MappedTime {
  /** Local timeline time, always within [0, duration]. */
  readonly local: Rational;
  /** Index of the loop/pingpong cycle containing t (0-based, can be negative). */
  readonly cycle: bigint;
  /**
   * Direction of travel through the timeline at t:
   *  +1 forward, -1 backward (pingpong return leg), 0 when clamped (once).
   */
  readonly direction: 1 | 0 | -1;
}

/**
 * Map a global rational time to a local timeline time. Pure and total —
 * defined for every rational t, including negative times and times far
 * beyond the duration, so seeking and reverse playback need no special
 * cases.
 *
 * Boundary conventions (duration D):
 *  - "once":     local = clamp(t, 0, D).
 *  - "loop":     local = t mod D, in [0, D). Multiples of D map to 0, i.e.
 *                the end keyframe is only the left-limit as t -> D from
 *                below; each cycle owns its left endpoint.
 *  - "pingpong": period 2D. With m = t mod 2D: local = m for m in [0, D],
 *                local = 2D - m for m in (D, 2D). The peak D and the
 *                trough 0 are each attained at exactly one instant per
 *                period; direction is +1 on [0, D) and -1 on [D, 2D).
 */
export function mapTime(t: Rational, duration: Rational, mode: PlayMode): MappedTime {
  if (cmp(duration, ZERO) <= 0) throw new RangeError("duration must be positive");
  switch (mode) {
    case "once": {
      const local = clamp(t, ZERO, duration);
      const clamped = cmp(local, t) !== 0;
      return { local, cycle: 0n, direction: clamped ? 0 : 1 };
    }
    case "loop": {
      return { local: mod(t, duration), cycle: floorDiv(t, duration), direction: 1 };
    }
    case "pingpong": {
      const period = scale(duration, 2n);
      const m = mod(t, period);
      const forward = cmp(m, duration) < 0;
      return {
        local: forward ? m : sub(period, m),
        cycle: floorDiv(t, period),
        direction: forward ? 1 : -1,
      };
    }
  }
}

/**
 * Global occurrence times of an event at local time `local`, for cycle
 * indices fromCycle..toCycle (inclusive).
 *  - "once":    a single occurrence at `local` (cycle 0).
 *  - "loop":    k*D + e.
 *  - "pingpong": k*2D + e (forward pass) and k*2D + (2D - e) (return pass);
 *               at e = 0 and e = D the two coincide, so only one occurrence
 *               per period is produced.
 */
export function* eventOccurrences(
  local: Rational,
  duration: Rational,
  mode: PlayMode,
  fromCycle: bigint,
  toCycle: bigint,
): Generator<Rational> {
  if (mode === "once") {
    if (fromCycle <= 0n && toCycle >= 0n) yield local;
    return;
  }
  if (mode === "loop") {
    for (let k = fromCycle; k <= toCycle; k++) {
      yield add(local, scale(duration, k));
    }
    return;
  }
  const period = scale(duration, 2n);
  const mirror = sub(period, local);
  for (let k = fromCycle; k <= toCycle; k++) {
    yield add(local, scale(period, k));
    if (cmp(mirror, local) !== 0 && cmp(mirror, period) !== 0) {
      yield add(mirror, scale(period, k));
    }
  }
}

/** Cycle index range that can contain occurrences inside [lo, hi]. */
export function cycleSpan(
  lo: Rational,
  hi: Rational,
  duration: Rational,
  mode: PlayMode,
): { from: bigint; to: bigint } {
  if (mode === "once") return { from: 0n, to: 0n };
  const period = mode === "pingpong" ? scale(duration, 2n) : duration;
  return { from: floorDiv(lo, period), to: floorDiv(hi, period) };
}
