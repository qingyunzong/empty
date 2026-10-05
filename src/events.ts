import { Rational, ZERO, cmp, floorDiv, key, max, min, scale } from "./rational.js";
import { PlayMode, cycleSpan, eventOccurrences } from "./mapping.js";

export interface TimelineEvent {
  readonly name: string;
  /** Local timeline time. Range: [0, D) for "loop", [0, D] otherwise. */
  readonly time: Rational;
}

export interface EventCrossing {
  readonly name: string;
  /** Global time at which the event occurs. */
  readonly at: Rational;
  /** Direction of playhead travel that produced this crossing. */
  readonly direction: "forward" | "backward";
  /** Cycle index of the occurrence. */
  readonly cycle: bigint;
}

export function validateEvents(
  events: readonly TimelineEvent[],
  duration: Rational,
  mode: PlayMode,
): void {
  for (const ev of events) {
    const below = cmp(ev.time, ZERO) < 0;
    const above =
      mode === "loop" ? cmp(ev.time, duration) >= 0 : cmp(ev.time, duration) > 0;
    if (below || above) {
      throw new RangeError(
        `event "${ev.name}" out of range for mode "${mode}"`,
      );
    }
  }
}

/**
 * Events crossed when the playhead moves from t0 to t1.
 *
 * Crossing convention (half-open intervals, so events fire exactly once):
 *  - forward  (t1 > t0): occurrences in (t0, t1];
 *  - backward (t1 < t0): occurrences in [t1, t0).
 * An event exactly at the departure time belongs to the interval just left,
 * an event exactly at the arrival time belongs to the interval just entered.
 * Consecutive moves therefore never double-fire and never skip, and moving
 * a->b then b->a fires each crossed event exactly once per direction.
 *
 * Crossings are returned in traversal order (by occurrence time along the
 * direction of movement; ties broken by event declaration order).
 */
export function crossingsBetween(
  events: readonly TimelineEvent[],
  t0: Rational,
  t1: Rational,
  duration: Rational,
  mode: PlayMode,
): EventCrossing[] {
  const order = cmp(t0, t1);
  if (order === 0 || events.length === 0) return [];
  const forward = order < 0;
  const lo = min(t0, t1);
  const hi = max(t0, t1);
  const { from, to } = cycleSpan(lo, hi, duration, mode);

  const period = mode === "pingpong" ? scale(duration, 2n) : duration;
  const found: Array<{ crossing: EventCrossing; seq: number }> = [];
  events.forEach((ev, seq) => {
    const seen = new Set<string>();
    for (const at of eventOccurrences(ev.time, duration, mode, from, to)) {
      const inInterval = forward
        ? cmp(at, lo) > 0 && cmp(at, hi) <= 0 // (lo, hi]
        : cmp(at, lo) >= 0 && cmp(at, hi) < 0; // [lo, hi)
      if (!inInterval) continue;
      const k = key(at);
      if (seen.has(k)) continue;
      seen.add(k);
      found.push({
        seq,
        crossing: {
          name: ev.name,
          at,
          direction: forward ? "forward" : "backward",
          cycle: mode === "once" ? 0n : floorDiv(at, period),
        },
      });
    }
  });

  found.sort((a, b) => {
    const byTime = cmp(a.crossing.at, b.crossing.at);
    if (byTime !== 0) return forward ? byTime : -byTime;
    return a.seq - b.seq;
  });
  return found.map((f) => f.crossing);
}
