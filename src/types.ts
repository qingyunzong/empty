/** A single alert event. Ordering is by (time, id). */
export interface AlertEvent {
  readonly id: string;
  readonly key: string;
  /** Event time in milliseconds. */
  readonly time: number;
  readonly message?: string;
}

/** Sliding time window: left-inclusive, right-exclusive — [start, end). */
export interface TimeWindow {
  readonly start: number;
  readonly end: number;
}

/** What caused a batch of display changes. */
export type ChangeSource = "upsert" | "remove" | "window" | "transaction";

export interface DisplayChange {
  readonly type: "added" | "removed";
  readonly event: AlertEvent;
}

/**
 * One committed batch. `version` increases by exactly 1 per batch.
 * `changes` are netted: an item added and removed within the same batch
 * does not appear at all.
 */
export interface Batch {
  readonly version: number;
  readonly source: ChangeSource;
  readonly changes: readonly DisplayChange[];
}

export type SubscriptionMessage =
  | { readonly kind: "snapshot"; readonly version: number; readonly items: readonly AlertEvent[] }
  | { readonly kind: "batch"; readonly version: number; readonly source: ChangeSource; readonly changes: readonly DisplayChange[] }
  | {
      readonly kind: "resync";
      /** Last version actually delivered to the subscriber before this resync. */
      readonly fromVersion: number | null;
      readonly version: number;
      readonly items: readonly AlertEvent[];
    };

/** Total order over events: earliest time first, ties broken by ascending id. */
export function compareEvents(a: AlertEvent, b: AlertEvent): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
