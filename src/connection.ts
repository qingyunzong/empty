import { EventConflictError, InvalidEventError } from "./errors.ts";
import type {
  AckRecord,
  AcknowledgeInput,
  AcknowledgeResult,
  AuditExport,
  AuditRecord,
  Clock,
  ConflictEvent,
  ConnectionAckResult,
  ConnectionPhase,
  DedupeReason,
  DedupeRecord,
  DeliveredEvent,
  DuplicateEvent,
  EventResult,
  IgnoreReason,
  IgnoredEvent,
  KeepaliveHealth,
  KeepaliveRecord,
  KeepaliveResult,
  MessageRecord,
  MessageResult,
  ReconnectRecord,
  SocketContext,
  SocketContextLike,
  SubscribeRecord,
  SubscribeResult,
  SubscriptionConnectionOptions,
  SubscriptionOptions,
  SubscriptionSnapshot,
  SubscriptionStatus,
  UnsubscribeResult,
} from "./types.ts";
import { WatermarkTracker, isValidVersion, normalizeVersion } from "./watermark.ts";
import { cloneJson, contentHash, deepEqual, pruneUndefined } from "./util.ts";

const VERSION_KEYS = [
  "version",
  "seq",
  "sequence",
  "eventVersion",
  "appVersion",
] as const;

const EVENT_MESSAGE_TYPES = new Set([
  "next",
  "data",
  "event",
  "subscriptiondata",
]);
const ACK_MESSAGE_TYPES = new Set([
  "connectionack",
  "connectionestablished",
]);
const DOWNSTREAM_ACK_MESSAGE_TYPES = new Set([
  "ack",
  "downstreamack",
  "watermarkack",
]);
const KEEPALIVE_MESSAGE_TYPES = new Set([
  "ka",
  "keepalive",
  "connectionkeepalive",
  "keepaliveack",
  "ping",
  "pong",
  "heartbeat",
]);

interface InternalSubscription {
  id: string;
  streamId: string;
  status: SubscriptionStatus;
  payload?: unknown;
}

interface SubscriptionIntent {
  streamId: string;
  payload?: unknown;
}

interface SeenEvent {
  version: number;
  subscriptionId: string;
  streamId: string;
  generation: number;
  payload: unknown;
  content: unknown;
  hash: string;
  at: number;
}

interface ResolvedContext {
  generation: number;
  socketId?: string;
  explicit: boolean;
}

type Listener<T> = (value: T) => void;

type AuditRecordInput = AuditRecord extends infer RecordType
  ? RecordType extends AuditRecord
    ? Omit<RecordType, "sequence" | "at">
    : never
  : never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeMessageType(type: unknown): string {
  return String(type ?? "")
    .toLowerCase()
    .replace(/[-_\s]/g, "");
}

function readVersion(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of VERSION_KEYS) {
    if (value[key] !== undefined) {
      return value[key];
    }
  }
  if (isRecord(value.data)) {
    for (const key of VERSION_KEYS) {
      if (value.data[key] !== undefined) {
        return value.data[key];
      }
    }
  }
  if (isRecord(value.payload)) {
    for (const key of VERSION_KEYS) {
      if (value.payload[key] !== undefined) {
        return value.payload[key];
      }
    }
  }
  return undefined;
}

function stripVersionFields(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!(VERSION_KEYS as readonly string[]).includes(key)) {
      result[key] = item;
    }
  }
  return result;
}

interface ExtractedEvent {
  version: number;
  payload: unknown;
  content: unknown;
  subscriptionId?: string;
  streamId?: string;
}

function extractEvent(
  input: unknown,
  fallbackSubscriptionId?: string,
): ExtractedEvent | null {
  if (!isRecord(input)) {
    if (isValidVersion(input)) {
      return {
        version: input,
        payload: input,
        content: input,
        subscriptionId: fallbackSubscriptionId,
      };
    }
    return null;
  }

  const type = normalizeMessageType(input.type ?? input.kind);
  let app: unknown = input;
  let subscriptionId =
    typeof input.id === "string"
      ? input.id
      : typeof input.subscriptionId === "string"
        ? input.subscriptionId
        : fallbackSubscriptionId;
  let streamId =
    typeof input.streamId === "string" ? input.streamId : undefined;

  if (EVENT_MESSAGE_TYPES.has(type) && (input.payload !== undefined || input.data !== undefined)) {
    app = input.payload ?? input.data;
    if (isRecord(input.payload) && typeof input.payload.streamId === "string") {
      streamId = input.payload.streamId;
    }
  } else if (
    readVersion(input) === undefined &&
    isRecord(input.payload) &&
    readVersion(input.payload) !== undefined
  ) {
    app = input.payload;
  }

  const rawVersion = readVersion(app);
  if (rawVersion === undefined) {
    return null;
  }

  let version: number;
  try {
    version = normalizeVersion(rawVersion, "event version");
  } catch {
    return null;
  }

  let content = stripVersionFields(app);
  if (isRecord(app) && isRecord(app.data)) {
    const nestedVersion = readVersion(app.data);
    if (nestedVersion !== undefined && readVersion(app) === undefined) {
      content = {
        ...(stripVersionFields(app) as Record<string, unknown>),
        data: stripVersionFields(app.data),
      };
    }
  }

  return {
    version,
    payload: app,
    content,
    subscriptionId,
    streamId,
  };
}

/**
 * A single logical subscription stream. Reconnect creates a new socket
 * generation; callbacks captured from older sockets are ignored.
 */
export class SubscriptionConnection {
  static create(
    options: SubscriptionConnectionOptions = {},
  ): SubscriptionConnection {
    return new SubscriptionConnection(options);
  }

  readonly #clock: Clock;
  readonly #conflictPolicy: "record" | "throw";
  readonly #maxAuditRecords: number;
  readonly #initialWatermark: number;
  readonly #watermarkMode: "contiguous" | "max";
  readonly #defaultStreamId: string;
  readonly #autoResubscribe: boolean;

  #configuredKeepaliveTimeoutMs: number;
  #generation = 0;
  #socketId: string | undefined;
  #open = true;
  #phase: ConnectionPhase = "idle";
  #acknowledged = false;
  #ackPayload: unknown;
  #openedAt = 0;
  #lastActivityAt: number | null = null;
  #lastKeepaliveAt: number | null = null;
  #keepaliveCount = 0;
  #sequence = 0;

  #subscriptions = new Map<string, InternalSubscription>();
  #subscriptionIntents = new Map<string, SubscriptionIntent>();
  #lastSubscriptionId: string | undefined;
  #socketGenerations = new Map<string, number>();
  #watermarks = new Map<string, WatermarkTracker>();
  #seenByStream = new Map<string, Map<number, SeenEvent>>();
  #records: AuditRecord[] = [];

  #eventListeners = new Set<Listener<DeliveredEvent>>();
  #reconnectListeners = new Set<Listener<ReconnectRecord>>();
  #dedupeListeners = new Set<Listener<DedupeRecord>>();
  #ackListeners = new Set<Listener<AcknowledgeResult>>();

  constructor(options: SubscriptionConnectionOptions = {}) {
    this.#clock =
      options.clock ?? options.now ?? (() => Date.now());
    this.#conflictPolicy =
      options.throwOnConflict === true
        ? "throw"
        : options.conflictPolicy ?? "record";
    this.#initialWatermark = normalizeVersion(
      options.initialWatermark ?? 0,
      "initial watermark",
    );
    this.#watermarkMode = options.watermarkMode ?? "contiguous";
    this.#defaultStreamId = options.streamId ?? "default";
    this.#autoResubscribe = options.autoResubscribe ?? false;
    this.#configuredKeepaliveTimeoutMs = normalizeTimeout(
      options.keepaliveTimeoutMs ??
        options.keepaliveIntervalMs ??
        options.heartbeatTimeoutMs ??
        30_000,
    );
    this.#maxAuditRecords =
      options.maxAuditRecords === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.trunc(options.maxAuditRecords));
    this.#openedAt = this.#now();
    this.#lastActivityAt = this.#openedAt;
    this.#ensureStream(this.#defaultStreamId);
    if (options.onEvent) {
      this.#eventListeners.add(options.onEvent);
    }
    if (options.onReconnect) {
      this.#reconnectListeners.add(options.onReconnect);
    }
    if (options.onDedupe) {
      this.#dedupeListeners.add(options.onDedupe);
    }
    if (options.onAck) {
      this.#ackListeners.add(options.onAck);
    }
  }

  // ---------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------

  connect(socketId?: string, reason?: string): SocketSession {
    return this.#openSocket(socketId, reason, this.#generation > 0);
  }

  openSocket(socketId?: string, reason?: string): SocketSession {
    return this.#openSocket(socketId, reason, this.#generation > 0);
  }

  reconnect(
    socketIdOrOptions?:
      | string
      | {
          socketId?: string;
          reason?: string;
          resubscribe?: boolean | string;
        },
    reason?: string,
  ): SocketSession {
    const options =
      typeof socketIdOrOptions === "string" || socketIdOrOptions === undefined
        ? { socketId: socketIdOrOptions, reason }
        : socketIdOrOptions;

    const session = this.#openSocket(
      options.socketId,
      options.reason,
      true,
    );

    const shouldResubscribe =
      options.resubscribe === undefined
        ? this.#autoResubscribe
        : options.resubscribe;
    if (shouldResubscribe) {
      const subscriptionId =
        typeof shouldResubscribe === "string"
          ? shouldResubscribe
          : this.#lastSubscriptionId;
      if (subscriptionId) {
        this.resubscribe(subscriptionId);
      }
    }
    return session;
  }

  disconnect(reason?: string): void {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    this.#acknowledged = false;
    this.#phase = "closed";
    this.#subscriptions.clear();
    this.#pushRecord({
      kind: "disconnect",
      generation: this.#generation,
      socketId: this.#socketId,
      reason,
    });
  }

  close(reason?: string): void {
    this.disconnect(reason);
  }

  #openSocket(
    socketId: string | undefined,
    reason: string | undefined,
    recordReconnect: boolean,
  ): SocketSession {
    const previousGeneration = this.#generation;
    const previousSocketId = this.#socketId;
    const now = this.#now();

    this.#generation += 1;
    this.#socketId = socketId;
    this.#open = true;
    this.#acknowledged = false;
    this.#ackPayload = undefined;
    this.#openedAt = now;
    this.#lastActivityAt = now;
    this.#lastKeepaliveAt = null;
    this.#keepaliveCount = 0;
    this.#subscriptions.clear();

    if (socketId !== undefined) {
      this.#socketGenerations.set(socketId, this.#generation);
    }

    const watermark = this.watermark;
    if (recordReconnect) {
      this.#phase = "reconnecting";
      this.#pushRecord({
        kind: "reconnect",
        generation: this.#generation,
        socketId,
        previousGeneration,
        previousSocketId,
        reason,
        watermark,
      });
    } else {
      this.#phase = "connecting";
      this.#pushRecord({
        kind: "connect",
        generation: this.#generation,
        socketId,
        previousGeneration,
        reason,
      });
    }

    return new SocketSession(this, this.#generation, socketId);
  }

  // ---------------------------------------------------------------------
  // Protocol message dispatch
  // ---------------------------------------------------------------------

  handleMessage(
    message: unknown,
    context?: SocketContextLike | SocketSession,
  ): MessageResult {
    const resolvedContext = this.#resolveContext(context);
    if (!isRecord(message)) {
      return this.#ignore(
        "unknown-message",
        resolvedContext,
        undefined,
        undefined,
      );
    }

    const type = normalizeMessageType(message.type ?? message.kind);

    if (ACK_MESSAGE_TYPES.has(type)) {
      return this.#handleConnectionAck(message.payload, resolvedContext);
    }
    if (EVENT_MESSAGE_TYPES.has(type)) {
      return this.#handleApplicationEvent(
        message.payload ?? message.data ?? message,
        typeof message.id === "string"
          ? message.id
          : typeof message.subscriptionId === "string"
            ? message.subscriptionId
            : undefined,
        resolvedContext,
        typeof message.streamId === "string" ? message.streamId : undefined,
      );
    }
    if (KEEPALIVE_MESSAGE_TYPES.has(type)) {
      return this.#handleKeepalive(resolvedContext, message.payload);
    }
    if (DOWNSTREAM_ACK_MESSAGE_TYPES.has(type)) {
      const version = readVersion(message) ?? readVersion(message.payload);
      if (version !== undefined) {
        return this.acknowledge(
          { version: version as number },
          {
            subscriptionId:
              typeof message.id === "string"
                ? message.id
                : typeof message.subscriptionId === "string"
                  ? message.subscriptionId
                  : undefined,
            streamId:
              typeof message.streamId === "string"
                ? message.streamId
                : undefined,
          },
        );
      }
      return this.#handleConnectionAck(message.payload, resolvedContext);
    }
    if (type === "subscribe") {
      if (typeof message.id !== "string" || message.id.length === 0) {
        return this.#ignore(
          "missing-subscription-id",
          resolvedContext,
          undefined,
          undefined,
        );
      }
      return this.subscribe(message.id, {
        payload: message.payload,
        streamId:
          typeof message.streamId === "string" ? message.streamId : undefined,
      });
    }
    if (type === "unsubscribe") {
      return this.unsubscribe(
        typeof message.id === "string" ? message.id : undefined,
      );
    }
    if (type === "complete" || type === "completed") {
      return this.#handleSubscriptionComplete(
        typeof message.id === "string" ? message.id : this.#lastSubscriptionId,
        resolvedContext,
        message.payload,
      );
    }
    if (type === "error" || type === "subscriptionerror") {
      return this.#handleSubscriptionError(
        typeof message.id === "string" ? message.id : this.#lastSubscriptionId,
        resolvedContext,
        message.payload ?? message.error ?? message,
      );
    }
    if (readVersion(message) !== undefined) {
      return this.#handleApplicationEvent(
        message,
        undefined,
        resolvedContext,
        undefined,
      );
    }

    return this.#ignore(
      "unknown-message",
      resolvedContext,
      undefined,
      undefined,
      type,
    );
  }

  receiveMessage(
    message: unknown,
    context?: SocketContextLike | SocketSession,
  ): MessageResult {
    return this.handleMessage(message, context);
  }

  handle(
    message: unknown,
    context?: SocketContextLike | SocketSession,
  ): MessageResult {
    return this.handleMessage(message, context);
  }

  processMessage(
    message: unknown,
    context?: SocketContextLike | SocketSession,
  ): MessageResult {
    return this.handleMessage(message, context);
  }

  handleServerMessage(
    message: unknown,
    context?: SocketContextLike | SocketSession,
  ): MessageResult {
    return this.handleMessage(message, context);
  }

  dispatchMessage(
    message: unknown,
    context?: SocketContextLike | SocketSession,
  ): MessageResult {
    return this.handleMessage(message, context);
  }

  handleConnectionAck(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): ConnectionAckResult | IgnoredEvent {
    const { payload, context } = splitPayloadAndContext(
      payloadOrContext,
      maybeContext,
    );
    return this.#handleConnectionAck(payload, this.#resolveContext(context));
  }

  onConnectionAck(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): ConnectionAckResult | IgnoredEvent {
    return this.handleConnectionAck(payloadOrContext, maybeContext);
  }

  ackConnection(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): ConnectionAckResult | IgnoredEvent {
    return this.handleConnectionAck(payloadOrContext, maybeContext);
  }

  connectionAck(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): ConnectionAckResult | IgnoredEvent {
    return this.handleConnectionAck(payloadOrContext, maybeContext);
  }

  acknowledgeConnection(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): ConnectionAckResult | IgnoredEvent {
    return this.handleConnectionAck(payloadOrContext, maybeContext);
  }

  handleAck(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): ConnectionAckResult | IgnoredEvent {
    return this.handleConnectionAck(payloadOrContext, maybeContext);
  }

  #handleConnectionAck(
    payload: unknown,
    context: ResolvedContext,
  ): ConnectionAckResult | IgnoredEvent {
    const stale = this.#checkContext(context);
    if (stale) {
      return stale;
    }

    if (isRecord(payload)) {
      const timeout =
        payload.connectionTimeoutMs ?? payload.keepaliveTimeoutMs ?? payload.pingInterval;
      if (typeof timeout === "number" && timeout > 0) {
        this.#configuredKeepaliveTimeoutMs = timeout;
      }
    }

    const now = this.#now();
    this.#lastActivityAt = now;
    this.#ackPayload = payload;

    if (this.#acknowledged) {
      return {
        status: "already-acknowledged",
        generation: this.#generation,
        activeSubscriptionIds: this.activeSubscriptionIds,
        payload,
      };
    }

    this.#acknowledged = true;
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.status === "pending-ack") {
        subscription.status = "subscribed";
      }
    }
    this.#phase =
      this.activeSubscriptionIds.length > 0 ? "subscribed" : "acknowledged";

    return {
      status: "acknowledged",
      generation: this.#generation,
      activeSubscriptionIds: this.activeSubscriptionIds,
      payload,
    };
  }

  // ---------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------

  subscribe(
    subscriptionId: string,
    options: SubscriptionOptions = {},
  ): SubscribeResult {
    return this.#addSubscription(subscriptionId, options, "subscribe");
  }

  startSubscription(
    subscriptionId: string,
    options: SubscriptionOptions = {},
  ): SubscribeResult {
    return this.subscribe(subscriptionId, options);
  }

  addSubscription(
    subscriptionId: string,
    options: SubscriptionOptions = {},
  ): SubscribeResult {
    return this.subscribe(subscriptionId, options);
  }

  openSubscription(
    subscriptionId: string,
    options: SubscriptionOptions = {},
  ): SubscribeResult {
    return this.subscribe(subscriptionId, options);
  }

  onSubscribe(
    subscriptionId: string,
    options: SubscriptionOptions = {},
  ): SubscribeResult {
    return this.subscribe(subscriptionId, options);
  }

  createSubscribeMessage(
    subscriptionId: string,
    options: SubscriptionOptions = {},
  ): { type: "subscribe"; id: string; payload?: unknown } {
    return {
      type: "subscribe",
      id: subscriptionId,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    };
  }

  createConnectionInitMessage(payload?: unknown): {
    type: "connection_init";
    payload?: unknown;
  } {
    return {
      type: "connection_init",
      ...(payload === undefined ? {} : { payload }),
    };
  }

  resubscribe(
    subscriptionId: string | undefined = this.#lastSubscriptionId,
    options: SubscriptionOptions = {},
  ): SubscribeResult {
    if (!subscriptionId) {
      throw new InvalidEventError("No subscription id available to resubscribe");
    }
    this.#subscriptions.delete(subscriptionId);
    const intent = this.#subscriptionIntents.get(subscriptionId);
    return this.#addSubscription(
      subscriptionId,
      {
        streamId: options.streamId ?? intent?.streamId,
        payload:
          options.payload === undefined ? intent?.payload : options.payload,
      },
      "resubscribe",
    );
  }

  unsubscribe(
    subscriptionId: string | undefined = this.#lastSubscriptionId,
  ): UnsubscribeResult {
    if (!subscriptionId || !this.#subscriptions.has(subscriptionId)) {
      return {
        status: "unknown",
        subscriptionId: subscriptionId ?? "",
        generation: this.#generation,
      };
    }
    const subscription = this.#subscriptions.get(subscriptionId)!;
    subscription.status = "unsubscribed";
    this.#subscriptions.delete(subscriptionId);
    this.#pushRecord({
      kind: "unsubscribe",
      generation: this.#generation,
      socketId: this.#socketId,
      subscriptionId,
      streamId: subscription.streamId,
    });
    this.#refreshPhase();
    return {
      status: "unsubscribed",
      subscriptionId,
      generation: this.#generation,
    };
  }

  stopSubscription(
    subscriptionId: string | undefined = this.#lastSubscriptionId,
  ): UnsubscribeResult {
    return this.unsubscribe(subscriptionId);
  }

  removeSubscription(
    subscriptionId: string | undefined = this.#lastSubscriptionId,
  ): UnsubscribeResult {
    return this.unsubscribe(subscriptionId);
  }

  onUnsubscribe(
    subscriptionId: string | undefined = this.#lastSubscriptionId,
  ): UnsubscribeResult {
    return this.unsubscribe(subscriptionId);
  }

  #addSubscription(
    subscriptionId: string,
    options: SubscriptionOptions,
    kind: "subscribe" | "resubscribe",
  ): SubscribeResult {
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
      throw new InvalidEventError("subscriptionId must be a non-empty string");
    }

    const existing = this.#subscriptions.get(subscriptionId);
    if (existing && existing.status !== "completed" && existing.status !== "errored") {
      return {
        status: "already-subscribed",
        subscriptionId,
        generation: this.#generation,
        streamId: existing.streamId,
        message: {
          type: "subscribe",
          id: subscriptionId,
          payload: existing.payload,
        },
      };
    }

    const intent = this.#subscriptionIntents.get(subscriptionId);
    const streamId =
      options.streamId ?? intent?.streamId ?? this.#defaultStreamId;
    const payload =
      options.payload === undefined ? intent?.payload : options.payload;
    this.#ensureStream(streamId);
    const status: SubscriptionStatus = this.#acknowledged
      ? "subscribed"
      : "pending-ack";
    this.#subscriptions.set(subscriptionId, {
      id: subscriptionId,
      streamId,
      status,
      payload,
    });
    this.#subscriptionIntents.set(subscriptionId, { streamId, payload });
    this.#lastSubscriptionId = subscriptionId;
    this.#pushRecord({
      kind,
      generation: this.#generation,
      socketId: this.#socketId,
      subscriptionId,
      streamId,
    });
    this.#refreshPhase();

    return {
      status: status === "subscribed" ? "subscribed" : "pending-ack",
      subscriptionId,
      generation: this.#generation,
      streamId,
      message: {
        type: "subscribe",
        id: subscriptionId,
        ...(payload === undefined ? {} : { payload }),
      },
    };
  }

  #handleSubscriptionComplete(
    subscriptionId: string | undefined,
    context: ResolvedContext,
    payload: unknown,
  ): EventResult | IgnoredEvent {
    const stale = this.#checkContext(context);
    if (stale) {
      return stale;
    }
    const subscription = subscriptionId
      ? this.#subscriptions.get(subscriptionId)
      : undefined;
    if (!subscription) {
      return this.#ignore(
        "unsubscribed",
        context,
        subscriptionId,
        undefined,
      );
    }
    subscription.status = "completed";
    this.#subscriptions.delete(subscription.id);
    this.#pushRecord({
      kind: "subscription-complete",
      generation: this.#generation,
      socketId: this.#socketId,
      subscriptionId: subscription.id,
      error: payload,
    });
    this.#refreshPhase();
    return this.#ignore(
      "unsubscribed",
      context,
      subscription.id,
      undefined,
    );
  }

  #handleSubscriptionError(
    subscriptionId: string | undefined,
    context: ResolvedContext,
    error: unknown,
  ): EventResult | IgnoredEvent {
    const stale = this.#checkContext(context);
    if (stale) {
      return stale;
    }
    const subscription = subscriptionId
      ? this.#subscriptions.get(subscriptionId)
      : undefined;
    if (!subscription) {
      return this.#ignore(
        "unsubscribed",
        context,
        subscriptionId,
        undefined,
      );
    }
    subscription.status = "errored";
    this.#subscriptions.delete(subscription.id);
    this.#pushRecord({
      kind: "subscription-error",
      generation: this.#generation,
      socketId: this.#socketId,
      subscriptionId: subscription.id,
      error,
    });
    this.#refreshPhase();
    return this.#ignore(
      "unsubscribed",
      context,
      subscription.id,
      undefined,
    );
  }

  // ---------------------------------------------------------------------
  // Application events, deduplication, and conflicts
  // ---------------------------------------------------------------------

  handleNext<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  handleEvent<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  handleApplicationEvent<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  receiveEvent<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  processEvent<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  ingest<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  onNext<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  onData<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  onApplicationEvent<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    return this.#handleNext(input, subscriptionIdOrContext, context);
  }

  /**
   * Process an event. If the first argument is a function it registers an
   * event listener instead, which keeps the conventional `onEvent` spelling
   * useful in both directions.
   */
  onEvent<T = unknown>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> | (() => void) {
    if (typeof input === "function") {
      return this.addEventListener("event", input as Listener<DeliveredEvent>);
    }
    return this.#handleNext<T>(input, subscriptionIdOrContext, context);
  }

  #handleNext<T>(
    input: unknown,
    subscriptionIdOrContext?: string | SocketContextLike | SocketSession,
    context?: SocketContextLike | SocketSession,
  ): EventResult<T> {
    const inputIsMessage =
      isRecord(input) &&
      EVENT_MESSAGE_TYPES.has(normalizeMessageType(input.type ?? input.kind)) &&
      (input.payload !== undefined || input.data !== undefined);

    let subscriptionId: string | undefined;
    let resolvedContext: ResolvedContext;

    if (inputIsMessage && isRecord(input)) {
      const messageSubscriptionId =
        typeof input.id === "string"
          ? input.id
          : typeof input.subscriptionId === "string"
            ? input.subscriptionId
            : undefined;
      if (messageSubscriptionId !== undefined) {
        subscriptionId = messageSubscriptionId;
        resolvedContext = this.#resolveContext(
          subscriptionIdOrContext as SocketContextLike | SocketSession | undefined,
        );
      } else if (typeof subscriptionIdOrContext === "string") {
        subscriptionId = subscriptionIdOrContext;
        resolvedContext = this.#resolveContext(context);
      } else {
        resolvedContext = this.#resolveContext(
          subscriptionIdOrContext ?? context,
        );
      }
    } else if (typeof subscriptionIdOrContext === "string") {
      subscriptionId = subscriptionIdOrContext;
      resolvedContext = this.#resolveContext(context);
    } else {
      resolvedContext = this.#resolveContext(
        subscriptionIdOrContext ?? context,
      );
    }

    const streamId =
      isRecord(input) && typeof input.streamId === "string"
        ? input.streamId
        : undefined;
    return this.#handleApplicationEvent<T>(
      input,
      subscriptionId,
      resolvedContext,
      streamId,
    );
  }

  #handleApplicationEvent<T>(
    input: unknown,
    subscriptionId: string | undefined,
    context: ResolvedContext,
    streamIdHint?: string,
  ): EventResult<T> {
    const extracted = extractEvent(input, subscriptionId);
    const stale = this.#checkContext(context, extracted);
    if (stale) {
      return stale as EventResult<T>;
    }

    if (!extracted) {
      return this.#ignore(
        "invalid-event",
        context,
        subscriptionId,
        undefined,
        undefined,
        this.#defaultStreamId,
      ) as EventResult<T>;
    }

    if (!this.#acknowledged) {
      return this.#ignore(
        "not-acknowledged",
        context,
        subscriptionId,
        extracted,
        undefined,
        extracted.streamId ?? this.#defaultStreamId,
      ) as EventResult<T>;
    }

    const effectiveSubscriptionId = extracted.subscriptionId;
    const subscription = this.#selectSubscription(effectiveSubscriptionId);
    if (!subscription) {
      return this.#ignore(
        effectiveSubscriptionId
          ? "unsubscribed"
          : "missing-subscription-id",
        context,
        effectiveSubscriptionId,
        extracted,
        undefined,
        extracted.streamId ?? this.#defaultStreamId,
      ) as EventResult<T>;
    }
    if (subscription.status !== "subscribed") {
      return this.#ignore(
        "unsubscribed",
        context,
        subscription.id,
        extracted,
        undefined,
        subscription.streamId,
      ) as EventResult<T>;
    }

    const streamId =
      streamIdHint ??
      extracted.streamId ??
      subscription.streamId ??
      this.#defaultStreamId;
    const tracker = this.#ensureStream(streamId);
    const seen = this.#seenByStream.get(streamId)!;
    const content = cloneJson(extracted.content);
    const hash = contentHash(content);
    const prior = seen.get(extracted.version);

    if (prior) {
      if (deepEqual(prior.content, content)) {
        return this.#duplicate<T>(
          prior.version > tracker.watermark ? "duplicate" : "below-watermark",
          prior.version,
          subscription.id,
          streamId,
          extracted.payload as T,
          content as T,
          context,
        );
      }

      const conflict: ConflictEvent<T> = {
        status: "conflict",
        reason: "conflict",
        version: extracted.version,
        subscriptionId: subscription.id,
        streamId,
        generation: this.#generation,
        payload: extracted.payload as T,
        content: content as T,
        existingContent: cloneJson(prior.content) as T,
        existingPayload: cloneJson(prior.payload) as T,
        watermark: tracker.watermark,
        duplicate: false,
        conflict: true,
      };
      this.#recordDedupe({
        reason: "conflict",
        streamId,
        subscriptionId: subscription.id,
        version: extracted.version,
        existingContent: prior.content,
        incomingContent: content,
        existingPayload: prior.payload,
        incomingPayload: extracted.payload,
        context,
      });
      if (this.#conflictPolicy === "throw") {
        throw new EventConflictError(conflict);
      }
      return conflict;
    }

    if (extracted.version <= tracker.watermark) {
      return this.#duplicate<T>(
        "below-watermark",
        extracted.version,
        subscription.id,
        streamId,
        extracted.payload as T,
        content as T,
        context,
      );
    }

    const observed = tracker.observe(extracted.version);
    if (!observed.accepted) {
      const reason =
        observed.reason === "below-watermark"
          ? "below-watermark"
          : "duplicate";
      return this.#duplicate<T>(
        reason,
        extracted.version,
        subscription.id,
        streamId,
        extracted.payload as T,
        content as T,
        context,
      );
    }

    seen.set(extracted.version, {
      version: extracted.version,
      subscriptionId: subscription.id,
      streamId,
      generation: this.#generation,
      payload: cloneJson(extracted.payload),
      content,
      hash,
      at: this.#now(),
    });

    const accepted: DeliveredEvent<T> = {
      version: extracted.version,
      subscriptionId: subscription.id,
      streamId,
      generation: this.#generation,
      payload: extracted.payload as T,
      content: content as T,
      watermark: tracker.watermark,
    };
    for (const listener of this.#eventListeners) {
      listener(accepted as DeliveredEvent);
    }

    return {
      status: "accepted",
      ...accepted,
      duplicate: false,
      conflict: false,
    };
  }

  #selectSubscription(subscriptionId?: string): InternalSubscription | null {
    if (subscriptionId !== undefined) {
      return this.#subscriptions.get(subscriptionId) ?? null;
    }
    const active = this.activeSubscriptionIds;
    if (active.length === 1) {
      return this.#subscriptions.get(active[0]) ?? null;
    }
    if (this.#lastSubscriptionId) {
      const last = this.#subscriptions.get(this.#lastSubscriptionId);
      if (last) {
        return last;
      }
    }
    return null;
  }

  #duplicate<T>(
    reason: "duplicate" | "below-watermark",
    version: number,
    subscriptionId: string,
    streamId: string,
    payload: T,
    content: T,
    context: ResolvedContext,
  ): DuplicateEvent<T> {
    this.#recordDedupe({
      reason,
      streamId,
      subscriptionId,
      version,
      incomingContent: content,
      context,
    });
    return {
      status: "duplicate",
      reason,
      version,
      subscriptionId,
      streamId,
      generation: this.#generation,
      payload,
      content,
      watermark: this.#ensureStream(streamId).watermark,
      duplicate: true,
      conflict: false,
    };
  }

  // ---------------------------------------------------------------------
  // Downstream acknowledgement and watermark
  // ---------------------------------------------------------------------

  acknowledge(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    let version: number;
    try {
      version = normalizeVersion(readVersion(input), "acknowledged version");
    } catch {
      return {
        status: "unknown-version",
        version: Number.NaN,
        previousWatermark: this.watermark,
        watermark: this.watermark,
        advanced: false,
        subscriptionId:
          typeof details === "string" ? details : details?.subscriptionId,
      };
    }

    const subscriptionId =
      typeof details === "string" ? details : details?.subscriptionId;
    const streamId =
      typeof details === "object" && details?.streamId
        ? details.streamId
        : this.#subscriptions.get(subscriptionId ?? "")?.streamId ??
          this.#streamForVersion(version);
    const tracker = this.#ensureStream(streamId);
    const result = tracker.acknowledge(version);

    if (
      result.status === "advanced" ||
      result.status === "acknowledged"
    ) {
      const record: AckRecord = {
        sequence: 0,
        at: this.#now(),
        generation: this.#generation,
        socketId: this.#socketId,
        kind: "ack",
        version,
        previousWatermark: result.previousWatermark,
        watermark: result.watermark,
        subscriptionId,
      };
      this.#pushRecord(record);
      for (const listener of this.#ackListeners) {
        listener(result);
      }
    }

    return { ...result, subscriptionId };
  }

  ack(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  confirm(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  confirmVersion(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  ackVersion(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  advanceWatermark(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  commit(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  acknowledgeEvent(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  handleDownstreamAck(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  onDownstreamAck(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  getWatermark(streamId = this.#defaultStreamId): number {
    return this.#ensureStream(streamId).watermark;
  }

  // ---------------------------------------------------------------------
  // Keepalive
  // ---------------------------------------------------------------------

  handleKeepalive(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): KeepaliveResult | IgnoredEvent {
    const { payload, context } = splitPayloadAndContext(
      payloadOrContext,
      maybeContext,
    );
    return this.#handleKeepalive(
      this.#resolveContext(context),
      payload,
    );
  }

  keepalive(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): KeepaliveResult | IgnoredEvent {
    return this.handleKeepalive(payloadOrContext, maybeContext);
  }

  heartbeat(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): KeepaliveResult | IgnoredEvent {
    return this.handleKeepalive(payloadOrContext, maybeContext);
  }

  onKeepalive(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): KeepaliveResult | IgnoredEvent {
    return this.handleKeepalive(payloadOrContext, maybeContext);
  }

  handleHeartbeat(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): KeepaliveResult | IgnoredEvent {
    return this.handleKeepalive(payloadOrContext, maybeContext);
  }

  onHeartbeat(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): KeepaliveResult | IgnoredEvent {
    return this.handleKeepalive(payloadOrContext, maybeContext);
  }

  recordKeepalive(
    payloadOrContext?: unknown,
    maybeContext?: SocketContextLike | SocketSession,
  ): KeepaliveResult | IgnoredEvent {
    return this.handleKeepalive(payloadOrContext, maybeContext);
  }

  #handleKeepalive(
    context: ResolvedContext,
    _payload?: unknown,
  ): KeepaliveResult | IgnoredEvent {
    const stale = this.#checkContext(context);
    if (stale) {
      return stale;
    }
    const now = this.#now();
    this.#lastKeepaliveAt = now;
    this.#lastActivityAt = now;
    this.#keepaliveCount += 1;
    this.#pushRecord({
      kind: "keepalive",
      generation: this.#generation,
      socketId: this.#socketId,
      count: this.#keepaliveCount,
    });
    return {
      status: "keepalive",
      at: now,
      count: this.#keepaliveCount,
      generation: this.#generation,
    };
  }

  checkKeepalive(
    timeoutMs = this.#configuredKeepaliveTimeoutMs,
  ): KeepaliveHealth {
    return this.checkKeepaliveAt(this.#now(), timeoutMs);
  }

  checkKeepaliveAt(
    now: number | Date,
    timeoutMs = this.#configuredKeepaliveTimeoutMs,
  ): KeepaliveHealth {
    const currentTime = now instanceof Date ? now.getTime() : now;
    const last = this.#lastActivityAt ?? this.#openedAt;
    const elapsedMs = Math.max(0, currentTime - last);
    const timedOut = elapsedMs >= timeoutMs;
    return {
      healthy: !timedOut,
      timedOut,
      lastKeepaliveAt: this.#lastKeepaliveAt,
      lastActivityAt: this.#lastActivityAt,
      elapsedMs,
      timeoutMs,
      generation: this.#generation,
    };
  }

  isKeepaliveHealthy(
    timeoutMs = this.#configuredKeepaliveTimeoutMs,
  ): boolean {
    return this.checkKeepalive(timeoutMs).healthy;
  }

  isAlive(
    timeoutMs = this.#configuredKeepaliveTimeoutMs,
  ): boolean {
    return this.isKeepaliveHealthy(timeoutMs);
  }

  touch(): number {
    const now = this.#now();
    this.#lastActivityAt = now;
    return now;
  }

  createKeepaliveMessage(): { type: "ka" } {
    return { type: "ka" };
  }

  // ---------------------------------------------------------------------
  // Listeners and audit
  // ---------------------------------------------------------------------

  addEventListener<T = DeliveredEvent>(
    type: "event" | "reconnect" | "dedupe" | "ack",
    listener: Listener<T>,
  ): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    if (type === "event") {
      this.#eventListeners.add(listener as Listener<DeliveredEvent>);
      return () => this.#eventListeners.delete(listener as Listener<DeliveredEvent>);
    }
    if (type === "reconnect") {
      this.#reconnectListeners.add(listener as Listener<ReconnectRecord>);
      return () => this.#reconnectListeners.delete(listener as Listener<ReconnectRecord>);
    }
    if (type === "dedupe") {
      this.#dedupeListeners.add(listener as Listener<DedupeRecord>);
      return () => this.#dedupeListeners.delete(listener as Listener<DedupeRecord>);
    }
    this.#ackListeners.add(listener as Listener<AcknowledgeResult>);
    return () => this.#ackListeners.delete(listener as Listener<AcknowledgeResult>);
  }

  onReconnect(
    listenerOrOptions?:
      | Listener<ReconnectRecord>
      | string
      | {
          socketId?: string;
          reason?: string;
          resubscribe?: boolean | string;
        },
  ): (() => void) | SocketSession {
    if (typeof listenerOrOptions === "function") {
      return this.addEventListener("reconnect", listenerOrOptions);
    }
    return this.reconnect(listenerOrOptions);
  }

  onDedupe(listener: Listener<DedupeRecord>): () => void {
    return this.addEventListener("dedupe", listener);
  }

  onAck(
    listenerOrInput?: Listener<AcknowledgeResult> | AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): (() => void) | AcknowledgeResult {
    if (typeof listenerOrInput === "function") {
      return this.addEventListener("ack", listenerOrInput);
    }
    return this.acknowledge(listenerOrInput ?? Number.NaN, details);
  }

  get records(): AuditRecord[] {
    return this.#records.map((record) => cloneJson(record));
  }

  get auditLog(): AuditRecord[] {
    return this.records;
  }

  get auditRecords(): AuditRecord[] {
    return this.records;
  }

  get reconnectRecords(): ReconnectRecord[] {
    return this.#records
      .filter((record): record is ReconnectRecord => record.kind === "reconnect")
      .map((record) => cloneJson(record));
  }

  get dedupeRecords(): DedupeRecord[] {
    return this.#records
      .filter((record): record is DedupeRecord => record.kind === "dedupe")
      .map((record) => cloneJson(record));
  }

  get reconnectEvents(): ReconnectRecord[] {
    return this.reconnectRecords;
  }

  get dedupeEvents(): DedupeRecord[] {
    return this.dedupeRecords;
  }

  get dedupRecords(): DedupeRecord[] {
    return this.dedupeRecords;
  }

  get reconnectLog(): ReconnectRecord[] {
    return this.reconnectRecords;
  }

  get dedupeLog(): DedupeRecord[] {
    return this.dedupeRecords;
  }

  getReconnectRecords(): ReconnectRecord[] {
    return this.reconnectRecords;
  }

  getReconnectLog(): ReconnectRecord[] {
    return this.reconnectRecords;
  }

  getDedupeRecords(): DedupeRecord[] {
    return this.dedupeRecords;
  }

  getDedupRecords(): DedupeRecord[] {
    return this.dedupeRecords;
  }

  getDedupeLog(): DedupeRecord[] {
    return this.dedupeRecords;
  }

  getAuditRecords(): AuditRecord[] {
    return this.records;
  }

  getAuditLog(): AuditRecord[] {
    return this.records;
  }

  snapshot(): SubscriptionSnapshot {
    return {
      phase: this.#phase,
      generation: this.#generation,
      socketId: this.#socketId ?? null,
      acknowledged: this.#acknowledged,
      subscribed: this.subscribed,
      subscriptionId: this.subscriptionId,
      activeSubscriptionIds: this.activeSubscriptionIds,
      watermark: this.watermark,
      pendingVersions: this.pendingVersions,
      streamId: this.#defaultStreamId,
      lastKeepaliveAt: this.#lastKeepaliveAt,
      keepaliveCount: this.#keepaliveCount,
      reconnectCount: this.reconnectCount,
      dedupeCount: this.dedupeCount,
      records: this.records,
      reconnectRecords: this.reconnectRecords,
      dedupeRecords: this.dedupeRecords,
    };
  }

  exportAudit(): AuditExport {
    return {
      version: 1,
      exportedAt: this.#now(),
      ...this.snapshot(),
    };
  }

  getAuditTrail(): AuditExport {
    return this.exportAudit();
  }

  reviewAudit(): string {
    return JSON.stringify(this.exportAudit(), null, 2);
  }

  toJSON(): AuditExport {
    return this.exportAudit();
  }

  clearAudit(): void {
    this.#records = [];
    this.#sequence = 0;
  }

  // ---------------------------------------------------------------------
  // Read-only state
  // ---------------------------------------------------------------------

  get phase(): ConnectionPhase {
    return this.#phase;
  }

  get generation(): number {
    return this.#generation;
  }

  get socketId(): string | undefined {
    return this.#socketId;
  }

  get socketGeneration(): number {
    return this.#generation;
  }

  get connectionGeneration(): number {
    return this.#generation;
  }

  get epoch(): number {
    return this.#generation;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get acknowledged(): boolean {
    return this.#acknowledged;
  }

  get isAcknowledged(): boolean {
    return this.#acknowledged;
  }

  get connected(): boolean {
    return this.#open && this.#acknowledged;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get subscribed(): boolean {
    return this.activeSubscriptionIds.length > 0;
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }

  get subscriptionId(): string | null {
    const active = this.activeSubscriptionIds;
    if (active.length > 0) {
      return active[0];
    }
    return this.#lastSubscriptionId ?? null;
  }

  get lastSubscriptionId(): string | null {
    return this.#lastSubscriptionId ?? null;
  }

  get currentSubscriptionId(): string | null {
    return this.subscriptionId;
  }

  get activeSubscriptionIds(): string[] {
    return [...this.#subscriptions.values()]
      .filter((subscription) => subscription.status === "subscribed")
      .map((subscription) => subscription.id);
  }

  get subscriptionIds(): string[] {
    return [...this.#subscriptions.keys()];
  }

  get watermark(): number {
    return this.#ensureStream(this.#defaultStreamId).watermark;
  }

  get watermarkValue(): number {
    return this.watermark;
  }

  get pendingAckVersions(): number[] {
    return this.pendingVersions;
  }

  get pendingVersions(): number[] {
    return this.#ensureStream(this.#defaultStreamId).pendingVersions;
  }

  get lastKeepaliveAt(): number | null {
    return this.#lastKeepaliveAt;
  }

  get lastActivityAt(): number | null {
    return this.#lastActivityAt;
  }

  get keepaliveCount(): number {
    return this.#keepaliveCount;
  }

  get reconnectCount(): number {
    return this.#records.filter((record) => record.kind === "reconnect").length;
  }

  get dedupeCount(): number {
    return this.#records.filter((record) => record.kind === "dedupe").length;
  }

  get conflictCount(): number {
    return this.#records.filter(
      (record) => record.kind === "dedupe" && record.reason === "conflict",
    ).length;
  }

  get ackPayload(): unknown {
    return this.#ackPayload;
  }

  isSocketActive(generation: number): boolean {
    return this.#open && generation === this.#generation;
  }

  // ---------------------------------------------------------------------
  // Intervals
  // ---------------------------------------------------------------------

  #now(): number {
    const value = this.#clock();
    return value instanceof Date ? value.getTime() : value;
  }

  #ensureStream(streamId: string): WatermarkTracker {
    let tracker = this.#watermarks.get(streamId);
    if (!tracker) {
      tracker = new WatermarkTracker({
        initial: this.#initialWatermark,
        mode: this.#watermarkMode,
      });
      this.#watermarks.set(streamId, tracker);
    }
    if (!this.#seenByStream.has(streamId)) {
      this.#seenByStream.set(streamId, new Map());
    }
    return tracker;
  }

  #streamForVersion(version: number): string {
    for (const [streamId, seen] of this.#seenByStream) {
      if (seen.has(version)) {
        return streamId;
      }
    }
    return this.#defaultStreamId;
  }

  #refreshPhase(): void {
    if (!this.#open) {
      this.#phase = "closed";
      return;
    }
    if (!this.#acknowledged) {
      if (this.#subscriptions.size > 0) {
        this.#phase = "subscribing";
      } else {
        this.#phase = this.#phase === "idle" ? "idle" : "connecting";
      }
      return;
    }
    this.#phase = this.subscribed ? "subscribed" : "acknowledged";
  }

  #resolveContext(
    context?: SocketContextLike | SocketSession,
  ): ResolvedContext {
    if (context === undefined) {
      return {
        generation: this.#generation,
        socketId: this.#socketId,
        explicit: false,
      };
    }
    if (context instanceof SocketSession) {
      return {
        generation: context.generation,
        socketId: context.socketId,
        explicit: true,
      };
    }
    if (typeof context === "number") {
      return {
        generation: context,
        socketId: this.#socketId,
        explicit: true,
      };
    }
    if (typeof context === "string") {
      const knownGeneration = this.#socketGenerations.get(context);
      return {
        generation: knownGeneration ?? this.#generation,
        socketId: context,
        explicit: true,
      };
    }
    if (typeof context === "object" && context !== null) {
      const socketId = context.socketId;
      const knownGeneration =
        socketId !== undefined
          ? this.#socketGenerations.get(socketId)
          : undefined;
      return {
        generation: context.generation ?? knownGeneration ?? this.#generation,
        socketId: socketId ?? this.#socketId,
        explicit: true,
      };
    }
    return {
      generation: this.#generation,
      socketId: this.#socketId,
      explicit: false,
    };
  }

  #checkContext(
    context: ResolvedContext,
    extracted?: ExtractedEvent | null,
  ): IgnoredEvent | null {
    if (context.generation !== this.#generation) {
      return this.#ignore(
        "stale-socket",
        context,
        extracted?.subscriptionId,
        extracted ?? undefined,
        undefined,
        extracted?.streamId ?? this.#defaultStreamId,
      );
    }
    if (!this.#open) {
      return this.#ignore(
        "disconnected",
        context,
        extracted?.subscriptionId,
        extracted ?? undefined,
        undefined,
        extracted?.streamId ?? this.#defaultStreamId,
      );
    }
    this.#lastActivityAt = this.#now();
    return null;
  }

  #ignore(
    reason: IgnoreReason,
    context: ResolvedContext,
    subscriptionId: string | undefined,
    extracted: ExtractedEvent | undefined,
    messageType?: string,
    streamId = this.#defaultStreamId,
  ): IgnoredEvent {
    if (reason === "unknown-message" && messageType !== undefined) {
      const record: MessageRecord = {
        sequence: 0,
        at: this.#now(),
        generation: this.#generation,
        socketId: context.socketId,
        kind: "ignored-message",
        messageType,
        reason,
      };
      this.#pushRecord(record);
    } else if (reason !== "unknown-message") {
      this.#recordDedupe({
        reason: reason as DedupeReason,
        streamId,
        subscriptionId: extracted?.subscriptionId ?? subscriptionId,
        version: extracted?.version,
        incomingContent: extracted?.content,
        context,
      });
    }

    return {
      status: "ignored",
      reason,
      version: extracted?.version,
      subscriptionId: extracted?.subscriptionId ?? subscriptionId,
      streamId,
      generation: this.#generation,
      watermark: this.#ensureStream(streamId).watermark,
      duplicate: false,
      conflict: false,
    };
  }

  #recordDedupe(input: {
    reason: DedupeReason;
    streamId: string;
    subscriptionId?: string;
    version?: number;
    existingContent?: unknown;
    incomingContent?: unknown;
    existingPayload?: unknown;
    incomingPayload?: unknown;
    context?: ResolvedContext;
  }): DedupeRecord {
    const record: DedupeRecord = {
      sequence: 0,
      at: this.#now(),
      generation: this.#generation,
      socketId: input.context?.socketId ?? this.#socketId,
      kind: "dedupe",
      reason: input.reason,
      streamId: input.streamId,
      subscriptionId: input.subscriptionId,
      version: input.version,
      watermark: this.#ensureStream(input.streamId).watermark,
    };
    if (input.existingContent !== undefined) {
      record.existingContent = cloneJson(input.existingContent);
      record.existingContentHash = contentHash(input.existingContent);
    }
    if (input.incomingContent !== undefined) {
      record.incomingContent = cloneJson(input.incomingContent);
      record.incomingContentHash = contentHash(input.incomingContent);
    }
    if (input.existingPayload !== undefined) {
      record.existingPayload = cloneJson(input.existingPayload);
    }
    if (input.incomingPayload !== undefined) {
      record.incomingPayload = cloneJson(input.incomingPayload);
    }
    const pushed = this.#pushRecord(record) as DedupeRecord | undefined;
    for (const listener of this.#dedupeListeners) {
      listener(cloneJson(pushed ?? record));
    }
    return pushed ?? record;
  }

  #pushRecord(
    record: AuditRecordInput &
      Partial<Pick<AuditRecord, "sequence" | "at">>,
  ): AuditRecord | undefined {
    const completed = record as unknown as AuditRecord;
    completed.sequence = ++this.#sequence;
    if (completed.at === undefined) {
      completed.at = this.#now();
    }
    completed.type = completed.kind;
    if (completed.kind === "reconnect") {
      completed.fromGeneration = completed.previousGeneration;
      completed.toGeneration = completed.generation;
      completed.oldSocketId = completed.previousSocketId;
      completed.newSocketId = completed.socketId;
    }
    if (completed.kind === "dedupe") {
      completed.dedupeType = completed.reason;
      completed.outcome = completed.reason;
      completed.eventVersion = completed.version;
    }
    const clean = pruneUndefined(completed);
    if (this.#records.length >= this.#maxAuditRecords && this.#maxAuditRecords > 0) {
      this.#records.shift();
    } else if (this.#maxAuditRecords === 0) {
      return undefined;
    }
    this.#records.push(clean);
    if (clean.kind === "reconnect") {
      for (const listener of this.#reconnectListeners) {
        listener(cloneJson(clean));
      }
    }
    return clean;
  }
}

/**
 * A handle to one concrete socket generation. Messages delivered through this
 * handle after a reconnect are rejected as `stale-socket`, which is the
 * primary guard against late events from the previous connection.
 */
export class SocketSession {
  readonly generation: number;
  readonly socketId: string | undefined;
  readonly #connection: SubscriptionConnection;

  constructor(
    connection: SubscriptionConnection,
    generation: number,
    socketId: string | undefined,
  ) {
    this.#connection = connection;
    this.generation = generation;
    this.socketId = socketId;
  }

  get active(): boolean {
    return this.#connection.isSocketActive(this.generation);
  }

  get isCurrent(): boolean {
    return this.active;
  }

  get connection(): SubscriptionConnection {
    return this.#connection;
  }

  get watermark(): number {
    return this.#connection.watermark;
  }

  get acknowledged(): boolean {
    return this.#connection.acknowledged;
  }

  get subscribed(): boolean {
    return this.#connection.subscribed;
  }

  get records(): AuditRecord[] {
    return this.#connection.records;
  }

  get reconnectRecords(): ReconnectRecord[] {
    return this.#connection.reconnectRecords;
  }

  get dedupeRecords(): DedupeRecord[] {
    return this.#connection.dedupeRecords;
  }

  get source(): SocketContext {
    return { generation: this.generation, socketId: this.socketId };
  }

  handleMessage(
    message: unknown,
  ): MessageResult {
    return this.#connection.handleMessage(message, this);
  }

  receiveMessage(
    message: unknown,
  ): MessageResult {
    return this.handleMessage(message);
  }

  onMessage(
    message: unknown,
  ): MessageResult {
    return this.handleMessage(message);
  }

  dispatch(
    message: unknown,
  ): MessageResult {
    return this.handleMessage(message);
  }

  handleConnectionAck(
    payload?: unknown,
  ): ConnectionAckResult | IgnoredEvent {
    return this.#connection.handleConnectionAck(payload, this);
  }

  handleNext<T = unknown>(
    payload: unknown,
    subscriptionId?: string,
  ): EventResult<T> {
    return this.#connection.handleNext<T>(payload, subscriptionId, this);
  }

  handleKeepalive(payload?: unknown): KeepaliveResult | IgnoredEvent {
    return this.#connection.handleKeepalive(payload, this);
  }

  subscribe(subscriptionId: string, options: SubscriptionOptions = {}): SubscribeResult {
    return this.#connection.subscribe(subscriptionId, options);
  }

  resubscribe(
    subscriptionId?: string,
    options: SubscriptionOptions = {},
  ): SubscribeResult {
    return this.#connection.resubscribe(subscriptionId, options);
  }

  unsubscribe(subscriptionId?: string): UnsubscribeResult {
    return this.#connection.unsubscribe(subscriptionId);
  }

  acknowledge(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.#connection.acknowledge(input, details);
  }

  ack(
    input: AcknowledgeInput | number | string,
    details?: string | { subscriptionId?: string; streamId?: string },
  ): AcknowledgeResult {
    return this.acknowledge(input, details);
  }

  snapshot(): SubscriptionSnapshot {
    return this.#connection.snapshot();
  }

  exportAudit(): AuditExport {
    return this.#connection.exportAudit();
  }

  reconnect(
    socketIdOrOptions?:
      | string
      | {
          socketId?: string;
          reason?: string;
          resubscribe?: boolean | string;
        },
    reason?: string,
  ): SocketSession {
    return this.#connection.reconnect(socketIdOrOptions, reason);
  }

  disconnect(reason?: string): void {
    this.#connection.disconnect(reason);
  }

  close(reason?: string): void {
    if (this.active) {
      this.#connection.disconnect(reason);
    }
  }
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("keepaliveTimeoutMs must be a positive finite number");
  }
  return value;
}

function isSocketContext(value: unknown): value is SocketContext | SocketSession {
  return (
    typeof value === "number" ||
    typeof value === "string" ||
    value instanceof SocketSession ||
    (isRecord(value) &&
      (typeof value.generation === "number" ||
        typeof value.socketId === "string"))
  );
}

function splitPayloadAndContext(
  payloadOrContext: unknown,
  maybeContext: SocketContextLike | SocketSession | undefined,
): { payload: unknown; context: SocketContextLike | SocketSession | undefined } {
  if (maybeContext !== undefined) {
    return { payload: payloadOrContext, context: maybeContext };
  }
  if (isSocketContext(payloadOrContext)) {
    return { payload: undefined, context: payloadOrContext };
  }
  return { payload: payloadOrContext, context: undefined };
}

// Re-exported here so consumers can import everything from one module.
export type { SocketContext } from "./types.ts";
