/**
 * A value that may be returned synchronously or through a promise.
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * A server-assigned, monotonically increasing version.
 *
 * Strings are useful for ISO-8601 timestamps and opaque ETags. The default
 * comparator understands ordinary integers and numeric ETags (for example
 * `W/"12"`); supply `compareVersions` for other version schemes.
 */
export type ServerVersion = string | number | bigint;

/**
 * An entity as it appears in an OData payload. Annotation properties such as
 * `@odata.id` and `@odata.etag` are retained.
 *
 * `any` is intentional here: it keeps ordinary interfaces (which do not have
 * an index signature) assignable to the generic entity parameter.
 */
export type ODataEntity = Record<string, any>;

export type IdSelector = (
  entry: ODataEntity,
) => string | number | bigint | null | undefined;

export type VersionSelector = (
  entry: ODataEntity,
) => ServerVersion | null | undefined;

export type VersionComparator = (
  incoming: ServerVersion,
  existing: ServerVersion,
) => number;

/**
 * An entity that was added or changed in a delta page.
 */
export interface DeltaUpdate<T extends ODataEntity = ODataEntity> {
  readonly kind: "update";
  readonly id: string;
  readonly version?: ServerVersion;
  /**
   * The complete entity from the delta payload. No fields are stripped so the
   * caller can decide how to map the entity into its own domain model.
   */
  readonly entity: T;
}

/**
 * A tombstone from `@removed`.
 */
export interface DeltaRemoval {
  readonly kind: "removed";
  readonly id: string;
  readonly version?: ServerVersion;
  readonly reason?: string;
}

/** Alias matching the OData terminology used in the requirements. */
export type DeltaTombstone = DeltaRemoval;

export type DeltaChange<T extends ODataEntity = ODataEntity> =
  | DeltaUpdate<T>
  | DeltaRemoval;

export interface ParsedDeltaPage<T extends ODataEntity = ODataEntity> {
  readonly changes: readonly DeltaChange<T>[];
  readonly nextLink?: string;
  readonly deltaLink?: string;
  readonly raw: unknown;
}

/**
 * A durable view of one entity. Removed entities deliberately remain in the
 * store as tombstones so a late, older update cannot resurrect them.
 */
export interface EntityRecord<T extends ODataEntity = ODataEntity> {
  readonly id: string;
  readonly version?: ServerVersion;
  readonly deleted: boolean;
  readonly entity?: T;
  readonly removalReason?: string;
}

export interface CommitStats {
  readonly received: number;
  readonly applied: number;
  readonly ignored: number;
  readonly inserted: number;
  readonly updated: number;
  readonly removed: number;
  readonly resurrected: number;
}

/**
 * The only cursor that may become visible after a complete delta round.
 */
export interface DeltaCursor {
  readonly deltaLink: string;
}

export interface CommitOptions {
  /**
   * Comparator used while merging this batch. Stores that persist the
   * decision themselves should honor it.
   */
  readonly compareVersions?: VersionComparator;
  /**
   * Optimistic concurrency check. A string requires the stored cursor to be
   * exactly that value; `null` requires no stored cursor. `undefined` skips
   * the check.
   */
  readonly expectedBaseDeltaLink?: string | null;
}

/**
 * Storage contract used by the synchronizer.
 *
 * `commit` MUST apply every change and the new cursor in one transaction. If
 * it throws, neither the records nor the cursor may be changed. The engine
 * never updates a cursor independently from the records.
 */
export interface DeltaStore<T extends ODataEntity = ODataEntity> {
  getCursor(resource: string): Awaitable<DeltaCursor | undefined>;
  commit(
    resource: string,
    changes: readonly DeltaChange<T>[],
    cursor: DeltaCursor,
    options?: CommitOptions,
  ): Awaitable<CommitStats | void>;
}

/**
 * Fetches a delta page. The function may return either a parsed JSON value or
 * a Response-like object exposing `json()` and optionally `ok`/`status`.
 */
export type DeltaPageFetcher = (url: string) => Awaitable<unknown>;

export interface ParseDeltaPageOptions {
  readonly getId?: IdSelector;
  /** Alias for `getId`. */
  readonly getKey?: IdSelector;
  readonly getVersion?: VersionSelector;
  readonly url?: string;
}

export interface DeltaSyncOptions<T extends ODataEntity = ODataEntity> {
  /** Storage that atomically commits records and the delta cursor. */
  readonly store: DeltaStore<T>;
  readonly resource?: string;
  readonly fetchPage?: DeltaPageFetcher;
  /** Alias for `fetchPage`. */
  readonly fetch?: DeltaPageFetcher;
  /** Used only when the store has no cursor yet. */
  readonly initialLink?: string;
  /** Alias for `initialLink`. */
  readonly startLink?: string;
  /** Alias for `initialLink`. */
  readonly deltaLink?: string;
  readonly getId?: IdSelector;
  /** Alias for `getId`. */
  readonly getKey?: IdSelector;
  readonly getVersion?: VersionSelector;
  readonly compareVersions?: VersionComparator;
  /** Headers used by the built-in global-fetch transport. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Additional options passed to the built-in global-fetch transport. */
  readonly requestInit?: Readonly<Record<string, unknown>>;
  /** Safety valve against a malformed, non-terminating nextLink chain. */
  readonly maxPages?: number;
  readonly onPage?: (
    page: ParsedDeltaPage<T>,
    url: string,
    pageNumber: number,
  ) => Awaitable<void>;
}

/**
 * A JSON-serializable snapshot of an in-flight round. It is not a cursor:
 * restoring it lets a new process continue the *original* nextLink chain
 * without exposing the round's eventual deltaLink.
 */
export interface DeltaCheckpoint<T extends ODataEntity = ODataEntity> {
  readonly version: 1;
  readonly resource: string;
  readonly phase: "fetch" | "commit";
  readonly baseDeltaLink?: string;
  readonly nextLink: string;
  readonly pendingDeltaLink?: string;
  readonly pages: number;
  readonly visitedLinks: readonly string[];
  readonly changes: readonly DeltaChange<T>[];
}

export interface SyncResult {
  readonly resource: string;
  readonly deltaLink: string;
  readonly baseDeltaLink?: string;
  readonly pages: number;
  readonly changes: number;
  readonly stats: CommitStats;
  /** True when this call resumed an in-flight round or checkpoint. */
  readonly resumed: boolean;
}

export interface MemoryDeltaStoreOptions {
  readonly compareVersions?: VersionComparator;
}
