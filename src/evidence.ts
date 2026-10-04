import type { SeriesStore } from "./series.ts";
import type { AlertInterval, BoundaryEvidence, Tick } from "./types.ts";

function boundaryBefore(store: SeriesStore, tick: Tick): BoundaryEvidence {
  const min = store.minTick;
  if (min === null || tick - 1 < min) {
    return { tick: tick - 1, value: null, reason: "series-start" };
  }
  const value = store.valueAt(tick - 1);
  if (value === null) return { tick: tick - 1, value: null, reason: "missing" };
  return { tick: tick - 1, value, reason: "below-threshold" };
}

function boundaryAfter(store: SeriesStore, tick: Tick): BoundaryEvidence {
  const max = store.maxTick;
  if (max === null || tick + 1 > max) {
    return { tick: tick + 1, value: null, reason: "open" };
  }
  const value = store.valueAt(tick + 1);
  if (value === null) return { tick: tick + 1, value: null, reason: "missing" };
  return { tick: tick + 1, value, reason: "below-threshold" };
}

/** Attaches start/end evidence to a detected run [startTick, endTick]. */
export function buildInterval(
  store: SeriesStore,
  startTick: Tick,
  endTick: Tick,
): AlertInterval {
  const startValue = store.valueAt(startTick);
  const endValue = store.valueAt(endTick);
  if (startValue === null || endValue === null) {
    throw new Error("interval boundaries must have known values");
  }
  return {
    startTick,
    endTick,
    durationTicks: endTick - startTick + 1,
    startEvidence: {
      sample: { tick: startTick, value: startValue },
      before: boundaryBefore(store, startTick),
    },
    endEvidence: {
      sample: { tick: endTick, value: endValue },
      after: boundaryAfter(store, endTick),
    },
  };
}
