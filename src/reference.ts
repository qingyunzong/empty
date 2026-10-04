import type { AlertInterval, Sample } from "./types";

/**
 * Tick-by-tick reference model.
 *
 * Walks the materialized samples in ascending tick order with an explicit
 * state machine: a run opens on an above-threshold sample, continues only
 * while the next tick is exactly prevTick + 1 and still above threshold,
 * and closes on the first missing or below-threshold tick. A closed run
 * becomes an alert interval iff it was held for at least minDuration ticks.
 */
export function computeIntervalsTickByTick(
  samples: readonly Sample[],
  threshold: number,
  minDuration: number,
): AlertInterval[] {
  const sorted = [...samples].sort((a, b) => a.tick - b.tick);
  const intervals: AlertInterval[] = [];

  let runStart: Sample | null = null;
  let prev: Sample | null = null;

  const closeRun = (endSample: Sample): void => {
    if (runStart === null) return;
    if (endSample.tick - runStart.tick + 1 >= minDuration) {
      intervals.push({
        start: runStart.tick,
        end: endSample.tick,
        threshold,
        minDuration,
        startEvidence: { tick: runStart.tick, value: runStart.value },
        endEvidence: { tick: endSample.tick, value: endSample.value },
      });
    }
    runStart = null;
  };

  for (const sample of sorted) {
    const continues =
      runStart !== null &&
      prev !== null &&
      sample.tick === prev.tick + 1 &&
      sample.value > threshold;
    if (!continues) {
      if (prev !== null) closeRun(prev);
      runStart = sample.value > threshold ? sample : null;
    }
    prev = sample;
  }
  if (prev !== null) closeRun(prev);

  return intervals;
}
