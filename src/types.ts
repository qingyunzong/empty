export type ResumeToken = unknown;

export type Document = Record<string, unknown>;

export interface Namespace {
  db: string;
  coll: string;
}

export interface DocumentKey {
  _id?: unknown;
  [key: string]: unknown;
}

export interface UpdateDescription {
  updatedFields?: Record<string, unknown>;
  removedFields?: string[];
  truncatedArrays?: Array<{ field: string; newSize: number }>;
  [key: string]: unknown;
}

/**
 * The subset of a MongoDB change stream event that this library understands.
 * Unknown fields are retained so callers can pass the raw driver event
 * straight through.
 */
export interface ChangeStreamEvent {
  _id?: ResumeToken;
  resumeToken?: ResumeToken;
  operationType: string;
  clusterTime?: unknown;
  wallTime?: unknown;
  ns?: Namespace | string;
  to?: Namespace | string;
  documentKey?: DocumentKey;
  fullDocument?: Document | null;
  fullDocumentBeforeChange?: Document | null;
  updateDescription?: UpdateDescription;
  lsid?: unknown;
  txnNumber?: unknown;
  [key: string]: unknown;
}

export type GenerationReason =
  | "initial"
  | "invalidate"
  | "history-lost"
  | "manual"
  | "snapshot";

export type GenerationStatus =
  | "live"
  | "snapshot-required"
  | "snapshotting"
  | "closed";

export interface SnapshotGeneration {
  number: number;
  id: string;
  reason: GenerationReason;
  status: GenerationStatus;
  startedAt: Date;
  snapshotStartedAt: Date | null;
  completedAt: Date | null;
  closedAt: Date | null;
  entryResumeToken: ResumeToken | null;
  /** The last token committed while this generation was active. */
  resumeToken: ResumeToken | null;
  tokenAtSnapshot: ResumeToken | null;
  previousResumeToken: ResumeToken | null;
  abandonedBatches: number;
  committedBatches: number;
  cause: unknown;
}

export type TransactionKey = string;

export interface TransactionDescriptor {
  key: TransactionKey;
  lsid?: unknown;
  txnNumber?: unknown;
  sequence: number;
  eventCount: number;
}

export interface GenerationTransition {
  from: SnapshotGeneration;
  to: SnapshotGeneration;
  reason: GenerationReason;
  at: Date;
  previousResumeToken: ResumeToken | null;
  abandonedBatchIds: number[];
  cause: unknown;
}

export type BatchKind = "events" | "transaction" | "control";
export type BatchStatus =
  | "pending"
  | "acknowledged"
  | "committed"
  | "abandoned"
  | "rejected";

export interface BatchControl {
  type: "invalidate" | "history-lost" | "snapshot-required";
  resumeToken: ResumeToken | null;
  previousGeneration: number;
  nextGeneration: number;
  reason: GenerationReason;
  at: Date;
}

export interface OutputEvent {
  operationType: string;
  /** Effective namespace after applying known renames. */
  namespace: Namespace | null;
  /** Original namespace carried by the event when it differs from namespace. */
  previousNamespace: Namespace | null;
  documentKey: DocumentKey | null;
  resumeToken: ResumeToken | null;
  eventTime: unknown;
  eventTimeMs: number | null;
  wallTime: unknown;
  wallTimeMs: number | null;
  fullDocument?: Document | null;
  fullDocumentBeforeChange?: Document | null;
  updateDescription?: UpdateDescription;
  transaction?: TransactionDescriptor;
  renamed?: boolean;
  /** Set by fullDocument lookup. */
  readTime?: Date;
  readTimeMs?: number;
  fullDocumentLookup?: FullDocumentLookupEvidence;
  fullDocumentEvidence?: FullDocumentLookupEvidence;
  raw: ChangeStreamEvent;
}

export interface OutputBatch {
  /** Monotonically increasing local batch ID. */
  id: number;
  generation: number;
  kind: BatchKind;
  status: BatchStatus;
  events: OutputEvent[];
  /**
   * Token representing the last event in this batch. It is not committed
   * until this batch is acknowledged.
   */
  token: ResumeToken | null;
  transactionKey: TransactionKey | null;
  control?: BatchControl;
  createdAt: Date;
  acknowledgedAt?: Date;
  committedAt?: Date;
}

export interface AcknowledgeResult {
  batchId: number;
  accepted: boolean;
  alreadyAcknowledged: boolean;
  committed: boolean;
  committedBatchIds: number[];
  committedToken: ResumeToken | null;
  waitingFor: number[];
  reason?: string;
}

export interface SnapshotCompleteOptions {
  resumeToken?: ResumeToken;
  readTime?: Date;
  startAt?: Date;
}

export interface SnapshotBeginOptions {
  startAt?: Date;
  entryResumeToken?: ResumeToken;
}

export interface NewGenerationOptions {
  at?: Date;
  cause?: unknown;
  entryResumeToken?: ResumeToken;
}

export interface PushOptions {
  fullDocumentLookup?: FullDocumentLookupEvidence;
}

export interface ChangeStreamStateOptions {
  resumeToken?: ResumeToken;
  clock?: () => Date;
  /**
   * When true (the default), a non-transaction event or a different
   * transaction closes any currently open transaction units. This matches
   * the contiguous way change stream transaction events are normally
   * delivered. Set to false when the caller will explicitly call
   * `flushTransaction`/`flush`.
   */
  autoFlushTransactions?: boolean;
  idFactory?: (generation: number) => string;
}

export type FullDocumentSource = "event" | "lookup" | "none";

export interface LookupContext {
  event: ChangeStreamEvent;
  namespace: Namespace | null;
  documentKey: DocumentKey | null;
  eventTime: unknown;
  readTime: Date;
  resumeToken: ResumeToken | null;
}

export type LookupFunction = (
  context: LookupContext,
) => Document | null | Promise<Document | null>;

export interface FindOneLookup {
  findOne: (
    filter: DocumentKey,
    options?: Record<string, unknown>,
  ) => Document | null | Promise<Document | null>;
}

export type LookupSource =
  | LookupFunction
  | FindOneLookup
  | Document
  | null
  | undefined;

export interface FullDocumentResolveOptions {
  clock?: () => Date;
  readTime?: Date;
  versionOf?: (document: Document) => unknown;
  /** Look up even when the event already carries a fullDocument. */
  force?: boolean;
  /** Throw when a lookup is required but no lookup source was supplied. */
  requireLookup?: boolean;
  namespace?: Namespace | null;
}

export interface PreservedDocumentEvidence {
  time: unknown;
  timeMs: number | null;
  document: Document | null;
  version: unknown;
  versionComparable: number | null;
}

export interface FullDocumentLookupEvidence {
  /** Document selected for downstream output. */
  document: Document | null;
  source: FullDocumentSource;
  /** The time at which the change happened (event clusterTime/wallTime). */
  eventTime: unknown;
  eventTimeMs: number | null;
  wallTime: unknown;
  wallTimeMs: number | null;
  /** The time at which the lookup was performed. */
  readTime: Date;
  readTimeMs: number;
  readStartedAt: Date;
  readCompletedAt: Date;
  eventDocument: Document | null;
  readDocument: Document | null;
  documentAtEvent: Document | null;
  documentAtRead: Document | null;
  eventVersion: unknown;
  readVersion: unknown;
  eventVersionComparable: number | null;
  readVersionComparable: number | null;
  /** True when the lookup document's version is newer than event time. */
  newerThanEvent: boolean;
  /** Alias kept for callers that phrase the condition this way. */
  lookupNewer: boolean;
  /** The event-time document is stale relative to the lookup result. */
  stale: boolean;
  versionComparison: "newer" | "same" | "older" | "unknown";
  /**
   * Both evidence points are always retained, including both documents and
   * both timestamps, even when the lookup document wins.
   */
  preserved: {
    event: PreservedDocumentEvidence;
    read: PreservedDocumentEvidence;
  };
}
