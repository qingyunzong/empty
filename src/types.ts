export type Tick = number;

/** A single observation of the signal at a tick. */
export interface SampleEvent {
  tick: Tick;
  value: number;
}

/** A materialized sample: one value per tick after corrections are applied. */
export interface Sample {
  tick: Tick;
  value: number;
}

/** Evidence pinning one end of an alert interval to real data. */
export interface Evidence {
  tick: Tick;
  value: number;
}

/**
 * A maximal run of consecutive ticks, each with value > threshold,
 * whose held length (end - start + 1) is at least minDuration.
 */
export interface AlertInterval {
  start: Tick;
  end: Tick;
  threshold: number;
  minDuration: number;
  /** First above-threshold sample of the run. */
  startEvidence: Evidence;
  /** Last above-threshold sample of the run. */
  endEvidence: Evidence;
}

export type EngineOutput =
  | { type: "alert"; interval: AlertInterval }
  | { type: "retract"; interval: AlertInterval };

export function intervalKey(iv: AlertInterval): string {
  return `${iv.start}:${iv.end}:${iv.threshold}:${iv.minDuration}`;
}
