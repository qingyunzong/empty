import { buildInterval } from "./evidence.ts";
import type { SeriesStore } from "./series.ts";
import type { AlertInterval, Tick } from "./types.ts";

/**
 * Tick-by-tick reference model (逐 tick 模型): walks every tick in order with
 * an explicit state machine, opening a run on the first above-threshold tick
 * and closing it on the first tick that is below threshold or missing.
 * Used as the independent oracle the alert engine is checked against.
 */
export class TickByTickModel {
  private runStart: Tick | null = null;
  private readonly intervals: AlertInterval[] = [];
  private readonly threshold: number;
  private readonly minDuration: number;

  constructor(threshold: number, minDuration: number) {
    this.threshold = threshold;
    this.minDuration = minDuration;
  }

  step(store: SeriesStore, tick: Tick): void {
    const value = store.valueAt(tick);
    const above = value !== null && value > this.threshold;
    if (above) {
      if (this.runStart === null) this.runStart = tick;
    } else if (this.runStart !== null) {
      this.closeRun(store, this.runStart, tick - 1);
      this.runStart = null;
    }
  }

  finish(store: SeriesStore): AlertInterval[] {
    if (this.runStart !== null) {
      const max = store.maxTick;
      if (max !== null) this.closeRun(store, this.runStart, max);
      this.runStart = null;
    }
    return [...this.intervals];
  }

  private closeRun(store: SeriesStore, start: Tick, end: Tick): void {
    if (end - start + 1 >= this.minDuration) {
      this.intervals.push(buildInterval(store, start, end));
    }
  }
}

export function evaluateTickByTick(
  store: SeriesStore,
  threshold: number,
  minDuration: number,
): AlertInterval[] {
  const model = new TickByTickModel(threshold, minDuration);
  const min = store.minTick;
  const max = store.maxTick;
  if (min === null || max === null) return [];
  for (let tick = min; tick <= max; tick += 1) {
    model.step(store, tick);
  }
  return model.finish(store);
}
