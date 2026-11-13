import type { CheckpointStore, SliceSummary } from "./checkpoint.ts";
import { digestRecordKeys, windowKey } from "./checkpoint.ts";
import type { PlannedSlice, SliceSource, TimeWindow } from "./planner.ts";
import { fetchAllRecords, planSlices } from "./planner.ts";

export interface SliceSink<TRecord> {
  publish(slice: PlannedSlice<TRecord>, records: readonly TRecord[]): Promise<void>;
}

export interface TimeSliceSyncOptions<TRecord, TCursor> {
  readonly source: SliceSource<TRecord, TCursor>;
  readonly store: CheckpointStore;
  readonly sink: SliceSink<TRecord>;
  /** Stable identity of a record, used for the slice digest. */
  readonly recordKey: (record: TRecord) => string;
  readonly now?: () => Date;
}

export interface RunReport {
  /** Slices completed and checkpointed during this run. */
  readonly published: readonly SliceSummary[];
  /** Slices already checkpointed by earlier runs; not published again. */
  readonly skipped: readonly SliceSummary[];
  readonly totalRecords: number;
}

/**
 * Drives a root window to completion: plans slices, publishes each missing
 * slice exactly once, and checkpoints a summary per completed slice so a
 * resumed run never re-publishes finished work.
 */
export class TimeSliceSync<TRecord, TCursor> {
  readonly #options: TimeSliceSyncOptions<TRecord, TCursor>;

  constructor(options: TimeSliceSyncOptions<TRecord, TCursor>) {
    this.#options = options;
  }

  async run(root: TimeWindow): Promise<RunReport> {
    const { source, store, sink, recordKey } = this.#options;
    const now = this.#options.now ?? (() => new Date());
    const slices = await planSlices(source, root);
    const published: SliceSummary[] = [];
    const skipped: SliceSummary[] = [];
    let totalRecords = 0;

    for (const slice of slices) {
      const key = windowKey(slice.window);
      const existing = await store.get(key);
      if (existing !== undefined) {
        skipped.push(existing);
        totalRecords += existing.recordCount;
        continue;
      }
      const records =
        slice.kind === "materialized" ? slice.records : await fetchAllRecords(source, slice.window);
      await sink.publish(slice, records);
      const keys = records.map((record) => recordKey(record));
      const summary: SliceSummary = {
        key,
        window: slice.window,
        recordCount: records.length,
        digest: digestRecordKeys(keys),
        firstRecordKey: keys[0] ?? null,
        lastRecordKey: keys.length > 0 ? keys[keys.length - 1] : null,
        completedAt: now().toISOString(),
      };
      await store.put(summary);
      published.push(summary);
      totalRecords += records.length;
    }

    return { published, skipped, totalRecords };
  }
}
