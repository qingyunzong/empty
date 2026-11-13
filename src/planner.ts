export interface TimeWindow {
  /** Inclusive lower bound, epoch milliseconds. */
  readonly startMs: number;
  /** Exclusive upper bound, epoch milliseconds. */
  readonly endMs: number;
}

export interface ProbeResult {
  /** Number of records observed for the window (may be capped by the endpoint). */
  readonly count: number;
  /** True when the endpoint hit its single-request result cap. */
  readonly truncated: boolean;
}

export interface CursorPage<TRecord, TCursor> {
  readonly records: readonly TRecord[];
  /** Stable secondary cursor to continue with, or null when exhausted. */
  readonly nextCursor: TCursor | null;
  /** True when this page was cut short by the endpoint cap. */
  readonly truncated: boolean;
}

/**
 * Pluggable source interface: any endpoint adapter (e.g. the audit API
 * connector) implements this to be driven by the time-slice planner.
 */
export interface SliceSource<TRecord, TCursor> {
  probe(window: TimeWindow): Promise<ProbeResult>;
  fetchPage(window: TimeWindow, cursor: TCursor | null): Promise<CursorPage<TRecord, TCursor>>;
}

export type PlannedSlice<TRecord> =
  | { readonly kind: "window"; readonly window: TimeWindow; readonly expectedCount: number }
  | { readonly kind: "materialized"; readonly window: TimeWindow; readonly records: readonly TRecord[] };

export class SliceOverflowError extends Error {
  readonly window: TimeWindow;
  readonly drainedCount: number;

  constructor(window: TimeWindow, drainedCount: number) {
    super(
      `Time slice [${window.startMs}, ${window.endMs}) cannot be subdivided further ` +
        `and still overflows after draining ${drainedCount} record(s) via the secondary cursor`,
    );
    this.name = "SliceOverflowError";
    this.window = window;
    this.drainedCount = drainedCount;
  }
}

export class UnstableCursorError extends Error {
  readonly window: TimeWindow;

  constructor(window: TimeWindow) {
    super(
      `Secondary cursor for time slice [${window.startMs}, ${window.endMs}) did not advance; ` +
        `the endpoint cannot provide reliable continuation`,
    );
    this.name = "UnstableCursorError";
    this.window = window;
  }
}

export function assertValidWindow(window: TimeWindow): void {
  if (!Number.isInteger(window.startMs) || !Number.isInteger(window.endMs)) {
    throw new RangeError("Window bounds must be integer epoch milliseconds");
  }
  if (window.startMs < 0 || window.endMs <= window.startMs) {
    throw new RangeError(
      `Invalid half-open window [${window.startMs}, ${window.endMs}): need 0 <= startMs < endMs`,
    );
  }
}

/**
 * Plans leaf slices covering the half-open root window. Windows that hit the
 * endpoint cap are bisected into half-open sub-windows; a minimal (1ms)
 * window that still overflows is drained through the stable secondary cursor.
 * Throws SliceOverflowError when even that cannot complete the window.
 */
export async function planSlices<TRecord, TCursor>(
  source: SliceSource<TRecord, TCursor>,
  root: TimeWindow,
): Promise<PlannedSlice<TRecord>[]> {
  assertValidWindow(root);
  const slices: PlannedSlice<TRecord>[] = [];
  await planInto(source, root, slices);
  return slices;
}

async function planInto<TRecord, TCursor>(
  source: SliceSource<TRecord, TCursor>,
  window: TimeWindow,
  out: PlannedSlice<TRecord>[],
): Promise<void> {
  const probe = await source.probe(window);
  if (!probe.truncated) {
    out.push({ kind: "window", window, expectedCount: probe.count });
    return;
  }
  const spanMs = window.endMs - window.startMs;
  if (spanMs > 1) {
    const midMs = window.startMs + Math.floor(spanMs / 2);
    await planInto(source, { startMs: window.startMs, endMs: midMs }, out);
    await planInto(source, { startMs: midMs, endMs: window.endMs }, out);
    return;
  }
  const records = await fetchAllRecords(source, window);
  out.push({ kind: "materialized", window, records });
}

/**
 * Reads every record of a window by following the stable secondary cursor.
 * Used by the planner for minimal overflowing windows and by the sync runner
 * to materialize plain leaf windows. Fails explicitly when the endpoint
 * reports truncation but cannot provide a continuing cursor.
 */
export async function fetchAllRecords<TRecord, TCursor>(
  source: SliceSource<TRecord, TCursor>,
  window: TimeWindow,
): Promise<TRecord[]> {
  const records: TRecord[] = [];
  let cursor: TCursor | null = null;
  for (;;) {
    const page = await source.fetchPage(window, cursor);
    records.push(...page.records);
    if (page.nextCursor === null) {
      if (page.truncated) {
        throw new SliceOverflowError(window, records.length);
      }
      break;
    }
    if (page.records.length === 0 || Object.is(page.nextCursor, cursor)) {
      throw new UnstableCursorError(window);
    }
    cursor = page.nextCursor;
  }
  return records;
}
