import { Rational, ceilRational, roundHalfEven } from "./rational.ts";

/** One tempo segment: starting at `startTick`, each tick lasts `microsecondsPerTick`. */
export interface TempoSegment {
  startTick: number;
  microsecondsPerTick: Rational;
}

interface Boundary {
  startTick: number;
  /** Exact cumulative microseconds at startTick. */
  timeAtStart: Rational;
  microsecondsPerTick: Rational;
}

/**
 * Piecewise-constant tempo map over integer ticks.
 *
 * Time is integrated exactly per segment with rational arithmetic; conversion
 * to integer microseconds applies round-half-to-even once, at the final step.
 * The map is immutable: editing tempo means building a new map, so event
 * ticks stored elsewhere are never shifted.
 */
export class TempoMap {
  private readonly boundaries: readonly Boundary[];

  constructor(segments: readonly TempoSegment[]) {
    if (segments.length === 0) throw new Error("TempoMap: need at least one segment");
    const sorted = [...segments].sort((a, b) => a.startTick - b.startTick);
    if (sorted[0]!.startTick !== 0) {
      throw new Error("TempoMap: first segment must start at tick 0");
    }
    const boundaries: Boundary[] = [];
    let timeAtStart = Rational.of(0);
    let prevTick = 0;
    let prevRate: Rational | null = null;
    for (const seg of sorted) {
      if (!Number.isInteger(seg.startTick) || seg.startTick < 0) {
        throw new Error(`TempoMap: invalid startTick ${seg.startTick}`);
      }
      if (seg.startTick < prevTick) throw new Error("TempoMap: duplicate startTick");
      if (seg.microsecondsPerTick.sign() <= 0) {
        throw new Error("TempoMap: microsecondsPerTick must be positive");
      }
      if (prevRate !== null) {
        timeAtStart = timeAtStart.add(prevRate.mul(Rational.of(seg.startTick - prevTick)));
      }
      boundaries.push({ startTick: seg.startTick, timeAtStart, microsecondsPerTick: seg.microsecondsPerTick });
      prevTick = seg.startTick;
      prevRate = seg.microsecondsPerTick;
    }
    this.boundaries = boundaries;
  }

  /** Convenience: build from BPM values and a PPQ (pulses per quarter note). */
  static fromBpm(ppq: number, points: readonly { tick: number; bpm: Rational }[]): TempoMap {
    return new TempoMap(
      points.map((p) => ({
        startTick: p.tick,
        // 60,000,000 us per minute / (bpm * ppq)
        microsecondsPerTick: Rational.of(60_000_000).div(p.bpm.mul(Rational.of(ppq))),
      })),
    );
  }

  get segmentCount(): number {
    return this.boundaries.length;
  }

  /** Exact cumulative time in microseconds at an integer tick. */
  timeAt(tick: number): Rational {
    if (!Number.isInteger(tick) || tick < 0) throw new Error(`TempoMap: invalid tick ${tick}`);
    const b = this.segmentFor(tick);
    return b.timeAtStart.add(b.microsecondsPerTick.mul(Rational.of(tick - b.startTick)));
  }

  /** Tick -> integer microseconds, exact integration then one round-half-even. */
  tickToMicroseconds(tick: number): number {
    const us = roundHalfEven(this.timeAt(tick));
    if (us > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("TempoMap: time out of range");
    return Number(us);
  }

  /**
   * Inverse lookup: the earliest tick whose exact time is >= `microseconds`.
   * Uses exact rational comparison, never the rounded values.
   */
  microsecondsToTick(microseconds: number): number {
    if (microseconds <= 0) return 0;
    const target = Rational.of(microseconds);
    // Last boundary whose timeAtStart < target (segment containing target).
    let lo = 0;
    let hi = this.boundaries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.boundaries[mid]!.timeAtStart.cmp(target) < 0) lo = mid;
      else hi = mid - 1;
    }
    const b = this.boundaries[lo]!;
    const offset = target.sub(b.timeAtStart); // >= 0
    const deltaTicks = ceilRational(offset.div(b.microsecondsPerTick));
    return b.startTick + Number(deltaTicks);
  }

  private segmentFor(tick: number): Boundary {
    let lo = 0;
    let hi = this.boundaries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.boundaries[mid]!.startTick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return this.boundaries[lo]!;
  }
}
