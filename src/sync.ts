import { DeltaSyncError } from "./errors.js";
import { parseDeltaPage } from "./page.js";
import { compareServerVersions } from "./reconcile.js";
import type {
  CommitStats,
  DeltaChange,
  DeltaCheckpoint,
  DeltaCursor,
  DeltaPageFetcher,
  DeltaStore,
  DeltaSyncOptions,
  ODataEntity,
  ParsedDeltaPage,
  ServerVersion,
  SyncResult,
  VersionComparator,
} from "./types.js";

interface ActiveRound<T extends ODataEntity> {
  readonly resource: string;
  readonly baseDeltaLink?: string;
  nextLink: string;
  phase: "fetch" | "commit";
  pendingDeltaLink?: string;
  readonly changes: DeltaChange<T>[];
  pages: number;
  readonly visited: Set<string>;
}

interface ResponseLike {
  readonly ok?: boolean;
  readonly status?: number;
  readonly statusText?: string;
  json(): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimLink(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isResponseLike(value: unknown): value is ResponseLike {
  return isRecord(value) && typeof value.json === "function";
}

function isServerVersion(value: unknown): value is ServerVersion {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  );
}

function cloneChange<T extends ODataEntity>(
  change: DeltaChange<T>,
): DeltaChange<T> {
  if (change.kind === "removed") {
    return { ...change };
  }
  return { ...change, entity: { ...change.entity } };
}

function clonePage<T extends ODataEntity>(
  page: ParsedDeltaPage<T>,
): ParsedDeltaPage<T> {
  return {
    changes: page.changes.map(cloneChange),
    ...(page.nextLink === undefined ? {} : { nextLink: page.nextLink }),
    ...(page.deltaLink === undefined ? {} : { deltaLink: page.deltaLink }),
    raw: page.raw,
  };
}

function invalidCheckpoint(message: string): never {
  throw new DeltaSyncError(message, "INVALID_CHECKPOINT", {
    resumable: false,
  });
}

function validateChange<T extends ODataEntity>(
  value: unknown,
  index: number,
): DeltaChange<T> {
  if (!isRecord(value)) {
    invalidCheckpoint(`Checkpoint change ${index} is not an object`);
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    invalidCheckpoint(`Checkpoint change ${index} has no entity id`);
  }
  if (
    value.version !== undefined &&
    !isServerVersion(value.version)
  ) {
    invalidCheckpoint(`Checkpoint change ${index} has an invalid version`);
  }

  if (value.kind === "update") {
    if (!isRecord(value.entity)) {
      invalidCheckpoint(`Checkpoint change ${index} has no entity object`);
    }
    return value as unknown as DeltaChange<T>;
  }

  if (value.kind === "removed") {
    if (value.reason !== undefined && typeof value.reason !== "string") {
      invalidCheckpoint(`Checkpoint change ${index} has an invalid reason`);
    }
    return value as unknown as DeltaChange<T>;
  }

  return invalidCheckpoint(
    `Checkpoint change ${index} has an unknown kind`,
  );
}

function validateCheckpoint<T extends ODataEntity>(
  checkpoint: DeltaCheckpoint<T>,
  resource: string,
): DeltaCheckpoint<T> {
  if (!isRecord(checkpoint)) {
    invalidCheckpoint("Checkpoint must be an object");
  }
  if (checkpoint.version !== 1) {
    invalidCheckpoint("Unsupported checkpoint version");
  }
  if (checkpoint.resource !== resource) {
    throw new DeltaSyncError(
      `Checkpoint belongs to resource "${String(checkpoint.resource)}", not "${resource}"`,
      "RESOURCE_MISMATCH",
      { resumable: false },
    );
  }
  if (checkpoint.phase !== "fetch" && checkpoint.phase !== "commit") {
    invalidCheckpoint("Checkpoint phase must be fetch or commit");
  }

  const nextLink = trimLink(checkpoint.nextLink);
  if (nextLink === undefined) {
    invalidCheckpoint("Checkpoint has no nextLink");
  }
  const pendingDeltaLink = trimLink(checkpoint.pendingDeltaLink);
  if (checkpoint.phase === "commit" && pendingDeltaLink === undefined) {
    invalidCheckpoint("Commit checkpoint has no pendingDeltaLink");
  }
  const baseDeltaLink = trimLink(checkpoint.baseDeltaLink);

  if (
    !Number.isInteger(checkpoint.pages) ||
    checkpoint.pages < 0
  ) {
    invalidCheckpoint("Checkpoint page count is invalid");
  }
  if (!Array.isArray(checkpoint.changes)) {
    invalidCheckpoint("Checkpoint changes must be an array");
  }
  if (!Array.isArray(checkpoint.visitedLinks)) {
    invalidCheckpoint("Checkpoint visitedLinks must be an array");
  }
  if (
    checkpoint.visitedLinks.some(
      (link) => typeof link !== "string" || link.trim().length === 0,
    )
  ) {
    invalidCheckpoint("Checkpoint visitedLinks contains an invalid link");
  }

  const changes = checkpoint.changes.map((change, index) =>
    validateChange<T>(change, index),
  );

  return {
    version: 1,
    resource,
    phase: checkpoint.phase,
    ...(baseDeltaLink === undefined ? {} : { baseDeltaLink }),
    nextLink,
    ...(pendingDeltaLink === undefined ? {} : { pendingDeltaLink }),
    pages: checkpoint.pages,
    visitedLinks: [...checkpoint.visitedLinks],
    changes,
  };
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? Math.floor(value)
    : fallback;
}

function normalizeStats(
  stats: CommitStats | void,
  received: number,
): CommitStats {
  if (!isRecord(stats)) {
    return {
      received,
      applied: received,
      ignored: 0,
      inserted: 0,
      updated: 0,
      removed: 0,
      resurrected: 0,
    };
  }

  const ignored = count(stats.ignored, 0);
  return {
    received: count(stats.received, received),
    applied: count(stats.applied, Math.max(0, received - ignored)),
    ignored,
    inserted: count(stats.inserted, 0),
    updated: count(stats.updated, 0),
    removed: count(stats.removed, 0),
    resurrected: count(stats.resurrected, 0),
  };
}

/**
 * Consumes an OData delta feed.
 *
 * The component buffers a complete round in memory and calls `store.commit`
 * exactly once, with both the changes and the new deltaLink. If a page fetch,
 * page parse, or commit fails, the persisted cursor remains at the previous
 * deltaLink. A retry resumes at the failed nextLink (or commit) in the same
 * round; a checkpoint can carry that state to another process.
 */
export class ODataDeltaSync<T extends ODataEntity = ODataEntity> {
  private readonly store: DeltaStore<T>;
  private readonly resource: string;
  private readonly fetcher: DeltaPageFetcher;
  private readonly getId: DeltaSyncOptions<T>["getId"];
  private readonly getVersion: DeltaSyncOptions<T>["getVersion"];
  private readonly compare: VersionComparator;
  private readonly initialLink: string | undefined;
  private readonly maxPages: number;
  private readonly onPage: DeltaSyncOptions<T>["onPage"];

  private active: ActiveRound<T> | undefined;
  private inFlight: Promise<SyncResult> | undefined;

  constructor(options: DeltaSyncOptions<T>) {
    if (!isRecord(options) || options.store === undefined) {
      throw new DeltaSyncError(
        "Delta sync requires a store",
        "INVALID_OPTIONS",
        { resumable: false },
      );
    }

    const resource = (options.resource ?? "default").trim();
    if (resource.length === 0) {
      throw new DeltaSyncError(
        "Delta sync resource must not be empty",
        "INVALID_OPTIONS",
        { resumable: false },
      );
    }

    const maxPages = options.maxPages ?? 10_000;
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new DeltaSyncError(
        "maxPages must be a positive integer",
        "INVALID_OPTIONS",
        { resumable: false },
      );
    }

    this.store = options.store;
    this.resource = resource;
    this.getId = options.getId ?? options.getKey;
    this.getVersion = options.getVersion;
    this.compare = options.compareVersions ?? compareServerVersions;
    this.maxPages = maxPages;
    this.onPage = options.onPage;
    this.initialLink = trimLink(
      options.initialLink ?? options.startLink ?? options.deltaLink,
    );
    this.fetcher =
      options.fetchPage ??
      options.fetch ??
      this.createGlobalFetcher(options, resource);
  }

  get resourceName(): string {
    return this.resource;
  }

  /** True while a partially consumed round can be resumed. */
  get resumable(): boolean {
    return this.active !== undefined;
  }

  /**
   * Current in-flight round as a JSON-serializable checkpoint, or undefined.
   * Persist it if a process restart must continue at the failed nextLink.
   */
  get checkpoint(): DeltaCheckpoint<T> | undefined {
    return this.getCheckpoint();
  }

  getCheckpoint(): DeltaCheckpoint<T> | undefined {
    const round = this.active;
    if (round === undefined) {
      return undefined;
    }
    return {
      version: 1,
      resource: round.resource,
      phase: round.phase,
      ...(round.baseDeltaLink === undefined
        ? {}
        : { baseDeltaLink: round.baseDeltaLink }),
      nextLink: round.nextLink,
      ...(round.pendingDeltaLink === undefined
        ? {}
        : { pendingDeltaLink: round.pendingDeltaLink }),
      pages: round.pages,
      visitedLinks: [...round.visited],
      changes: round.changes.map(cloneChange),
    };
  }

  /** Alias for `getCheckpoint`. */
  exportCheckpoint(): DeltaCheckpoint<T> | undefined {
    return this.getCheckpoint();
  }

  /**
   * Restores a checkpoint from a previous process. The checkpoint only
   * contains the original chain and buffered changes; it never activates the
   * round's new deltaLink.
   */
  resume(checkpoint: DeltaCheckpoint<T>): this {
    if (this.inFlight !== undefined || this.active !== undefined) {
      throw new DeltaSyncError(
        "Cannot restore a checkpoint while another round is active",
        "BUSY",
        { resumable: false },
      );
    }

    const restored = validateCheckpoint(checkpoint, this.resource);
    this.active = {
      resource: restored.resource,
      ...(restored.baseDeltaLink === undefined
        ? {}
        : { baseDeltaLink: restored.baseDeltaLink }),
      nextLink: restored.nextLink,
      phase: restored.phase,
      ...(restored.pendingDeltaLink === undefined
        ? {}
        : { pendingDeltaLink: restored.pendingDeltaLink }),
      changes: restored.changes.map(cloneChange),
      pages: restored.pages,
      visited: new Set(restored.visitedLinks),
    };
    this.active.visited.add(restored.nextLink);
    return this;
  }

  /** Alias for `resume`. */
  resumeFromCheckpoint(checkpoint: DeltaCheckpoint<T>): this {
    return this.resume(checkpoint);
  }

  /**
   * Drops an in-flight round without changing the persisted cursor. The next
   * sync will restart from the previous deltaLink.
   */
  discardRound(): void {
    if (this.inFlight !== undefined) {
      throw new DeltaSyncError(
        "Cannot discard a round while a sync is in progress",
        "BUSY",
        { resumable: false },
      );
    }
    this.active = undefined;
  }

  /** Alias for `discardRound`. */
  reset(): void {
    this.discardRound();
  }

  /**
   * Runs or resumes a round. Concurrent calls share the same in-flight
   * operation.
   */
  sync(initialLink?: string): Promise<SyncResult> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    let tracked: Promise<SyncResult>;
    tracked = this.executeRound(initialLink).finally(() => {
      if (this.inFlight === tracked) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = tracked;
    return tracked;
  }

  /** Alias for `sync`. */
  run(initialLink?: string): Promise<SyncResult> {
    return this.sync(initialLink);
  }

  /** Alias for `sync`. */
  start(initialLink?: string): Promise<SyncResult> {
    return this.sync(initialLink);
  }

  static fromCheckpoint<T extends ODataEntity = ODataEntity>(
    options: DeltaSyncOptions<T>,
    checkpoint: DeltaCheckpoint<T>,
  ): ODataDeltaSync<T> {
    return new ODataDeltaSync<T>(options).resume(checkpoint);
  }

  private async executeRound(
    initialLinkOverride?: string,
  ): Promise<SyncResult> {
    let resumed = false;
    let round = this.active;

    if (round === undefined) {
      const cursor = await this.readCursor();
      const start =
        cursor?.deltaLink ??
        trimLink(initialLinkOverride) ??
        this.initialLink;

      if (start === undefined) {
        throw new DeltaSyncError(
          `No starting deltaLink is available for resource "${this.resource}"`,
          "NO_START_LINK",
          { resumable: false },
        );
      }

      round = {
        resource: this.resource,
        ...(cursor === undefined
          ? {}
          : { baseDeltaLink: cursor.deltaLink }),
        nextLink: start,
        phase: "fetch",
        changes: [],
        pages: 0,
        visited: new Set([start]),
      };
      this.active = round;
    } else {
      const cursor = await this.readCursor();
      const currentBase = cursor?.deltaLink;
      if (currentBase !== round.baseDeltaLink) {
        this.active = undefined;
        throw new DeltaSyncError(
          `Cursor for "${this.resource}" changed while the delta round was paused`,
          "CURSOR_CONFLICT",
          { resumable: false },
        );
      }
      resumed = true;
    }

    if (round.phase === "commit") {
      return this.commitRound(round, resumed);
    }

    while (true) {
      if (round.pages >= this.maxPages) {
        this.active = undefined;
        throw new DeltaSyncError(
          `Delta round exceeded ${this.maxPages} pages`,
          "MAX_PAGES",
          { resumable: false, url: round.nextLink },
        );
      }

      const url = round.nextLink;
      const body = await this.fetchBody(url);
      const page = parseDeltaPage<T>(body, {
        url,
        ...(this.getId === undefined ? {} : { getId: this.getId }),
        ...(this.getVersion === undefined
          ? {}
          : { getVersion: this.getVersion }),
      });

      round.pages += 1;
      round.changes.push(...page.changes);

      if (this.onPage !== undefined) {
        await this.onPage(clonePage(page), url, round.pages);
      }

      if (page.nextLink !== undefined) {
        if (round.visited.has(page.nextLink)) {
          this.active = undefined;
          throw new DeltaSyncError(
            `Delta nextLink chain loops back to ${page.nextLink}`,
            "DELTA_LOOP",
            { resumable: false, url: page.nextLink },
          );
        }
        round.visited.add(page.nextLink);
        round.nextLink = page.nextLink;
        continue;
      }

      if (page.deltaLink !== undefined) {
        round.pendingDeltaLink = page.deltaLink;
        round.phase = "commit";
        return this.commitRound(round, resumed);
      }

      throw new DeltaSyncError(
        `Delta page at ${url} has neither @odata.nextLink nor @odata.deltaLink`,
        "MISSING_DELTA_LINK",
        { resumable: true, url, page: round.pages },
      );
    }
  }

  private async readCursor(): Promise<DeltaCursor | undefined> {
    let cursor: DeltaCursor | undefined;
    try {
      cursor = await this.store.getCursor(this.resource);
    } catch (error) {
      throw new DeltaSyncError(
        `Failed to read the delta cursor for "${this.resource}"`,
        "CURSOR_READ_FAILED",
        { resumable: true, cause: error },
      );
    }

    if (cursor === undefined || cursor === null) {
      return undefined;
    }
    if (!isRecord(cursor)) {
      this.active = undefined;
      throw new DeltaSyncError(
        `Stored cursor for "${this.resource}" is not an object`,
        "CURSOR_READ_FAILED",
        { resumable: false },
      );
    }
    const deltaLink = trimLink(cursor.deltaLink);
    if (deltaLink === undefined) {
      this.active = undefined;
      throw new DeltaSyncError(
        `Stored cursor for "${this.resource}" has no deltaLink`,
        "CURSOR_READ_FAILED",
        { resumable: false },
      );
    }
    return { deltaLink };
  }

  private async fetchBody(url: string): Promise<unknown> {
    let response: unknown;
    try {
      response = await this.fetcher(url);
    } catch (error) {
      throw new DeltaSyncError(
        `Failed to fetch delta page ${url}`,
        "FETCH_FAILED",
        { resumable: true, url, cause: error },
      );
    }

    if (!isResponseLike(response)) {
      return response;
    }

    const status = response.status;
    if (response.ok === false || (status !== undefined && status >= 400)) {
      const description =
        typeof response.statusText === "string" &&
        response.statusText.length > 0
          ? ` ${response.statusText}`
          : "";
      throw new DeltaSyncError(
        `Delta page request failed with HTTP ${String(status)}${description}: ${url}`,
        "HTTP_ERROR",
        { resumable: true, url },
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new DeltaSyncError(
        `Delta page at ${url} did not contain valid JSON`,
        "INVALID_PAGE",
        { resumable: true, url, cause: error },
      );
    }
  }

  private async commitRound(
    round: ActiveRound<T>,
    resumed: boolean,
  ): Promise<SyncResult> {
    const deltaLink = round.pendingDeltaLink;
    if (deltaLink === undefined) {
      throw new DeltaSyncError(
        "Cannot commit a delta round without a deltaLink",
        "INVALID_CHECKPOINT",
        { resumable: false },
      );
    }

    let rawStats: CommitStats | void;
    try {
      rawStats = await this.store.commit(
        this.resource,
        round.changes,
        { deltaLink },
        {
          compareVersions: this.compare,
          expectedBaseDeltaLink: round.baseDeltaLink ?? null,
        },
      );
    } catch (error) {
      if (
        error instanceof DeltaSyncError &&
        error.code === "CURSOR_CONFLICT"
      ) {
        this.active = undefined;
        throw error;
      }
      throw new DeltaSyncError(
        `Failed to atomically commit ${round.changes.length} change(s) and the deltaLink for "${this.resource}"`,
        "COMMIT_FAILED",
        { resumable: true, cause: error },
      );
    }

    const result: SyncResult = {
      resource: this.resource,
      deltaLink,
      ...(round.baseDeltaLink === undefined
        ? {}
        : { baseDeltaLink: round.baseDeltaLink }),
      pages: round.pages,
      changes: round.changes.length,
      stats: normalizeStats(rawStats, round.changes.length),
      resumed,
    };

    this.active = undefined;
    return result;
  }

  private createGlobalFetcher(
    options: DeltaSyncOptions<T>,
    resource: string,
  ): DeltaPageFetcher {
    const globalFetch = (
      globalThis as {
        fetch?: (
          input: string,
          init?: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).fetch;

    if (typeof globalFetch !== "function") {
      throw new DeltaSyncError(
        `No fetchPage was supplied for "${resource}" and global fetch is unavailable`,
        "NO_FETCHER",
        { resumable: false },
      );
    }

    const requestInit = options.requestInit;
    const requestHeaders = isRecord(requestInit?.headers)
      ? requestInit.headers
      : {};
    const init: Record<string, unknown> = {
      ...(options.requestInit ?? {}),
      headers: {
        Accept: "application/json",
        ...requestHeaders,
        ...(options.headers ?? {}),
      },
    };

    return (url: string) => globalFetch.call(globalThis, url, init);
  }
}

export { ODataDeltaSync as DeltaSync };
export { ODataDeltaSync as DeltaSynchronizer };
