/**
 * OData delta traversal component for the enterprise directory collection
 * service.
 *
 * Semantics:
 * - Walks a delta generation page by page, following `@odata.nextLink`.
 * - Distinguishes upserts from removals via `@removed` and preserves the removed
 *   reason (`deleted` | `changed`).
 * - Coalesces multiple changes to the same entity within one generation
 *   (last change wins).
 * - Only commits the new `@odata.deltaLink` after the current generation has
 *   been walked to completion; intermediate progress is checkpointed as a
 *   pending `nextLink` plus the buffered changes.
 * - If a run is cancelled mid-generation, the next run resumes from the
 *   original pending `nextLink`.
 * - If the server answers 410 Gone, the delta token is invalid: the collector
 *   discards all pending state, clears the snapshot (including old removal
 *   records) and starts a full new generation from the initial URL.
 */

export type RemovedReason = "deleted" | "changed";

export interface DirectoryEntity {
  id: string;
  [key: string]: unknown;
}

export interface DeltaChange {
  id: string;
  kind: "upsert" | "removed";
  /** Present only when kind === "removed". */
  reason?: RemovedReason;
  /** Present only when kind === "upsert". */
  entity?: DirectoryEntity;
}

export interface Checkpoint {
  /** Monotonic walk identifier; increments on commit and on 410 reset. */
  generation: number;
  /** deltaLink of the last fully completed generation. */
  committedDeltaLink: string | null;
  /** Resume point of the in-progress generation, if any. */
  pendingNextLink: string | null;
  /** Coalesced changes buffered for the in-progress generation. */
  pendingChanges: DeltaChange[];
}

export interface CheckpointStore {
  load(): Promise<Checkpoint | null>;
  save(checkpoint: Checkpoint): Promise<void>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoint: Checkpoint | null = null;

  async load(): Promise<Checkpoint | null> {
    return this.checkpoint ? structuredClone(this.checkpoint) : null;
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }
}

export interface PageResponse {
  status: number;
  body?: unknown;
}

export type PageFetcher = (
  url: string,
  signal: AbortSignal,
) => Promise<PageResponse>;

export class DeltaFetchError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`OData delta request failed with status ${status}: ${url}`);
    this.name = "DeltaFetchError";
    this.status = status;
    this.url = url;
  }
}

export class DeltaProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeltaProtocolError";
  }
}

export type DeltaEvent =
  | { type: "reset"; generation: number }
  | { type: "upsert"; generation: number; change: DeltaChange }
  | { type: "removed"; generation: number; change: DeltaChange }
  | { type: "commit"; generation: number; deltaLink: string };

export type RunResult =
  | { status: "committed"; generation: number; deltaLink: string }
  | { status: "cancelled"; generation: number };

export interface DeltaCollectorOptions {
  /** Initial delta query URL, used for the first and for full (post-410) generations. */
  initialUrl: string;
  fetcher: PageFetcher;
  store?: CheckpointStore;
  /** Entity key property in the payload. Defaults to "id". */
  idKey?: string;
  onEvent?: (event: DeltaEvent) => void;
}

interface ParsedPage {
  changes: DeltaChange[];
  nextLink: string | null;
  deltaLink: string | null;
}

const HTTP_GONE = 410;

export class DeltaCollector {
  private readonly initialUrl: string;
  private readonly fetcher: PageFetcher;
  private readonly store: CheckpointStore;
  private readonly idKey: string;
  private readonly onEvent?: (event: DeltaEvent) => void;

  /** Live entities of the last committed generation. */
  readonly snapshot = new Map<string, DirectoryEntity>();

  constructor(options: DeltaCollectorOptions) {
    this.initialUrl = options.initialUrl;
    this.fetcher = options.fetcher;
    this.store = options.store ?? new InMemoryCheckpointStore();
    this.idKey = options.idKey ?? "id";
    this.onEvent = options.onEvent;
  }

  /**
   * Walks exactly one generation: resumes an in-progress generation from its
   * pending nextLink, otherwise starts a new walk from the committed
   * deltaLink (or the initial URL when nothing has been committed yet).
   */
  async run(options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const signal = options.signal ?? new AbortController().signal;

    let checkpoint =
      (await this.store.load()) ??
      ({
        generation: 1,
        committedDeltaLink: null,
        pendingNextLink: null,
        pendingChanges: [],
      } satisfies Checkpoint);

    const buffer = new Map<string, DeltaChange>();
    for (const change of checkpoint.pendingChanges) {
      buffer.set(change.id, change);
    }

    let url =
      checkpoint.pendingNextLink ??
      checkpoint.committedDeltaLink ??
      this.initialUrl;

    for (;;) {
      if (signal.aborted) {
        return { status: "cancelled", generation: checkpoint.generation };
      }

      let response: PageResponse;
      try {
        response = await this.fetcher(url, signal);
      } catch (error) {
        if (signal.aborted) {
          return { status: "cancelled", generation: checkpoint.generation };
        }
        throw error;
      }

      if (response.status === HTTP_GONE) {
        // The delta token is no longer valid. Abandon the in-progress
        // generation and start a full new one; old removals must not leak
        // into the new snapshot.
        checkpoint = {
          generation: checkpoint.generation + 1,
          committedDeltaLink: null,
          pendingNextLink: null,
          pendingChanges: [],
        };
        buffer.clear();
        this.snapshot.clear();
        url = this.initialUrl;
        await this.store.save(checkpoint);
        this.emit({ type: "reset", generation: checkpoint.generation });
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new DeltaFetchError(response.status, url);
      }

      const page = parsePage(response.body, this.idKey);
      for (const change of page.changes) {
        buffer.set(change.id, change);
      }

      if (page.nextLink !== null) {
        // Generation not finished: checkpoint the resume point and the
        // buffered changes, but never the new deltaLink.
        checkpoint = {
          ...checkpoint,
          pendingNextLink: page.nextLink,
          pendingChanges: [...buffer.values()],
        };
        await this.store.save(checkpoint);
        url = page.nextLink;
        continue;
      }

      if (page.deltaLink !== null) {
        for (const change of buffer.values()) {
          if (change.kind === "removed") {
            this.snapshot.delete(change.id);
            this.emit({
              type: "removed",
              generation: checkpoint.generation,
              change,
            });
          } else {
            this.snapshot.set(change.id, change.entity as DirectoryEntity);
            this.emit({
              type: "upsert",
              generation: checkpoint.generation,
              change,
            });
          }
        }
        checkpoint = {
          generation: checkpoint.generation + 1,
          committedDeltaLink: page.deltaLink,
          pendingNextLink: null,
          pendingChanges: [],
        };
        await this.store.save(checkpoint);
        this.emit({
          type: "commit",
          generation: checkpoint.generation,
          deltaLink: page.deltaLink,
        });
        return {
          status: "committed",
          generation: checkpoint.generation,
          deltaLink: page.deltaLink,
        };
      }

      throw new DeltaProtocolError(
        `OData page at ${url} carries neither @odata.nextLink nor @odata.deltaLink`,
      );
    }
  }

  private emit(event: DeltaEvent): void {
    this.onEvent?.(event);
  }
}

function parsePage(body: unknown, idKey: string): ParsedPage {
  if (typeof body !== "object" || body === null) {
    throw new DeltaProtocolError("OData page body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  const value = obj["value"];
  if (!Array.isArray(value)) {
    throw new DeltaProtocolError('OData page body is missing the "value" array');
  }
  return {
    changes: value.map((item) => parseItem(item, idKey)),
    nextLink: readLink(obj, "@odata.nextLink"),
    deltaLink: readLink(obj, "@odata.deltaLink"),
  };
}

function readLink(obj: Record<string, unknown>, key: string): string | null {
  const link = obj[key];
  if (link === undefined || link === null) return null;
  if (typeof link !== "string") {
    throw new DeltaProtocolError(`${key} must be a string`);
  }
  return link;
}

function parseItem(item: unknown, idKey: string): DeltaChange {
  if (typeof item !== "object" || item === null) {
    throw new DeltaProtocolError("OData delta entry must be a JSON object");
  }
  const record = item as Record<string, unknown>;
  const id = record[idKey];
  if (typeof id !== "string" || id.length === 0) {
    throw new DeltaProtocolError(
      `OData delta entry is missing its "${idKey}" key`,
    );
  }

  const removed = record["@removed"];
  if (removed !== undefined && removed !== null) {
    const reason =
      typeof removed === "object" &&
      (removed as Record<string, unknown>)["reason"] === "changed"
        ? "changed"
        : "deleted";
    return { id, kind: "removed", reason };
  }

  return { id, kind: "upsert", entity: item as DirectoryEntity };
}
