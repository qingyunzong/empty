import type { SeriesEvent, Tick } from "./types.ts";

/**
 * Stores the signal keep-sequence. Applies events tick by tick; when several
 * events target the same tick in one batch, observations are applied first,
 * then corrections, then explicit missing declarations, so judgement always
 * sees the corrected state ("同 tick 先应用更正再判定").
 */
export class SeriesStore {
  private values = new Map<Tick, number>();
  private gaps = new Set<Tick>();
  private min: Tick | null = null;
  private max: Tick | null = null;

  apply(events: SeriesEvent[]): void {
    const byTick = new Map<Tick, SeriesEvent[]>();
    for (const event of events) {
      const list = byTick.get(event.tick);
      if (list) list.push(event);
      else byTick.set(event.tick, [event]);
    }
    for (const [tick, list] of byTick) {
      const observations = list.filter((e) => e.kind === "observation");
      const corrections = list.filter((e) => e.kind === "correction");
      const missings = list.filter((e) => e.kind === "missing");
      if (missings.length > 0) {
        this.values.delete(tick);
        this.gaps.add(tick);
      } else {
        const lastObservation = observations[observations.length - 1];
        const lastCorrection = corrections[corrections.length - 1];
        const effective = lastCorrection ?? lastObservation;
        if (effective) {
          this.values.set(tick, effective.value);
          this.gaps.delete(tick);
        }
      }
      this.min = this.min === null ? tick : Math.min(this.min, tick);
      this.max = this.max === null ? tick : Math.max(this.max, tick);
    }
  }

  valueAt(tick: Tick): number | null {
    return this.values.get(tick) ?? null;
  }

  isGap(tick: Tick): boolean {
    return this.gaps.has(tick);
  }

  get minTick(): Tick | null {
    return this.min;
  }

  get maxTick(): Tick | null {
    return this.max;
  }
}
