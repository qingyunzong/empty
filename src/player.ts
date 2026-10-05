import { Rational, ZERO, add, cmp, floorDiv, scale } from "./rational.js";
import { Track } from "./timeline.js";
import { PlayMode, mapTime } from "./mapping.js";
import {
  EventCrossing,
  TimelineEvent,
  crossingsBetween,
  validateEvents,
} from "./events.js";

export interface PlayerOptions {
  readonly track: Track;
  readonly mode: PlayMode;
  /** Defaults to the track's last keyframe time. */
  readonly duration?: Rational;
  readonly events?: readonly TimelineEvent[];
  readonly onEvent?: (crossing: EventCrossing) => void;
  readonly startTime?: Rational;
}

/**
 * Stateful playhead over a Track. The value is always
 * `track.evaluate(mapTime(time).local)` — a pure function of the current
 * rational time — so arbitrary seeks, reverse playback and direct
 * evaluation at the same time always agree; the player keeps no
 * interpolated state that could drift.
 */
export class Player {
  readonly track: Track;
  readonly mode: PlayMode;
  readonly duration: Rational;
  readonly events: readonly TimelineEvent[];
  private readonly onEvent?: (crossing: EventCrossing) => void;
  private current: Rational;

  constructor(options: PlayerOptions) {
    this.track = options.track;
    this.mode = options.mode;
    this.duration = options.duration ?? options.track.duration;
    if (cmp(this.duration, ZERO) <= 0) {
      throw new RangeError("duration must be positive");
    }
    this.events = options.events ?? [];
    validateEvents(this.events, this.duration, this.mode);
    if (options.onEvent) this.onEvent = options.onEvent;
    this.current = options.startTime ?? ZERO;
  }

  get time(): Rational {
    return this.current;
  }

  /** Local timeline time of the playhead. */
  localTime(): Rational {
    return mapTime(this.current, this.duration, this.mode).local;
  }

  /** Value at the playhead; identical to direct evaluation at `time`. */
  value(): number {
    return this.track.evaluate(this.localTime());
  }

  /**
   * Jump to an absolute rational time (any distance, either direction).
   * Events crossed en route fire once each, in traversal order.
   */
  seek(t: Rational): EventCrossing[] {
    const crossings = crossingsBetween(
      this.events,
      this.current,
      t,
      this.duration,
      this.mode,
    );
    this.current = t;
    if (this.onEvent) for (const c of crossings) this.onEvent(c);
    return crossings;
  }

  /** Move by a signed rational delta (negative = reverse playback). */
  advance(delta: Rational): EventCrossing[] {
    return this.seek(add(this.current, delta));
  }

  /** Cycle index the playhead is currently in. */
  cycle(): bigint {
    const period = this.mode === "pingpong" ? scale(this.duration, 2n) : this.duration;
    return this.mode === "once" ? 0n : floorDiv(this.current, period);
  }
}
