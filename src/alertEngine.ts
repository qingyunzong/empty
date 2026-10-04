import { buildInterval } from "./evidence.ts";
import { SeriesStore } from "./series.ts";
import type { AlertEvent, AlertInterval, SeriesEvent, Tick } from "./types.ts";

/**
 * Interval detection used by the engine: builds an above-threshold bitmap
 * over the known tick range and extracts maximal true-segments of length
 * >= minDuration with a two-pointer scan. Missing ticks (no value, or an
 * explicit gap) are false and therefore break segments.
 */
export function detectIntervals(
  store: SeriesStore,
  threshold: number,
  minDuration: number,
): AlertInterval[] {
  const min = store.minTick;
  const max = store.maxTick;
  if (min === null || max === null) return [];
  const intervals: AlertInterval[] = [];
  let tick = min;
  while (tick <= max) {
    const value = store.valueAt(tick);
    if (value === null || value <= threshold) {
      tick += 1;
      continue;
    }
    let end = tick;
    while (end + 1 <= max) {
      const next = store.valueAt(end + 1);
      if (next === null || next <= threshold) break;
      end += 1;
    }
    if (end - tick + 1 >= minDuration) {
      intervals.push(buildInterval(store, tick, end));
    }
    tick = end + 1;
  }
  return intervals;
}

/**
 * Alert engine. Ingests observation / correction / missing events (including
 * late ones), re-evaluates the affected series and diffs the resulting
 * intervals against the currently active alerts, emitting raised / extended /
 * retracted events. A late correction or missing declaration that breaks a
 * run therefore retracts the corresponding alert.
 */
export class AlertEngine {
  private readonly store = new SeriesStore();
  private active = new Map<Tick, AlertInterval>();
  private readonly threshold: number;
  private readonly minDuration: number;

  constructor(threshold: number, minDuration: number) {
    if (minDuration < 1) throw new Error("minDuration must be >= 1");
    this.threshold = threshold;
    this.minDuration = minDuration;
  }

  ingest(events: SeriesEvent[]): AlertEvent[] {
    this.store.apply(events);
    const next = new Map<Tick, AlertInterval>();
    for (const interval of detectIntervals(this.store, this.threshold, this.minDuration)) {
      next.set(interval.startTick, interval);
    }
    const emitted: AlertEvent[] = [];
    for (const [startTick, previous] of this.active) {
      const current = next.get(startTick);
      if (!current) {
        emitted.push({ type: "retracted", alert: previous });
      } else if (current.endTick !== previous.endTick) {
        emitted.push({ type: "extended", previousEnd: previous.endTick, alert: current });
      }
    }
    for (const [startTick, current] of next) {
      if (!this.active.has(startTick)) {
        emitted.push({ type: "raised", alert: current });
      }
    }
    emitted.sort((a, b) => a.alert.startTick - b.alert.startTick);
    this.active = next;
    return emitted;
  }

  activeAlerts(): AlertInterval[] {
    return [...this.active.values()].sort((a, b) => a.startTick - b.startTick);
  }
}
