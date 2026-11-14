/** Public types for the subscription connection state library. */

export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "acknowledged"
  | "subscribing"
  | "subscribed"
  | "reconnecting"
  | "disconnected"
  | "closed";

export type SubscriptionStatus =
  | "pending-ack"
  | "subscribed"
  | "errored"
  | "completed"
  | "unsubscribed";

export type WatermarkMode = "contiguous" | "max";

export type ConflictPolicy = "record" | "throw";

export type Clock = () => number | Date;

export interface SubscriptionConnectionOptions {
  /**
   * Initial committed watermark. Application event versions are expected to
   * start at this value + 1. Defaults to 0.
   */
  initialWatermark?: number;
  /**
   * `contiguous` only advances across an unbroken run of acknowledged
   * versions. `max` advances to the highest acknowledged version. Defaults to
   * `contiguous`.
   */
  watermarkMode?: WatermarkMode;
  /** Clock used for audit records. Defaults to `Date.now`. */
  clock?: Clock;
  /** Alias for `clock`. */
  now?: Clock;
  /** Default keepalive timeout in milliseconds. Defaults to 30_000. */
  keepaliveTimeoutMs?: number;
  /** Alias for `keepaliveTimeoutMs`. */
  keepaliveIntervalMs?: number;
  /** Alias for `keepaliveTimeoutMs`. */
  heartbeatTimeoutMs?: number;
  /**
   * What to do when the same version arrives with different content.
   * `record` returns a conflict result, `throw` additionally throws an
   * `EventConflictError`. Defaults to `record`.
   */
  conflictPolicy?: ConflictPolicy;
  /** Shortcut for `conflictPolicy: "throw"`. */
  throwOnConflict?: boolean;
  /** Retain at most this many audit records (oldest are dropped). */
  maxAuditRecords?: number;
  /**
   * Logical stream identifier used in audit records when one is not supplied
   * by the event or subscription. Defaults to `default`.
   */
  streamId?: string;
  /**
   * Re-subscribe the previous subscription automatically on `reconnect()`.
   * Defaults to false; `resubscribe()` remains available explicitly.
   */
  autoResubscribe?: boolean;
  /** Called for each accepted application event. */
  onEvent?: (event: DeliveredEvent) => void;
  /** Called whenever a reconnect audit record is produced. */
  onReconnect?: (record: ReconnectRecord) => void;
  /** Called whenever a dedupe/conflict audit record is produced. */
  onDedupe?: (record: DedupeRecord) => void;
  /** Called when downstream acknowledgement commits a version. */
  onAck?: (result: AcknowledgeResult) => void;
}

export interface SubscriptionOptions {
  /** Optional logical stream id associated with this subscription. */
  streamId?: string;
  /** Opaque subscribe payload (query, variables, ...). */
  payload?: unknown;
}

export interface SubscribeResult {
  status: "subscribed" | "pending-ack" | "already-subscribed";
  subscriptionId: string;
  generation: number;
  streamId: string;
  /** A protocol-shaped message the caller may send on the current socket. */
  message: {
    type: "subscribe";
    id: string;
    payload?: unknown;
  };
}

export interface UnsubscribeResult {
  status: "unsubscribed" | "unknown";
  subscriptionId: string;
  generation: number;
}

export interface ConnectionAckResult {
  status: "acknowledged" | "already-acknowledged";
  generation: number;
  activeSubscriptionIds: string[];
  payload?: unknown;
}

export interface KeepaliveResult {
  status: "keepalive";
  at: number;
  count: number;
  generation: number;
}

export interface KeepaliveHealth {
  healthy: boolean;
  timedOut: boolean;
  lastKeepaliveAt: number | null;
  lastActivityAt: number | null;
  elapsedMs: number | null;
  timeoutMs: number;
  generation: number;
}

export interface AcknowledgeInput {
  version?: number;
  seq?: number;
  sequence?: number;
  eventVersion?: number;
  appVersion?: number;
  id?: string;
  subscriptionId?: string;
}

export interface AcknowledgeResult {
  status:
    | "advanced"
    | "acknowledged"
    | "already-acknowledged"
    | "unknown-version";
  version: number;
  previousWatermark: number;
  watermark: number;
  advanced: boolean;
  subscriptionId?: string;
}

export type IgnoreReason =
  | "stale-socket"
  | "disconnected"
  | "not-acknowledged"
  | "unsubscribed"
  | "missing-subscription-id"
  | "invalid-event"
  | "unknown-message";

export interface AcceptedEvent<T = unknown> {
  status: "accepted";
  version: number;
  subscriptionId: string;
  streamId: string;
  generation: number;
  payload: T;
  content: T;
  watermark: number;
  duplicate: false;
  conflict: false;
}

export interface DuplicateEvent<T = unknown> {
  status: "duplicate";
  reason: "duplicate" | "below-watermark";
  version: number;
  subscriptionId: string;
  streamId: string;
  generation: number;
  payload: T;
  content: T;
  watermark: number;
  duplicate: true;
  conflict: false;
}

export interface ConflictEvent<T = unknown> {
  status: "conflict";
  reason: "conflict";
  version: number;
  subscriptionId: string;
  streamId: string;
  generation: number;
  payload: T;
  content: T;
  existingContent: T;
  existingPayload: T;
  watermark: number;
  duplicate: false;
  conflict: true;
}

export interface IgnoredEvent {
  status: "ignored";
  reason: IgnoreReason;
  version?: number;
  subscriptionId?: string;
  streamId?: string;
  generation: number;
  watermark: number;
  duplicate: false;
  conflict: false;
}

export type EventResult<T = unknown> =
  | AcceptedEvent<T>
  | DuplicateEvent<T>
  | ConflictEvent<T>
  | IgnoredEvent;

export type MessageResult =
  | EventResult
  | ConnectionAckResult
  | AcknowledgeResult
  | KeepaliveResult
  | SubscribeResult
  | UnsubscribeResult
  | IgnoredEvent;

export interface DeliveredEvent<T = unknown> {
  version: number;
  subscriptionId: string;
  streamId: string;
  generation: number;
  payload: T;
  content: T;
  watermark: number;
}

export interface AuditRecordBase {
  sequence: number;
  at: number;
  generation: number;
  socketId?: string;
  /** Alias of `kind` for consumers that use `type` discriminators. */
  type?: string;
}

export interface ReconnectRecord extends AuditRecordBase {
  kind: "reconnect";
  previousGeneration: number;
  previousSocketId?: string;
  fromGeneration?: number;
  toGeneration?: number;
  oldSocketId?: string;
  newSocketId?: string;
  reason?: string;
  watermark: number;
}

export type DedupeReason =
  | "duplicate"
  | "below-watermark"
  | "conflict"
  | "stale-socket"
  | "disconnected"
  | "not-acknowledged"
  | "unsubscribed"
  | "missing-subscription-id"
  | "invalid-event";

export interface DedupeRecord extends AuditRecordBase {
  kind: "dedupe";
  reason: DedupeReason;
  dedupeType?: DedupeReason;
  outcome?: DedupeReason;
  streamId: string;
  subscriptionId?: string;
  version?: number;
  eventVersion?: number;
  existingContentHash?: string;
  incomingContentHash?: string;
  existingContent?: unknown;
  incomingContent?: unknown;
  existingPayload?: unknown;
  incomingPayload?: unknown;
  watermark: number;
}

export interface ConnectRecord extends AuditRecordBase {
  kind: "connect";
  previousGeneration: number;
  reason?: string;
}

export interface DisconnectRecord extends AuditRecordBase {
  kind: "disconnect";
  reason?: string;
}

export interface SubscribeRecord extends AuditRecordBase {
  kind: "subscribe" | "resubscribe" | "unsubscribe";
  subscriptionId: string;
  streamId: string;
}

export interface AckRecord extends AuditRecordBase {
  kind: "ack";
  version: number;
  previousWatermark: number;
  watermark: number;
  subscriptionId?: string;
}

export interface KeepaliveRecord extends AuditRecordBase {
  kind: "keepalive";
  count: number;
}

export interface SubscriptionRecord extends AuditRecordBase {
  kind: "subscription-error" | "subscription-complete";
  subscriptionId: string;
  error?: unknown;
}

export interface MessageRecord extends AuditRecordBase {
  kind: "ignored-message";
  messageType?: string;
  reason: IgnoreReason;
}

export type AuditRecord =
  | ReconnectRecord
  | DedupeRecord
  | ConnectRecord
  | DisconnectRecord
  | SubscribeRecord
  | AckRecord
  | KeepaliveRecord
  | SubscriptionRecord
  | MessageRecord;

export interface SubscriptionSnapshot {
  phase: ConnectionPhase;
  generation: number;
  socketId: string | null;
  acknowledged: boolean;
  subscribed: boolean;
  subscriptionId: string | null;
  activeSubscriptionIds: string[];
  watermark: number;
  pendingVersions: number[];
  streamId: string;
  lastKeepaliveAt: number | null;
  keepaliveCount: number;
  reconnectCount: number;
  dedupeCount: number;
  records: AuditRecord[];
  reconnectRecords: ReconnectRecord[];
  dedupeRecords: DedupeRecord[];
}

export interface AuditExport extends SubscriptionSnapshot {
  exportedAt: number;
  version: 1;
}

export interface SocketContext {
  generation?: number;
  socketId?: string;
}

export type SocketContextLike = SocketContext | number | string;
