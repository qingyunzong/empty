/**
 * Consistent, restartable GraphQL connection pagination.
 *
 * The collector treats every pass as a candidate snapshot. A pass is accepted
 * only when it reaches `hasNextPage: false` without crossing a detected
 * insert/delete/cursor boundary. Every accepted node is keyed by a stable key,
 * and every distinct content observation for that key is retained as a
 * revision generation.
 */

export type CursorToken = string;

export interface ConnectionEdge<TNode, TCursor extends string = string> {
  readonly cursor: TCursor;
  readonly node: TNode;
}

export interface ConnectionPageInfo<TCursor extends string = string> {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage?: boolean;
  readonly startCursor?: TCursor | null;
  readonly endCursor?: TCursor | null;
  readonly totalCount?: number | null;
  readonly snapshotToken?: string | number | null;
}

export interface ConnectionSnapshot {
  readonly token?: string | number | null;
}

/**
 * The fetcher may declare a drift it already knows about. This is useful for
 * APIs which expose mutation counters or explicit invalidation markers.
 */
export interface PageDriftHint {
  readonly inserted?: boolean | readonly string[];
  readonly deleted?: boolean | readonly string[];
  readonly cursorInvalidated?: boolean;
  readonly reason?: string;
  readonly details?: unknown;
}

/**
 * A page in Relay connection shape. `nodes` is accepted as a convenience when
 * each node carries a `cursor` field (or a `cursorOf` option is supplied).
 */
export interface ConnectionPage<TNode, TCursor extends string = string> {
  readonly edges?: ReadonlyArray<ConnectionEdge<TNode, TCursor>> | null;
  readonly nodes?: ReadonlyArray<TNode> | null;
  readonly pageInfo: ConnectionPageInfo<TCursor>;
  readonly snapshotToken?: string | number | null;
  readonly snapshot?: string | ConnectionSnapshot | null;
  readonly drift?: PageDriftHint | null;
  /** Alias for `drift`, matching APIs that call the field `changes`. */
  readonly changes?: PageDriftHint | null;
}

export interface PageRequest<TCursor extends string = string> {
  /** Exclusive lower cursor. `null` means the beginning of the connection. */
  readonly after: TCursor | null;
  readonly first: number;
  /** Snapshot token pinned for this pass, or `null` on its first page. */
  readonly snapshotToken: string | null;
  /** 1-based collection pass. Pass 1 is the initial attempt. */
  readonly pass: number;
  /** 1-based page number inside the pass. */
  readonly page: number;
  /** True on the first request of a pass created after a restart. */
  readonly restart: boolean;
  readonly signal?: AbortSignal;
}

export type PageFetcher<TNode, TCursor extends string = string> = (
  request: PageRequest<TCursor>,
) => Promise<ConnectionPage<TNode, TCursor>> | ConnectionPage<TNode, TCursor>;

export interface NodeContext<TNode, TCursor extends string = string> {
  readonly pass: number;
  readonly page: number;
  readonly index: number;
  readonly cursor: TCursor | null;
  readonly edge: ConnectionEdge<TNode, TCursor> | null;
}

export type NodeKeySelector<TNode, TCursor extends string = string> = (
  node: TNode,
  context: NodeContext<TNode, TCursor>,
) => string;

export type ContentFingerprint<TNode, TCursor extends string = string> = (
  node: TNode,
  context: NodeContext<TNode, TCursor>,
) => string | number;

/**
 * Declared server capabilities. The defaults are deliberately conservative:
 * unless the server says a cursor survives an insert/delete, a detected change
 * causes a restart.
 */
export interface PaginationCapabilities {
  /** The server returns a token which pins every page to one snapshot. */
  readonly snapshotToken?: boolean;
  /** Alias for `snapshotToken`. */
  readonly supportsSnapshotToken?: boolean;
  /** Fail instead of proceeding when the first page has no snapshot token. */
  readonly requireSnapshotToken?: boolean;
  /** Cursors remain correct when a row is inserted before the cursor. */
  readonly insertStable?: boolean;
  /** Alias for `insertStable`. */
  readonly stableOnInsert?: boolean;
  /** Cursors remain correct when a row is deleted before the cursor. */
  readonly deleteStable?: boolean;
  /** Alias for `deleteStable`. */
  readonly stableOnDelete?: boolean;
  /** The backend may reject/expire an otherwise valid cursor. */
  readonly cursorCanInvalidate?: boolean;
  /** `fail` refuses a restart even when the backend invalidates a cursor. */
  readonly cursorInvalidation?: "restart" | "fail";
  /** Drift may be recovered by starting a new pass. */
  readonly restartable?: boolean;
  /** Alias for `restartable`. */
  readonly supportsRestart?: boolean;
  /** Number of restarts allowed after the initial pass. Defaults to 3. */
  readonly maxRestarts?: number;
}

export interface ResolvedPaginationCapabilities {
  readonly snapshotToken: boolean;
  readonly requireSnapshotToken: boolean;
  readonly insertStable: boolean;
  readonly deleteStable: boolean;
  readonly cursorCanInvalidate: boolean;
  readonly restartable: boolean;
  readonly maxRestarts: number;
}

export interface ConnectionPaginationOptions<TNode, TCursor extends string = string> {
  readonly fetchPage?: PageFetcher<TNode, TCursor>;
  /** Alias for `fetchPage`. */
  readonly fetch?: PageFetcher<TNode, TCursor>;
  /** Alias for `fetchPage`. */
  readonly loadPage?: PageFetcher<TNode, TCursor>;
  /**
   * Property name, dotted path, or selector returning a stable node key.
   * A selector is required for nodes without `id`/`key`/`nodeId`/`uid`.
   */
  readonly nodeKey?: (keyof TNode & string) | NodeKeySelector<TNode, TCursor> | string;
  /** Alias for `nodeKey`. */
  readonly keyOf?: (keyof TNode & string) | NodeKeySelector<TNode, TCursor> | string;
  /** Optional content identity. Defaults to a deterministic serialization. */
  readonly fingerprint?: ContentFingerprint<TNode, TCursor>;
  /** Alias for `fingerprint`. */
  readonly contentFingerprint?: ContentFingerprint<TNode, TCursor>;
  /** Used only when a page supplies `nodes` instead of `edges`. */
  readonly cursorOf?: (node: TNode, index: number) => TCursor | null | undefined;
  readonly first?: number;
  /** Alias for `first`. */
  readonly pageSize?: number;
  readonly startAfter?: TCursor | null;
  /** Alias for `startAfter`. */
  readonly after?: TCursor | null;
  readonly capabilities?: PaginationCapabilities;
  readonly requireSnapshotToken?: boolean;
  readonly maxRestarts?: number;
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
  readonly isCursorInvalidation?: (error: unknown) => boolean;
  readonly onPage?: (event: PageEvent<TNode, TCursor>) => void | Promise<void>;
  readonly onRestart?: (evidence: DriftEvidence<TCursor>) => void | Promise<void>;
}

export type DriftReason =
  | "snapshot-token-changed"
  | "snapshot-token-appeared"
  | "snapshot-token-missing"
  | "insertion-detected"
  | "deletion-detected"
  | "page-overlap"
  | "same-key-revision"
  | "cursor-invalidated"
  | "cursor-stalled"
  | "drift-declared";

export type DriftDetection =
  | "snapshot-token"
  | "total-count"
  | "duplicate-key"
  | "page-drift-hint"
  | "error"
  | "cursor-progress";

export interface DriftEvidence<TCursor extends string = string> {
  readonly index: number;
  readonly restartIndex: number | null;
  readonly action: "continue" | "restart" | "fail";
  readonly reason: DriftReason;
  readonly detectedBy: DriftDetection;
  readonly pass: number;
  readonly page: number;
  readonly requestAfter: TCursor | null;
  readonly acceptedEndCursor: TCursor | null;
  readonly snapshotTokenBefore: string | null;
  readonly snapshotTokenObserved: string | null;
  readonly totalCountBefore: number | null;
  readonly totalCountObserved: number | null;
  readonly duplicateKeys: readonly string[];
  readonly observedKeyCount: number;
  readonly observedKeys: readonly string[];
  readonly observedStartCursor: TCursor | null;
  readonly observedEndCursor: TCursor | null;
  readonly errorCode?: string;
  readonly message: string;
}

export interface PageEvent<TNode, TCursor extends string = string> {
  readonly request: PageRequest<TCursor>;
  readonly pass: number;
  readonly page: number;
  readonly snapshotToken: string | null;
  readonly startCursor: TCursor | null;
  readonly endCursor: TCursor | null;
  readonly edgeCount: number;
  readonly totalCount: number | null;
  readonly newKeys: readonly string[];
  readonly duplicateKeys: readonly string[];
  readonly revisionKeys: readonly string[];
  readonly drift: DriftEvidence<TCursor> | null;
  readonly willRestart: boolean;
  readonly checkpoint: PaginationCheckpoint<TCursor>;
}

export interface RevisionGeneration<TNode, TCursor extends string = string> {
  /** 1-based distinct-content generation for this stable key. */
  readonly generation: number;
  readonly fingerprint: string;
  readonly node: TNode;
  readonly cursor: TCursor | null;
  readonly pass: number;
  readonly page: number;
  readonly snapshotToken: string | null;
}

export interface NodeRecord<TNode, TCursor extends string = string> {
  readonly key: string;
  latest: TNode;
  latestGeneration: number;
  latestFingerprint: string;
  readonly revisions: RevisionGeneration<TNode, TCursor>[];
  /** Alias for `revisions`, using the domain term "generation". */
  readonly generations: RevisionGeneration<TNode, TCursor>[];
  sightings: number;
  firstPass: number;
  lastPass: number;
  lastCursor: TCursor | null;
  inFinalPass: boolean;
}

export interface PaginationCheckpoint<TCursor extends string = string> {
  readonly version: 1;
  readonly complete: boolean;
  readonly pass: number;
  readonly page: number;
  readonly after: TCursor | null;
  readonly endCursor: TCursor | null;
  readonly snapshotToken: string | null;
  readonly keys: readonly string[];
  readonly edgeCount: number;
}

export interface CoverageInterval<TCursor extends string = string> {
  /** Exclusive lower bound used for every pass. */
  readonly after: TCursor | null;
  /** Inclusive cursor of the first edge in the accepted pass. */
  readonly startCursor: TCursor | null;
  /** Inclusive cursor of the last edge in the accepted pass. */
  readonly endCursor: TCursor | null;
  readonly startKey: string | null;
  readonly endKey: string | null;
  readonly pageCount: number;
  /** Edge observations in the accepted pass, before stable-key deduplication. */
  readonly edgeCount: number;
  /** Distinct stable keys in the accepted pass. */
  readonly nodeCount: number;
}

export interface FinalPassSummary<TCursor extends string = string> {
  readonly pass: number;
  readonly pages: number;
  readonly edges: number;
  readonly uniqueKeys: number;
  readonly startCursor: TCursor | null;
  readonly endCursor: TCursor | null;
  readonly snapshotToken: string | null;
  /** True when one token was supplied on page 1 and stayed pinned. */
  readonly pinnedSnapshotToken: boolean;
  readonly totalCount: number | null;
}

export type CoverageConsistency =
  | "snapshot-token"
  | "declared-stable"
  | "unverified";

export interface CompletionReceipt<TCursor extends string = string> {
  readonly complete: true;
  /**
   * `snapshot-token` and `declared-stable` prove that the accepted pass
   * respected a declared consistency boundary. `unverified` means every page
   * was consumed, but the server supplied no signal capable of ruling out an
   * undetected same-count mutation.
   */
  readonly consistency: CoverageConsistency;
  readonly warnings: readonly string[];
  readonly coverage: CoverageInterval<TCursor>;
  readonly finalPass: FinalPassSummary<TCursor>;
  readonly restartCount: number;
  /** Only restarts that were actually performed. */
  readonly restarts: readonly DriftEvidence<TCursor>[];
  /** All drift decisions, including those that were safe to continue through. */
  readonly drifts: readonly DriftEvidence<TCursor>[];
  readonly duplicateSightings: number;
  readonly revisionCount: number;
  /** Keys observed before a restart but absent from the accepted pass. */
  readonly observedOnlyBeforeRestart: readonly string[];
  /** Distinct tokens returned by the server across all passes. */
  readonly snapshotTokens: readonly string[];
  readonly passCount: number;
  readonly pagesFetched: number;
  readonly observedKeyCount: number;
  readonly capabilities: ResolvedPaginationCapabilities;
}

export interface PaginationResult<TNode, TCursor extends string = string> {
  /**
   * Latest observation of every key in the accepted pass, in accepted-pass
   * order. Keys only seen in abandoned passes remain available in `records`
   * and in `receipt.observedOnlyBeforeRestart`.
   */
  readonly items: readonly TNode[];
  readonly records: readonly NodeRecord<TNode, TCursor>[];
  readonly byKey: ReadonlyMap<string, NodeRecord<TNode, TCursor>>;
  readonly receipt: CompletionReceipt<TCursor>;
  readonly checkpoint: PaginationCheckpoint<TCursor>;
}

export class PaginationError extends Error {
  code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaginationError";
    this.code = code;
  }
}

export class PaginationConfigurationError extends PaginationError {
  constructor(message: string) {
    super("PAGINATION_CONFIGURATION_ERROR", message);
    this.name = "PaginationConfigurationError";
  }
}

export class PaginationProtocolError extends PaginationError {
  constructor(message: string, code = "PAGINATION_PROTOCOL_ERROR", cause?: unknown) {
    super(code, message, { cause });
    this.name = "PaginationProtocolError";
  }
}

export class CursorInvalidationError extends PaginationError {
  readonly graphqlCode: string;

  constructor(
    message = "The pagination cursor was invalidated",
    graphqlCode = "CURSOR_INVALID",
    options?: { cause?: unknown },
  ) {
    super(graphqlCode, message, options);
    this.name = "CursorInvalidationError";
    this.graphqlCode = graphqlCode;
  }
}

export class PaginationDriftError<TCursor extends string = string> extends PaginationError {
  readonly evidence: DriftEvidence<TCursor>;
  readonly restarts: readonly DriftEvidence<TCursor>[];

  constructor(
    evidence: DriftEvidence<TCursor>,
    restarts: readonly DriftEvidence<TCursor>[],
    message?: string,
  ) {
    super(
      "PAGINATION_DRIFT",
      message ??
        `Pagination drift (${evidence.reason}) cannot be continued with the declared capabilities`,
    );
    this.name = "PaginationDriftError";
    this.evidence = evidence;
    this.restarts = restarts;
  }
}

export class PaginationCapabilityError<TCursor extends string = string> extends PaginationDriftError<TCursor> {
  constructor(evidence: DriftEvidence<TCursor>, restarts: readonly DriftEvidence<TCursor>[]) {
    super(
      evidence,
      restarts,
      `Backend violated a declared pagination capability (${evidence.reason})`,
    );
    this.name = "PaginationCapabilityError";
    this.code = "PAGINATION_CAPABILITY_VIOLATION";
  }
}

export class PaginationRestartLimitError<TCursor extends string = string> extends PaginationDriftError<TCursor> {
  readonly maxRestarts: number;

  constructor(
    evidence: DriftEvidence<TCursor>,
    restarts: readonly DriftEvidence<TCursor>[],
    maxRestarts: number,
  ) {
    super(
      evidence,
      restarts,
      `Pagination drift persisted after ${restarts.length} restart(s); limit is ${maxRestarts}`,
    );
    this.name = "PaginationRestartLimitError";
    this.code = "PAGINATION_RESTART_LIMIT";
    this.maxRestarts = maxRestarts;
  }
}

export class PaginationLimitError extends PaginationError {
  readonly pass: number;
  readonly page: number;
  readonly maxPages: number;

  constructor(pass: number, page: number, maxPages: number) {
    super(
      "PAGINATION_PAGE_LIMIT",
      `Pagination exceeded maxPages=${maxPages} in pass ${pass} at page ${page}`,
    );
    this.name = "PaginationLimitError";
    this.pass = pass;
    this.page = page;
    this.maxPages = maxPages;
  }
}

const INVALID_CURSOR_CODES = new Set([
  "BAD_CURSOR",
  "CURSOR_EXPIRED",
  "CURSOR_INVALID",
  "CURSOR_STALE",
  "INVALID_CURSOR",
  "INVALID_PAGE_CURSOR",
  "PAGE_CURSOR_INVALID",
  "PAGINATION_CURSOR_INVALID",
  "SNAPSHOT_EXPIRED",
  "SNAPSHOT_INVALID",
  "STALE_CURSOR",
]);

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly graphqlCode?: unknown;
  readonly extensions?: { readonly code?: unknown } | null;
  readonly errors?: readonly ErrorLike[] | null;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as ErrorLike;
  for (const candidate of [value.code, value.graphqlCode, value.extensions?.code]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  if (Array.isArray(value.errors)) {
    for (const nested of value.errors) {
      const code = errorCode(nested);
      if (code) return code;
    }
  }
  return null;
}

function collectErrorCodes(error: unknown, codes: string[] = []): string[] {
  if (!error || typeof error !== "object") return codes;
  const value = error as ErrorLike;
  for (const candidate of [value.code, value.graphqlCode, value.extensions?.code]) {
    if (typeof candidate === "string" && candidate.length > 0) codes.push(candidate);
  }
  if (Array.isArray(value.errors)) {
    for (const nested of value.errors) collectErrorCodes(nested, codes);
  }
  return codes;
}

function cursorErrorCode(error: unknown): string | null {
  const cursorCode = collectErrorCodes(error).find((code) =>
    INVALID_CURSOR_CODES.has(code.toUpperCase()),
  );
  return cursorCode ?? errorCode(error);
}

function isAbortLike(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
}

/** Recognizes GraphQL cursor/snapshot invalidation errors. */
export function isCursorInvalidationError(error: unknown): boolean {
  if (error instanceof CursorInvalidationError) return true;
  if (!error || typeof error !== "object") return false;
  if (
    collectErrorCodes(error).some((code) =>
      INVALID_CURSOR_CODES.has(code.toUpperCase()),
    )
  ) {
    return true;
  }
  const message = (error as ErrorLike).message;
  if (typeof message === "string" && invalidCursorMessage(message)) return true;
  if (Array.isArray((error as ErrorLike).errors)) {
    return (error as ErrorLike).errors!.some(
      (nested) =>
        typeof nested.message === "string" && invalidCursorMessage(nested.message),
    );
  }
  return false;
}

function invalidCursorMessage(message: string): boolean {
  return (
    /(?:invalid|expired|stale|bad)[\s_-]*(?:page[\s_-]*)?cursor/i.test(message) ||
    /cursor[\s_-]*(?:invalid|expired|stale|bad)/i.test(message) ||
    /snapshot[\s_-]*(?:invalid|expired|stale)/i.test(message)
  );
}

interface NormalizedEdge<TNode, TCursor extends string> {
  readonly cursor: TCursor | null;
  readonly node: TNode;
  readonly publicEdge: ConnectionEdge<TNode, TCursor> | null;
}

interface NormalizedPage<TNode, TCursor extends string> {
  readonly edges: readonly NormalizedEdge<TNode, TCursor>[];
  readonly hasNextPage: boolean;
  readonly stalled: boolean;
  readonly startCursor: TCursor | null;
  readonly endCursor: TCursor | null;
  readonly totalCount: number | null;
  readonly snapshotToken: string | null;
  readonly insertedKeys: readonly string[];
  readonly deletedKeys: readonly string[];
  readonly insertedDeclared: boolean;
  readonly deletedDeclared: boolean;
  readonly cursorInvalidatedDeclared: boolean;
}

interface PassState<TCursor extends string> {
  readonly pass: number;
  page: number;
  after: TCursor | null;
  snapshotToken: string | null;
  readonly keys: Set<string>;
  readonly order: string[];
  readonly keyFingerprints: Map<string, string>;
  edges: number;
  startCursor: TCursor | null;
  endCursor: TCursor | null;
  tokenPinnedFromStart: boolean;
  consistencyBroken: boolean;
  lastTotalCount: number | null;
  finalTotalCount: number | null;
}

interface DriftCandidate<TCursor extends string> {
  readonly reason: DriftReason;
  readonly detectedBy: DriftDetection;
  readonly duplicateKeys: readonly string[];
  readonly errorCode?: string;
  readonly message: string;
  readonly forceRestart: boolean;
  readonly capabilitySafeToContinue: boolean;
  readonly capabilityViolation: boolean;
}

interface PassDraft<TNode, TCursor extends string> {
  readonly newKeys: string[];
  readonly duplicateKeys: string[];
  readonly revisionKeys: string[];
  readonly overlapKeys: string[];
  readonly revisionOverlapKeys: string[];
}

const DEFAULT_CAPABILITIES: ResolvedPaginationCapabilities = {
  snapshotToken: true,
  requireSnapshotToken: false,
  insertStable: false,
  deleteStable: false,
  cursorCanInvalidate: true,
  restartable: true,
  maxRestarts: 3,
};

/**
 * Restartable GraphQL connection collector.
 *
 * The instance is stateless between `collect()` calls; a new collection gets a
 * fresh set of records and evidence.
 */
export class ConnectionPaginator<TNode, TCursor extends string = string> {
  readonly #options: ConnectionPaginationOptions<TNode, TCursor>;

  constructor(options: ConnectionPaginationOptions<TNode, TCursor>) {
    this.#options = options;
  }

  collect(): Promise<PaginationResult<TNode, TCursor>> {
    return collectConnection(this.#options);
  }

  paginate(): Promise<PaginationResult<TNode, TCursor>> {
    return this.collect();
  }

  run(): Promise<PaginationResult<TNode, TCursor>> {
    return this.collect();
  }
}

/**
 * Collect a GraphQL connection, restarting every time a pass crosses a
 * detected insert/delete/cursor/snapshot boundary. The returned receipt
 * contains the accepted coverage interval and all restart evidence.
 */
export async function collectConnection<TNode, TCursor extends string = string>(
  options: ConnectionPaginationOptions<TNode, TCursor>,
): Promise<PaginationResult<TNode, TCursor>> {
  const fetcher = options.fetchPage ?? options.fetch ?? options.loadPage;
  if (typeof fetcher !== "function") {
    throw new PaginationConfigurationError(
      "A fetchPage (or fetch/loadPage) function is required",
    );
  }

  const first = positiveInteger(options.first ?? options.pageSize ?? 100, "first");
  const maxPages = positiveInteger(options.maxPages ?? 100_000, "maxPages");
  const startAfter = options.startAfter ?? options.after ?? null;
  const capabilities = resolveCapabilities(options);
  const keySelector = options.nodeKey ?? options.keyOf;
  const fingerprintSelector = options.fingerprint ?? options.contentFingerprint;

  if (typeof keySelector === "function" && keySelector.length > 2) {
    throw new PaginationConfigurationError("nodeKey selector must accept (node, context)");
  }
  if (!capabilities.snapshotToken && capabilities.requireSnapshotToken) {
    throw new PaginationConfigurationError(
      "requireSnapshotToken cannot be true when snapshotToken capability is false",
    );
  }

  const records = new Map<string, NodeRecord<TNode, TCursor>>();
  const drifts: DriftEvidence<TCursor>[] = [];
  const restarts: DriftEvidence<TCursor>[] = [];
  const snapshotTokens = new Set<string>();
  let duplicateSightings = 0;
  let revisionCount = 0;
  let pagesFetched = 0;
  let passCount = 1;

  let pass = createPass<TCursor>(1, startAfter);
  const startAfterForPass = startAfter;

  for (;;) {
    const request: PageRequest<TCursor> = {
      after: pass.after,
      first,
      snapshotToken: pass.snapshotToken,
      pass: pass.pass,
      page: pass.page + 1,
      restart: pass.pass > 1 && pass.page === 0,
      signal: options.signal,
    };

    let rawPage: ConnectionPage<TNode, TCursor>;
    try {
      rawPage = await fetcher(request);
    } catch (error) {
      if (isAbortLike(error) || options.signal?.aborted) throw error;

      const customInvalidation = options.isCursorInvalidation?.(error) ?? false;
      if (!customInvalidation && !isCursorInvalidationError(error)) throw error;

      const code = cursorErrorCode(error);
      const evidence = buildEvidence({
        action: "fail",
        reason: "cursor-invalidated",
        detectedBy: "error",
        restartIndex: null,
        index: drifts.length + 1,
        pass,
        page: request.page,
        requestAfter: request.after,
        totalCountBefore: pass.lastTotalCount,
        totalCountObserved: null,
        duplicateKeys: [],
        errorCode: code ?? undefined,
        message: `Cursor invalidated while requesting page ${request.page} of pass ${pass.pass}`,
      });

      if (!capabilities.cursorCanInvalidate) {
        drifts.push({ ...evidence, action: "fail" });
        throw new PaginationCapabilityError(evidence, restarts);
      }
      if (!capabilities.restartable) {
        drifts.push({ ...evidence, action: "fail" });
        throw new PaginationDriftError(evidence, restarts);
      }
      if (restarts.length >= capabilities.maxRestarts) {
        drifts.push({ ...evidence, action: "fail" });
        throw new PaginationRestartLimitError(evidence, restarts, capabilities.maxRestarts);
      }

      const restartEvidence = buildEvidence({
        action: "restart",
        reason: "cursor-invalidated",
        detectedBy: "error",
        restartIndex: restarts.length + 1,
        index: drifts.length + 1,
        pass,
        page: request.page,
        requestAfter: request.after,
        totalCountBefore: pass.lastTotalCount,
        totalCountObserved: null,
        duplicateKeys: [],
        errorCode: code ?? undefined,
        message: `Cursor invalidated while requesting page ${request.page} of pass ${pass.pass}`,
      });
      drifts.push(restartEvidence);
      restarts.push(restartEvidence);
      await options.onRestart?.(restartEvidence);

      passCount += 1;
      pass = createPass(passCount, startAfterForPass);
      continue;
    }

    pagesFetched += 1;
    const page = normalizePage(rawPage, request, options);
    if (page.snapshotToken !== null) snapshotTokens.add(page.snapshotToken);
    if (
      pass.page === 0 &&
      page.snapshotToken === null &&
      capabilities.requireSnapshotToken
    ) {
      throw new PaginationProtocolError(
        "The first page did not provide the required snapshot token",
        "SNAPSHOT_TOKEN_REQUIRED",
      );
    }

    const tokenBefore = pass.snapshotToken;
    const totalCountBefore = pass.lastTotalCount;
    const draft = ingestPage(page, pass, records, {
      keySelector,
      fingerprintSelector,
      duplicateSightings,
      revisionCount,
    });
    duplicateSightings = draft.duplicateSightings;
    revisionCount = draft.revisionCount;

    const tokenState = updateSnapshotToken(
      pass,
      page.snapshotToken,
      capabilities,
      request.page,
    );
    const candidate = chooseDrift({
      page,
      pass,
      request,
      tokenBefore,
      tokenState,
      totalCountBefore,
      overlapKeys: draft.overlapKeys,
      revisionOverlapKeys: draft.revisionOverlapKeys,
      capabilities,
    });

    let evidence: DriftEvidence<TCursor> | null = null;
    let willRestart = false;

    if (candidate) {
      if (candidate.capabilityViolation) {
        evidence = buildEvidence({
          action: "fail",
          reason: candidate.reason,
          detectedBy: candidate.detectedBy,
          restartIndex: null,
          index: drifts.length + 1,
          pass,
          page: request.page,
          requestAfter: request.after,
          snapshotTokenBefore: tokenBefore,
          snapshotTokenObserved: page.snapshotToken,
          totalCountBefore,
          totalCountObserved: page.totalCount,
          duplicateKeys: candidate.duplicateKeys,
          errorCode: candidate.errorCode,
          message: candidate.message,
        });
        drifts.push(evidence);
        await emitPage(options, {
          request,
          pass,
          page,
          draft,
          evidence,
          willRestart: false,
          complete: false,
        });
        throw new PaginationCapabilityError(evidence, restarts);
      }

      const canContinue =
        candidate.capabilitySafeToContinue && !candidate.forceRestart;

      if (canContinue) {
        evidence = buildEvidence({
          action: "continue",
          reason: candidate.reason,
          detectedBy: candidate.detectedBy,
          restartIndex: null,
          index: drifts.length + 1,
          pass,
          page: request.page,
          requestAfter: request.after,
          snapshotTokenBefore: tokenBefore,
          snapshotTokenObserved: page.snapshotToken,
          totalCountBefore,
          totalCountObserved: page.totalCount,
          duplicateKeys: candidate.duplicateKeys,
          errorCode: candidate.errorCode,
          message: candidate.message,
        });
        drifts.push(evidence);
        pass.consistencyBroken = true;
        if (tokenState.kind === "changed" && page.snapshotToken !== null) {
          pass.snapshotToken = page.snapshotToken;
        }
      } else {
        willRestart = true;
        if (!capabilities.restartable) {
          evidence = buildEvidence({
            action: "fail",
            reason: candidate.reason,
            detectedBy: candidate.detectedBy,
            restartIndex: null,
            index: drifts.length + 1,
            pass,
            page: request.page,
            requestAfter: request.after,
            snapshotTokenBefore: tokenBefore,
            snapshotTokenObserved: page.snapshotToken,
            totalCountBefore,
            totalCountObserved: page.totalCount,
            duplicateKeys: candidate.duplicateKeys,
            errorCode: candidate.errorCode,
            message: candidate.message,
          });
          drifts.push(evidence);
          await emitPage(options, {
            request,
            pass,
            page,
            draft,
            evidence,
            willRestart: false,
            complete: false,
          });
          throw new PaginationDriftError(evidence, restarts);
        }
        if (restarts.length >= capabilities.maxRestarts) {
          evidence = buildEvidence({
            action: "fail",
            reason: candidate.reason,
            detectedBy: candidate.detectedBy,
            restartIndex: null,
            index: drifts.length + 1,
            pass,
            page: request.page,
            requestAfter: request.after,
            snapshotTokenBefore: tokenBefore,
            snapshotTokenObserved: page.snapshotToken,
            totalCountBefore,
            totalCountObserved: page.totalCount,
            duplicateKeys: candidate.duplicateKeys,
            errorCode: candidate.errorCode,
            message: candidate.message,
          });
          drifts.push(evidence);
          await emitPage(options, {
            request,
            pass,
            page,
            draft,
            evidence,
            willRestart: false,
            complete: false,
          });
          throw new PaginationRestartLimitError(
            evidence,
            restarts,
            capabilities.maxRestarts,
          );
        }

        evidence = buildEvidence({
          action: "restart",
          reason: candidate.reason,
          detectedBy: candidate.detectedBy,
          restartIndex: restarts.length + 1,
          index: drifts.length + 1,
          pass,
          page: request.page,
          requestAfter: request.after,
          snapshotTokenBefore: tokenBefore,
          snapshotTokenObserved: page.snapshotToken,
          totalCountBefore,
          totalCountObserved: page.totalCount,
          duplicateKeys: candidate.duplicateKeys,
          errorCode: candidate.errorCode,
          message: candidate.message,
        });
        drifts.push(evidence);
        restarts.push(evidence);
      }
    }

    if (willRestart) {
      const checkpoint = makeCheckpoint(pass, false);
      await options.onPage?.({
        request,
        pass: pass.pass,
        page: request.page,
        snapshotToken: page.snapshotToken,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
        edgeCount: page.edges.length,
        totalCount: page.totalCount,
        newKeys: draft.newKeys,
        duplicateKeys: draft.duplicateKeys,
        revisionKeys: draft.revisionKeys,
        drift: evidence,
        willRestart: true,
        checkpoint,
      });
      await options.onRestart?.(evidence as DriftEvidence<TCursor>);
      passCount += 1;
      pass = createPass(passCount, startAfterForPass);
      continue;
    }

    if (!page.hasNextPage) {
      const result = finish(
        pass,
        records,
        drifts,
        restarts,
        snapshotTokens,
        duplicateSightings,
        revisionCount,
        pagesFetched,
        passCount,
        startAfterForPass,
        capabilities,
      );
      await options.onPage?.({
        request,
        pass: pass.pass,
        page: request.page,
        snapshotToken: page.snapshotToken,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
        edgeCount: page.edges.length,
        totalCount: page.totalCount,
        newKeys: draft.newKeys,
        duplicateKeys: draft.duplicateKeys,
        revisionKeys: draft.revisionKeys,
        drift: evidence,
        willRestart: false,
        checkpoint: result.checkpoint,
      });
      return result;
    }

    await options.onPage?.({
      request,
      pass: pass.pass,
      page: request.page,
      snapshotToken: page.snapshotToken,
      startCursor: page.startCursor,
      endCursor: page.endCursor,
      edgeCount: page.edges.length,
      totalCount: page.totalCount,
      newKeys: draft.newKeys,
      duplicateKeys: draft.duplicateKeys,
      revisionKeys: draft.revisionKeys,
      drift: evidence,
      willRestart: false,
      checkpoint: makeCheckpoint(pass, false),
    });

    if (page.endCursor === null) {
      throw new PaginationProtocolError(
        "A page with hasNextPage=true must provide endCursor or a last edge cursor",
      );
    }
    if (pass.page >= maxPages) {
      throw new PaginationLimitError(pass.pass, pass.page, maxPages);
    }
    pass.after = page.endCursor;
  }
}

/** Alias with GraphQL-oriented naming. */
export const paginateGraphQLConnection = collectConnection;
/** Alias for callers that model this as a collection operation. */
export const collectGraphQLConnection = collectConnection;
/** Short alias. */
export const paginateConnection = collectConnection;
/** Short alias. */
export const paginate = collectConnection;
/** Short alias. */
export const collect = collectConnection;

export default collectConnection;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PaginationConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

function resolveCapabilities<TNode, TCursor extends string>(
  options: ConnectionPaginationOptions<TNode, TCursor>,
): ResolvedPaginationCapabilities {
  const raw = options.capabilities ?? {};
  const maxRestarts = options.maxRestarts ?? raw.maxRestarts ?? DEFAULT_CAPABILITIES.maxRestarts;
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
    throw new PaginationConfigurationError("maxRestarts must be a non-negative integer");
  }
  const snapshotToken =
    raw.snapshotToken ??
    raw.supportsSnapshotToken ??
    DEFAULT_CAPABILITIES.snapshotToken;
  const cursorCanInvalidate =
    raw.cursorCanInvalidate ??
    (raw.cursorInvalidation === "fail"
      ? false
      : raw.cursorInvalidation === "restart"
        ? true
        : DEFAULT_CAPABILITIES.cursorCanInvalidate);
  return {
    snapshotToken,
    requireSnapshotToken:
      options.requireSnapshotToken ??
      raw.requireSnapshotToken ??
      DEFAULT_CAPABILITIES.requireSnapshotToken,
    insertStable:
      raw.insertStable ?? raw.stableOnInsert ?? DEFAULT_CAPABILITIES.insertStable,
    deleteStable:
      raw.deleteStable ?? raw.stableOnDelete ?? DEFAULT_CAPABILITIES.deleteStable,
    cursorCanInvalidate,
    restartable:
      raw.restartable ?? raw.supportsRestart ?? DEFAULT_CAPABILITIES.restartable,
    maxRestarts,
  };
}

function createPass<TCursor extends string>(
  pass: number,
  after: TCursor | null,
): PassState<TCursor> {
  return {
    pass,
    page: 0,
    after,
    snapshotToken: null,
    keys: new Set<string>(),
    order: [],
    keyFingerprints: new Map<string, string>(),
    edges: 0,
    startCursor: null,
    endCursor: null,
    tokenPinnedFromStart: false,
    consistencyBroken: false,
    lastTotalCount: null,
    finalTotalCount: null,
  };
}

function normalizePage<TNode, TCursor extends string>(
  page: ConnectionPage<TNode, TCursor>,
  request: PageRequest<TCursor>,
  options: ConnectionPaginationOptions<TNode, TCursor>,
): NormalizedPage<TNode, TCursor> {
  if (!page || typeof page !== "object") {
    throw new PaginationProtocolError(
      `Fetcher returned a non-object page for pass ${request.pass}, page ${request.page}`,
    );
  }
  if (!page.pageInfo || typeof page.pageInfo !== "object") {
    throw new PaginationProtocolError(
      `Page ${request.page} of pass ${request.pass} has no pageInfo`,
    );
  }
  if (typeof page.pageInfo.hasNextPage !== "boolean") {
    throw new PaginationProtocolError(
      `Page ${request.page} of pass ${request.pass} has a non-boolean hasNextPage`,
    );
  }

  const startCursor = normalizeCursor<TCursor>(
    page.pageInfo.startCursor,
    "pageInfo.startCursor",
  );
  const declaredEndCursor = normalizeCursor<TCursor>(
    page.pageInfo.endCursor,
    "pageInfo.endCursor",
  );
  const totalCount = normalizeTotalCount(page.pageInfo.totalCount);
  const snapshotToken = readSnapshotToken(page);

  const edges: NormalizedEdge<TNode, TCursor>[] = [];
  if (page.edges != null) {
    if (!Array.isArray(page.edges)) {
      throw new PaginationProtocolError(
        `Page ${request.page} of pass ${request.pass} has a non-array edges field`,
      );
    }
    for (let index = 0; index < page.edges.length; index += 1) {
      const edge = page.edges[index];
      if (!edge || typeof edge !== "object") {
        throw new PaginationProtocolError(
          `Edge ${index} on page ${request.page} of pass ${request.pass} is not an object`,
        );
      }
      const cursor: TCursor | null =
        normalizeCursor<TCursor>(edge.cursor, "edge.cursor") ??
        cursorFromNode(edge.node, options.cursorOf, index);
      edges.push({
        cursor,
        node: edge.node,
        publicEdge: cursor === null ? null : { cursor, node: edge.node },
      });
    }
  } else if (page.nodes != null) {
    if (!Array.isArray(page.nodes)) {
      throw new PaginationProtocolError(
        `Page ${request.page} of pass ${request.pass} has a non-array nodes field`,
      );
    }
    for (let index = 0; index < page.nodes.length; index += 1) {
      const node = page.nodes[index] as TNode;
      const cursor = cursorFromNode(node, options.cursorOf, index);
      edges.push({
        cursor,
        node,
        publicEdge: cursor === null ? null : { cursor, node },
      });
    }
  }

  const endCursor =
    declaredEndCursor ??
    lastCursor(edges) ??
    null;
  const effectiveStartCursor = startCursor ?? firstCursor(edges);
  const stalled =
    page.pageInfo.hasNextPage &&
    (endCursor === null || endCursor === request.after);

  const hint = page.drift ?? page.changes ?? null;
  const inserted = readHintKeys(hint?.inserted);
  const deleted = readHintKeys(hint?.deleted);

  return {
    edges,
    hasNextPage: page.pageInfo.hasNextPage,
    stalled,
    startCursor: effectiveStartCursor,
    endCursor,
    totalCount,
    snapshotToken,
    insertedKeys: inserted.keys,
    deletedKeys: deleted.keys,
    insertedDeclared: inserted.present,
    deletedDeclared: deleted.present,
    cursorInvalidatedDeclared: hint?.cursorInvalidated === true,
  };
}

function normalizeCursor<TCursor extends string>(
  value: unknown,
  field: string,
): TCursor | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new PaginationProtocolError(`${field} must be a string or null`);
  }
  return value as TCursor;
}

function normalizeTotalCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PaginationProtocolError("pageInfo.totalCount must be a non-negative integer");
  }
  return value;
}

function readSnapshotToken<TNode, TCursor extends string>(
  page: ConnectionPage<TNode, TCursor>,
): string | null {
  const snapshot = page.snapshot;
  const snapshotObject =
    snapshot && typeof snapshot === "object" ? snapshot : null;
  const candidates = [
    page.snapshotToken,
    page.pageInfo.snapshotToken,
    typeof snapshot === "string" ? snapshot : snapshotObject?.token,
    (snapshotObject as { snapshotToken?: unknown } | null)?.snapshotToken,
    (snapshotObject as { id?: unknown } | null)?.id,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    if (typeof candidate === "string") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
    throw new PaginationProtocolError(
      "snapshot token must be a non-empty string or finite number",
    );
  }
  return null;
}

function cursorFromNode<TNode, TCursor extends string>(
  node: TNode,
  cursorOf: ((node: TNode, index: number) => TCursor | null | undefined) | undefined,
  index: number,
): TCursor | null {
  const selected = cursorOf?.(node, index);
  if (selected !== null && selected !== undefined && selected !== "") {
    return selected;
  }
  if (node && typeof node === "object") {
    const value = (node as { cursor?: unknown }).cursor;
    if (typeof value === "string" && value.length > 0) return value as TCursor;
  }
  return null;
}

function firstCursor<TNode, TCursor extends string>(
  edges: readonly NormalizedEdge<TNode, TCursor>[],
): TCursor | null {
  for (const edge of edges) {
    if (edge.cursor !== null) return edge.cursor;
  }
  return null;
}

function lastCursor<TNode, TCursor extends string>(
  edges: readonly NormalizedEdge<TNode, TCursor>[],
): TCursor | null {
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const cursor = edges[index].cursor;
    if (cursor !== null) return cursor;
  }
  return null;
}

function readHintKeys(
  value: boolean | readonly string[] | undefined,
): { present: boolean; keys: readonly string[] } {
  if (value === undefined || value === false) return { present: false, keys: [] };
  if (value === true) return { present: true, keys: [] };
  if (Array.isArray(value)) {
    return {
      present: true,
      keys: value.filter((key): key is string => typeof key === "string"),
    };
  }
  return { present: true, keys: [] };
}

interface IngestCounters {
  duplicateSightings: number;
  revisionCount: number;
}

interface IngestResult<TNode, TCursor extends string> extends PassDraft<TNode, TCursor> {
  duplicateSightings: number;
  revisionCount: number;
}

function ingestPage<TNode, TCursor extends string>(
  page: NormalizedPage<TNode, TCursor>,
  pass: PassState<TCursor>,
  records: Map<string, NodeRecord<TNode, TCursor>>,
  selectors: {
    keySelector:
      | (keyof TNode & string)
      | NodeKeySelector<TNode, TCursor>
      | string
      | undefined;
    fingerprintSelector: ContentFingerprint<TNode, TCursor> | undefined;
  } & IngestCounters,
): IngestResult<TNode, TCursor> {
  const newKeys: string[] = [];
  const duplicateKeys: string[] = [];
  const revisionKeys: string[] = [];
  const overlapKeys: string[] = [];
  const revisionOverlapKeys: string[] = [];

  for (let index = 0; index < page.edges.length; index += 1) {
    const edge = page.edges[index];
    const context: NodeContext<TNode, TCursor> = {
      pass: pass.pass,
      page: pass.page + 1,
      index,
      cursor: edge.cursor,
      edge: edge.publicEdge,
    };
    const key = selectKey(edge.node, context, selectors.keySelector);
    const fingerprint = selectFingerprint(
      edge.node,
      context,
      selectors.fingerprintSelector,
    );
    const seenInPass = pass.keys.has(key);
    const previousInPassFingerprint = pass.keyFingerprints.get(key);

    let record = records.get(key);
    if (!record) {
      const generation: RevisionGeneration<TNode, TCursor> = {
        generation: 1,
        fingerprint,
        node: edge.node,
        cursor: edge.cursor,
        pass: pass.pass,
        page: context.page,
        snapshotToken: page.snapshotToken,
      };
      const revisions = [generation];
      record = {
        key,
        latest: edge.node,
        latestGeneration: 1,
        latestFingerprint: fingerprint,
        revisions,
        generations: revisions,
        sightings: 1,
        firstPass: pass.pass,
        lastPass: pass.pass,
        lastCursor: edge.cursor,
        inFinalPass: false,
      };
      records.set(key, record);
      newKeys.push(key);
    } else {
      record.sightings += 1;
      if (record.latestFingerprint === fingerprint) {
        duplicateKeys.push(key);
        selectors.duplicateSightings += 1;
        if (seenInPass && previousInPassFingerprint === fingerprint) {
          overlapKeys.push(key);
        }
      } else {
        const generation: RevisionGeneration<TNode, TCursor> = {
          generation: record.revisions.length + 1,
          fingerprint,
          node: edge.node,
          cursor: edge.cursor,
          pass: pass.pass,
          page: context.page,
          snapshotToken: page.snapshotToken,
        };
        record.revisions.push(generation);
        record.latestGeneration = generation.generation;
        record.latestFingerprint = fingerprint;
        record.latest = edge.node;
        selectors.revisionCount += 1;
        revisionKeys.push(key);
        if (seenInPass) revisionOverlapKeys.push(key);
      }
      record.latest = edge.node;
      record.lastPass = pass.pass;
      record.lastCursor = edge.cursor;
    }

    if (!seenInPass) {
      pass.keys.add(key);
      pass.order.push(key);
    }
    pass.keyFingerprints.set(key, fingerprint);
    pass.edges += 1;
    if (pass.startCursor === null && edge.cursor !== null) {
      pass.startCursor = edge.cursor;
    }
  }

  pass.finalTotalCount = page.totalCount;
  pass.lastTotalCount = page.totalCount;
  if (page.endCursor !== null) pass.endCursor = page.endCursor;
  pass.page += 1;

  return {
    newKeys,
    duplicateKeys,
    revisionKeys,
    overlapKeys: uniqueStrings(overlapKeys),
    revisionOverlapKeys: uniqueStrings(revisionOverlapKeys),
    duplicateSightings: selectors.duplicateSightings,
    revisionCount: selectors.revisionCount,
  };
}

function selectKey<TNode, TCursor extends string>(
  node: TNode,
  context: NodeContext<TNode, TCursor>,
  selector:
    | (keyof TNode & string)
    | NodeKeySelector<TNode, TCursor>
    | string
    | undefined,
): string {
  let key: unknown;
  if (typeof selector === "function") {
    key = selector(node, context);
  } else if (typeof selector === "string") {
    key = readProperty(node, selector);
  } else {
    key = defaultNodeKey(node);
  }
  if (typeof key === "number" && Number.isFinite(key)) key = String(key);
  if (typeof key === "bigint") key = String(key);
  if (typeof key !== "string" || key.length === 0) {
    throw new PaginationProtocolError(
      `Node at pass ${context.pass}, page ${context.page}, index ${context.index} has no stable key`,
    );
  }
  return key;
}

function selectFingerprint<TNode, TCursor extends string>(
  node: TNode,
  context: NodeContext<TNode, TCursor>,
  selector: ContentFingerprint<TNode, TCursor> | undefined,
): string {
  if (!selector) return stableSerialize(node);
  const value = selector(node, context);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new PaginationProtocolError(
    "fingerprint selector must return a string or finite number",
  );
}

function defaultNodeKey(node: unknown): unknown {
  if (typeof node === "string" || typeof node === "number") return node;
  if (!node || typeof node !== "object") return undefined;
  const object = node as Record<string, unknown>;
  for (const property of ["id", "key", "nodeId", "uid", "stableKey"]) {
    const value = object[property];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return undefined;
}

function readProperty(node: unknown, path: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  const object = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(object, path)) return object[path];
  let current: unknown = node;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function updateSnapshotToken<TCursor extends string>(
  pass: PassState<TCursor>,
  observed: string | null,
  capabilities: ResolvedPaginationCapabilities,
  pageNumber: number,
):
  | { kind: "none" }
  | { kind: "appeared"; late: boolean }
  | { kind: "missing" }
  | { kind: "changed" } {
  if (!capabilities.snapshotToken) {
    if (observed !== null) pass.snapshotToken = observed;
    return { kind: "none" };
  }

  if (pass.snapshotToken === null) {
    if (observed === null) return { kind: "none" };
    const late = pageNumber > 1;
    pass.snapshotToken = observed;
    if (!late) pass.tokenPinnedFromStart = true;
    return late ? { kind: "appeared", late: true } : { kind: "none" };
  }

  if (observed === null) {
    pass.tokenPinnedFromStart = false;
    return { kind: "missing" };
  }
  if (observed !== pass.snapshotToken) {
    pass.tokenPinnedFromStart = false;
    return { kind: "changed" };
  }
  return { kind: "none" };
}

function chooseDrift<TNode, TCursor extends string>(args: {
  page: NormalizedPage<TNode, TCursor>;
  pass: PassState<TCursor>;
  request: PageRequest<TCursor>;
  tokenBefore: string | null;
  tokenState: ReturnType<typeof updateSnapshotToken>;
  totalCountBefore: number | null;
  overlapKeys: readonly string[];
  revisionOverlapKeys: readonly string[];
  capabilities: ResolvedPaginationCapabilities;
}): DriftCandidate<TCursor> | null {
  const {
    page,
    pass,
    request,
    tokenState,
    totalCountBefore,
    overlapKeys,
    revisionOverlapKeys,
    capabilities,
  } = args;
  const tokenChanged = tokenState.kind === "changed";
  const tokenMissing = tokenState.kind === "missing";
  const tokenAppeared = tokenState.kind === "appeared";
  const insertionSafe =
    capabilities.insertStable && (!tokenChanged || capabilities.deleteStable);
  const deletionSafe =
    capabilities.deleteStable && (!tokenChanged || capabilities.insertStable);
  const countDelta =
    totalCountBefore !== null && page.totalCount !== null
      ? page.totalCount - totalCountBefore
      : 0;

  if (page.cursorInvalidatedDeclared) {
    return {
      reason: "cursor-invalidated",
      detectedBy: "page-drift-hint",
      duplicateKeys: overlapKeys,
      message: `Page ${request.page} of pass ${pass.pass} declared its cursor invalidated`,
      forceRestart: true,
      capabilitySafeToContinue: false,
      capabilityViolation: !capabilities.cursorCanInvalidate,
    };
  }

  if (page.stalled) {
    return {
      reason: "cursor-stalled",
      detectedBy: "cursor-progress",
      duplicateKeys: overlapKeys,
      message:
        page.endCursor === null
          ? `Page ${request.page} of pass ${pass.pass} has no end cursor`
          : `Page ${request.page} of pass ${pass.pass} did not advance past ${page.endCursor}`,
      forceRestart: true,
      capabilitySafeToContinue: false,
      capabilityViolation: false,
    };
  }

  if (countDelta < 0 || page.deletedDeclared) {
    return {
      reason: "deletion-detected",
      detectedBy: countDelta < 0 ? "total-count" : "page-drift-hint",
      duplicateKeys: overlapKeys,
      message:
        countDelta < 0
          ? `totalCount fell from ${totalCountBefore} to ${page.totalCount} between pages`
          : `Page ${request.page} of pass ${pass.pass} declared a deletion${
              page.deletedKeys.length
                ? `: ${page.deletedKeys.join(", ")}`
                : ""
            }`,
      forceRestart: false,
      capabilitySafeToContinue: deletionSafe,
      capabilityViolation: false,
    };
  }

  if (countDelta > 0 || page.insertedDeclared) {
    return {
      reason: "insertion-detected",
      detectedBy: countDelta > 0 ? "total-count" : "page-drift-hint",
      duplicateKeys: overlapKeys,
      message:
        countDelta > 0
          ? `totalCount rose from ${totalCountBefore} to ${page.totalCount} between pages`
          : `Page ${request.page} of pass ${pass.pass} declared an insertion${
              page.insertedKeys.length
                ? `: ${page.insertedKeys.join(", ")}`
                : ""
            }`,
      forceRestart: false,
      capabilitySafeToContinue: insertionSafe,
      capabilityViolation: false,
    };
  }

  if (tokenChanged) {
    return {
      reason: "snapshot-token-changed",
      detectedBy: "snapshot-token",
      duplicateKeys: overlapKeys,
      message: `Snapshot token changed from ${formatToken(args.tokenBefore)} to ${formatToken(page.snapshotToken)}`,
      forceRestart: false,
      capabilitySafeToContinue:
        capabilities.insertStable && capabilities.deleteStable,
      capabilityViolation: false,
    };
  }

  if (tokenMissing) {
    return {
      reason: "snapshot-token-missing",
      detectedBy: "snapshot-token",
      duplicateKeys: overlapKeys,
      message: `Snapshot token disappeared after pass ${pass.pass} was pinned`,
      forceRestart: true,
      capabilitySafeToContinue: false,
      capabilityViolation: false,
    };
  }

  if (overlapKeys.length > 0) {
    return {
      reason: "page-overlap",
      detectedBy: "duplicate-key",
      duplicateKeys: overlapKeys,
      message: `Stable key overlap between pages: ${overlapKeys.join(", ")}`,
      forceRestart: false,
      capabilitySafeToContinue: capabilities.insertStable,
      capabilityViolation: false,
    };
  }

  if (revisionOverlapKeys.length > 0) {
    return {
      reason: "same-key-revision",
      detectedBy: "duplicate-key",
      duplicateKeys: revisionOverlapKeys,
      message: `Stable key changed between pages: ${revisionOverlapKeys.join(", ")}`,
      forceRestart: false,
      capabilitySafeToContinue: true,
      capabilityViolation: false,
    };
  }

  if (tokenAppeared) {
    return {
      reason: "snapshot-token-appeared",
      detectedBy: "snapshot-token",
      duplicateKeys: [],
      message: `Snapshot token first appeared on page ${request.page} of pass ${pass.pass}`,
      forceRestart: false,
      capabilitySafeToContinue: true,
      capabilityViolation: false,
    };
  }

  return null;
}

function formatToken(token: string | null): string {
  return token === null ? "<none>" : JSON.stringify(token);
}

function buildEvidence<TNode, TCursor extends string>(args: {
  action: "continue" | "restart" | "fail";
  reason: DriftReason;
  detectedBy: DriftDetection;
  restartIndex: number | null;
  index: number;
  pass: PassState<TCursor>;
  page: number;
  requestAfter: TCursor | null;
  snapshotTokenBefore?: string | null;
  snapshotTokenObserved?: string | null;
  totalCountBefore: number | null;
  totalCountObserved: number | null;
  duplicateKeys: readonly string[];
  errorCode?: string;
  message: string;
}): DriftEvidence<TCursor> {
  const evidence: DriftEvidence<TCursor> = {
    index: args.index,
    restartIndex: args.restartIndex,
    action: args.action,
    reason: args.reason,
    detectedBy: args.detectedBy,
    pass: args.pass.pass,
    page: args.page,
    requestAfter: args.requestAfter,
    acceptedEndCursor: args.pass.endCursor,
    snapshotTokenBefore:
      args.snapshotTokenBefore !== undefined
        ? args.snapshotTokenBefore
        : args.pass.snapshotToken,
    snapshotTokenObserved: args.snapshotTokenObserved ?? null,
    totalCountBefore: args.totalCountBefore,
    totalCountObserved: args.totalCountObserved,
    duplicateKeys: [...args.duplicateKeys],
    observedKeyCount: args.pass.order.length,
    observedKeys: [...args.pass.order],
    observedStartCursor: args.pass.startCursor,
    observedEndCursor: args.pass.endCursor,
    errorCode: args.errorCode,
    message: args.message,
  };
  return evidence;
}

async function emitPage<TNode, TCursor extends string>(
  options: ConnectionPaginationOptions<TNode, TCursor>,
  args: {
    request: PageRequest<TCursor>;
    pass: PassState<TCursor>;
    page: NormalizedPage<TNode, TCursor>;
    draft: IngestResult<TNode, TCursor>;
    evidence: DriftEvidence<TCursor> | null;
    willRestart: boolean;
    complete: boolean;
  },
): Promise<void> {
  await options.onPage?.({
    request: args.request,
    pass: args.pass.pass,
    page: args.request.page,
    snapshotToken: args.page.snapshotToken,
    startCursor: args.page.startCursor,
    endCursor: args.page.endCursor,
    edgeCount: args.page.edges.length,
    totalCount: args.page.totalCount,
    newKeys: args.draft.newKeys,
    duplicateKeys: args.draft.duplicateKeys,
    revisionKeys: args.draft.revisionKeys,
    drift: args.evidence,
    willRestart: args.willRestart,
    checkpoint: makeCheckpoint(args.pass, args.complete),
  });
}

function makeCheckpoint<TCursor extends string>(
  pass: PassState<TCursor>,
  complete: boolean,
): PaginationCheckpoint<TCursor> {
  return {
    version: 1,
    complete,
    pass: pass.pass,
    page: pass.page,
    after: pass.after,
    endCursor: pass.endCursor,
    snapshotToken: pass.snapshotToken,
    keys: [...pass.order],
    edgeCount: pass.edges,
  };
}

function finish<TNode, TCursor extends string>(
  pass: PassState<TCursor>,
  records: Map<string, NodeRecord<TNode, TCursor>>,
  drifts: DriftEvidence<TCursor>[],
  restarts: DriftEvidence<TCursor>[],
  snapshotTokens: Set<string>,
  duplicateSightings: number,
  revisionCount: number,
  pagesFetched: number,
  passCount: number,
  startAfter: TCursor | null,
  capabilities: ResolvedPaginationCapabilities,
): PaginationResult<TNode, TCursor> {
  const finalKeys = new Set(pass.order);
  const observedOnlyBeforeRestart: string[] = [];
  const allRecords = [...records.values()];

  for (const record of allRecords) {
    record.inFinalPass = finalKeys.has(record.key);
    if (!record.inFinalPass) observedOnlyBeforeRestart.push(record.key);
  }

  const items = pass.order.map((key) => {
    const record = records.get(key);
    if (!record) {
      throw new PaginationProtocolError(`Internal key ${key} disappeared from the index`);
    }
    return record.latest;
  });

  const startKey = pass.order.length > 0 ? pass.order[0] : null;
  const endKey = pass.order.length > 0 ? pass.order[pass.order.length - 1] : null;
  const coverage: CoverageInterval<TCursor> = {
    after: startAfter,
    startCursor: pass.startCursor,
    endCursor: pass.endCursor,
    startKey,
    endKey,
    pageCount: pass.page,
    edgeCount: pass.edges,
    nodeCount: pass.order.length,
  };
  const finalPass: FinalPassSummary<TCursor> = {
    pass: pass.pass,
    pages: pass.page,
    edges: pass.edges,
    uniqueKeys: pass.order.length,
    startCursor: pass.startCursor,
    endCursor: pass.endCursor,
    snapshotToken: pass.snapshotToken,
    pinnedSnapshotToken: pass.tokenPinnedFromStart && !pass.consistencyBroken,
    totalCount: pass.finalTotalCount,
  };
  const checkpoint: PaginationCheckpoint<TCursor> = {
    ...makeCheckpoint(pass, true),
    after: startAfter,
  };
  const consistency: CoverageConsistency =
    pass.tokenPinnedFromStart && !pass.consistencyBroken
      ? "snapshot-token"
      : capabilities.insertStable && capabilities.deleteStable
        ? "declared-stable"
        : "unverified";
  const warnings =
    consistency === "unverified"
      ? [
          pass.consistencyBroken
            ? "The accepted pass crossed a drift boundary that was continued; snapshot consistency could not be proven."
            : "The accepted pass has no page-1 snapshot token and does not declare both insertStable and deleteStable; same-count mutations may be undetectable.",
        ]
      : [];
  const receipt: CompletionReceipt<TCursor> = {
    complete: true,
    consistency,
    warnings,
    coverage,
    finalPass,
    restartCount: restarts.length,
    restarts: [...restarts],
    drifts: [...drifts],
    duplicateSightings,
    revisionCount,
    observedOnlyBeforeRestart,
    snapshotTokens: [...snapshotTokens],
    passCount,
    pagesFetched,
    observedKeyCount: records.size,
    capabilities,
  };

  return {
    items,
    records: allRecords,
    byKey: records,
    receipt,
    checkpoint,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Deterministic serialization used for revision detection when callers do not
 * provide a content fingerprint. Object keys are sorted; map/set entries are
 * sorted by their serialized form. Cycles are represented explicitly instead
 * of throwing.
 */
export function stableSerialize(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "NaN";
      if (Object.is(value, -0)) return "-0";
      return String(value);
    case "bigint":
      return `${String(value)}n`;
    case "symbol":
      return `Symbol(${JSON.stringify(value.description ?? "")})`;
    case "function":
      return `Function(${JSON.stringify(value.name)})`;
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) return '"[Circular]"';
  seen.add(object);
  try {
    if (object instanceof Date) {
      return `Date(${JSON.stringify(
        Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString(),
      )})`;
    }
    if (Array.isArray(object)) {
      return `[${object.map((entry) => serialize(entry, seen)).join(",")}]`;
    }
    if (object instanceof Set) {
      const entries = [...object].map((entry) => serialize(entry, seen)).sort();
      return `Set(${entries.join(",")})`;
    }
    if (object instanceof Map) {
      const entries = [...object.entries()]
        .map(([key, entry]) => `${serialize(key, seen)}=>${serialize(entry, seen)}`)
        .sort();
      return `Map(${entries.join(",")})`;
    }
    const entries = Object.keys(object as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize(
            (object as Record<string, unknown>)[key],
            seen,
          )}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}
