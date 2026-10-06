import { Rational } from "./rational.js";

export interface TempoSegment {
  /** First tick (inclusive) covered by this segment. */
  readonly tick: number;
  /** Microseconds per tick for this segment, as an exact rational. */
  readonly usPerTick: Rational;
}

interface MutableSegment {
  tick: number;
  usPerTick: Rational;
}

function validateTick(tick: number, name: string): void {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${tick}`);
  }
}

function validateRate(usPerTick: Rational): void {
  if (!usPerTick.isPositive()) {
    throw new RangeError(`usPerTick must be positive, got ${usPerTick.toString()}`);
  }
}

/**
 * Piecewise-constant tempo map over integer ticks.
 *
 * Each segment carries a rational microseconds-per-tick rate. The time of a
 * tick is the exact rational integral of the rate over [0, tick); conversion
 * to integer microseconds applies a single round-half-even at the very end,
 * never per segment.
 *
 * The map only defines the tick -> time conversion; it never rewrites tick
 * values, so editing segments cannot move events (which store plain ticks).
 */
export class TempoMap {
  private segs: MutableSegment[];

  constructor(initialUsPerTick: Rational) {
    validateRate(initialUsPerTick);
    this.segs = [{ tick: 0, usPerTick: initialUsPerTick }];
  }

  /** Insert a segment starting at `tick`, or replace the one already there. */
  setTempo(tick: number, usPerTick: Rational): void {
    validateTick(tick, "tick");
    validateRate(usPerTick);
    const idx = this.segs.findIndex((s) => s.tick >= tick);
    if (idx === -1) {
      this.segs.push({ tick, usPerTick });
    } else if (this.segs[idx]!.tick === tick) {
      this.segs[idx]!.usPerTick = usPerTick;
    } else {
      this.segs.splice(idx, 0, { tick, usPerTick });
    }
  }

  /** Remove the segment starting at `tick` (the tick-0 segment cannot go). */
  removeTempo(tick: number): boolean {
    validateTick(tick, "tick");
    if (tick === 0) return false;
    const idx = this.segs.findIndex((s) => s.tick === tick);
    if (idx === -1) return false;
    this.segs.splice(idx, 1);
    return true;
  }

  get segments(): readonly TempoSegment[] {
    return this.segs;
  }

  /** Exact accumulated time of `tick` as a rational number of microseconds. */
  tickToRational(tick: number): Rational {
    validateTick(tick, "tick");
    let acc = Rational.zero();
    for (let i = 0; i < this.segs.length; i++) {
      const seg = this.segs[i]!;
      if (tick <= seg.tick) break;
      const next = i + 1 < this.segs.length ? this.segs[i + 1]!.tick : Infinity;
      const end = Math.min(tick, next);
      acc = acc.add(seg.usPerTick.mul(Rational.of(end - seg.tick)));
      if (end === tick) break;
    }
    return acc;
  }

  /** Microsecond time of `tick`: exact integral, rounded half-to-even once. */
  tickToUs(tick: number): bigint {
    return this.tickToRational(tick).roundHalfEven();
  }

  /**
   * Reverse lookup: the earliest tick whose (rounded) microsecond time is
   * greater than or equal to `us`. Rates are strictly positive, so rounded
   * time is non-decreasing in tick and binary search is exact.
   */
  usToTick(us: bigint | number): number {
    const target = BigInt(us);
    if (target <= 0n) return 0;
    let hi = 1;
    while (this.tickToUs(hi) < target) hi *= 2;
    let lo = 0; // invariant: tickToUs(lo) < target <= tickToUs(hi)
    while (hi - lo > 1) {
      const mid = lo + ((hi - lo) >> 1);
      if (this.tickToUs(mid) >= target) hi = mid;
      else lo = mid;
    }
    return hi;
  }
}
