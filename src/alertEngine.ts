import type { AlertInterval, EngineOutput, SampleEvent } from "./types";
import { intervalKey } from "./types";

/**
 * Segment-based interval computation: split the materialized sequence into
 * maximal tick-contiguous segments, then take maximal above-threshold runs
 * inside each segment. Structurally independent from the tick-by-tick
 * reference model so the two can be cross-checked against each other.
 */
export function computeIntervalsBySegments(
  samples: ReadonlyMap<number, number>,
  threshold: number,
  minDuration: number,
): AlertInterval[] {
  const ticks = [...samples.keys()].sort((a, b) => a - b);
  const intervals: AlertInterval[] = [];

  let runStart = -1;
  const flush = (runEnd: number): void => {
    if (runStart >= 0 && runEnd - runStart + 1 >= minDuration) {
      intervals.push({
        start: runStart,
        end: runEnd,
        threshold,
        minDuration,
        startEvidence: { tick: runStart, value: samples.get(runStart)! },
        endEvidence: { tick: runEnd, value: samples.get(runEnd)! },
      });
    }
    runStart = -1;
  };

  let prevTick: number | null = null;
  for (const tick of ticks) {
    const above = samples.get(tick)! > threshold;
    const contiguous = prevTick !== null && tick === prevTick + 1;
    if (above && runStart < 0) {
      runStart = tick;
    } else if (above && !contiguous) {
      flush(prevTick!);
      runStart = tick;
    } else if (!above && runStart >= 0) {
      flush(prevTick!);
    }
    prevTick = tick;
  }
  if (runStart >= 0 && prevTick !== null) flush(prevTick);

  return intervals;
}

/**
 * Streaming alert engine over a hold sequence.
 *
 * Semantics:
 * - Samples are keyed by tick; a later event for an existing tick is a
 *   correction and replaces the stored value before any evaluation.
 * - Events may arrive late (out of tick order). After every event the
 *   qualifying intervals are recomputed over the materialized sequence and
 *   diffed against what was previously emitted: new intervals raise
 *   `alert`, vanished ones raise `retract`.
 * - A missing tick breaks a run; a run qualifies when its held length
 *   (end - start + 1) is at least `minDuration`.
 */
export class AlertEngine {
  private readonly samples = new Map<number, number>();
  private emitted = new Map<string, AlertInterval>();

  constructor(
    private readonly threshold: number,
    private readonly minDuration: number,
  ) {}

  ingest(event: SampleEvent): EngineOutput[] {
    this.samples.set(event.tick, event.value);

    const current = computeIntervalsBySegments(
      this.samples,
      this.threshold,
      this.minDuration,
    );

    const outputs: EngineOutput[] = [];
    const next = new Map<string, AlertInterval>();
    for (const interval of current) {
      const key = intervalKey(interval);
      next.set(key, interval);
      if (!this.emitted.has(key)) outputs.push({ type: "alert", interval });
    }
    for (const [key, interval] of this.emitted) {
      if (!next.has(key)) outputs.push({ type: "retract", interval });
    }
    this.emitted = next;
    return outputs;
  }

  /** Intervals currently in force (alerts minus retractions so far). */
  activeAlerts(): AlertInterval[] {
    return [...this.emitted.values()];
  }
}
