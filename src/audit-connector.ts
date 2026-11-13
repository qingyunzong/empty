import type { CursorPage, ProbeResult, SliceSource, TimeWindow } from "./planner.ts";
import type { CheckpointStore } from "./checkpoint.ts";
import { TimeSliceSync, type SliceSink } from "./sync.ts";

export interface AuditEvent {
  readonly id: string;
  readonly occurredAtMs: number;
}

export interface AuditQuery {
  readonly startMs: number;
  readonly endMs: number;
  /** Stable secondary cursor: continue strictly after this event id. */
  readonly afterId: string | null;
  readonly limit: number;
}

export interface AuditPage {
  readonly events: readonly AuditEvent[];
  /** True when the endpoint cut the result off at its single-request cap. */
  readonly truncated: boolean;
}

/** Minimal client surface of the capped, unpaginated audit endpoint. */
export interface AuditApi {
  query(query: AuditQuery): Promise<AuditPage>;
}

export interface AuditConnectorOptions {
  /** Per-request limit; must not exceed the endpoint's result cap. */
  readonly pageSize: number;
}

export const auditRecordKey = (event: AuditEvent): string => event.id;

/**
 * Adapts the capped audit API onto the planner's SliceSource so the
 * connector plugs directly into the time-slice planning library.
 *
 * The endpoint is assumed to order results by (occurredAtMs, id); the event
 * id serves as the stable secondary cursor for same-timestamp continuation.
 */
export function createAuditSliceSource(
  api: AuditApi,
  options: AuditConnectorOptions,
): SliceSource<AuditEvent, string> {
  const { pageSize } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer");
  }

  const toPage = (page: AuditPage): CursorPage<AuditEvent, string> => {
    const truncated = page.truncated || page.events.length >= pageSize;
    const last = page.events.length > 0 ? page.events[page.events.length - 1] : undefined;
    return {
      records: page.events,
      truncated,
      nextCursor: truncated && last !== undefined ? last.id : null,
    };
  };

  return {
    async probe(window: TimeWindow): Promise<ProbeResult> {
      const page = await api.query({
        startMs: window.startMs,
        endMs: window.endMs,
        afterId: null,
        limit: pageSize,
      });
      return { count: page.events.length, truncated: toPage(page).truncated };
    },
    async fetchPage(
      window: TimeWindow,
      cursor: string | null,
    ): Promise<CursorPage<AuditEvent, string>> {
      const page = await api.query({
        startMs: window.startMs,
        endMs: window.endMs,
        afterId: cursor,
        limit: pageSize,
      });
      return toPage(page);
    },
  };
}

export interface AuditSyncDeps {
  readonly store: CheckpointStore;
  readonly sink: SliceSink<AuditEvent>;
  readonly pageSize: number;
  readonly now?: () => Date;
}

/** Convenience wiring: audit API + checkpoints + sink -> resumable sync. */
export function createAuditSync(
  api: AuditApi,
  deps: AuditSyncDeps,
): TimeSliceSync<AuditEvent, string> {
  return new TimeSliceSync<AuditEvent, string>({
    source: createAuditSliceSource(api, { pageSize: deps.pageSize }),
    store: deps.store,
    sink: deps.sink,
    recordKey: auditRecordKey,
    now: deps.now,
  });
}
