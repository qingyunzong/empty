import type { ConflictEvent, EventResult } from "./types.ts";

export class ConnectionStateError extends Error {
  readonly code: string;

  constructor(message: string, code = "CONNECTION_STATE_ERROR") {
    super(message);
    this.name = "ConnectionStateError";
    this.code = code;
  }
}

export class InvalidEventError extends ConnectionStateError {
  readonly version?: unknown;

  constructor(message: string, version?: unknown) {
    super(message, "INVALID_EVENT");
    this.name = "InvalidEventError";
    this.version = version;
  }
}

export class EventConflictError<T = unknown> extends ConnectionStateError {
  readonly result: ConflictEvent<T>;
  readonly version: number;
  readonly existingContent: T;
  readonly incomingContent: T;
  readonly existingPayload: T;

  constructor(result: ConflictEvent<T>) {
    super(
      `Event version ${result.version} was received with conflicting content`,
      "EVENT_CONFLICT",
    );
    this.name = "EventConflictError";
    this.result = result;
    this.version = result.version;
    this.existingContent = result.existingContent;
    this.incomingContent = result.content;
    this.existingPayload = result.existingPayload;
  }
}

export class StaleSocketError extends ConnectionStateError {
  readonly generation: number;
  readonly currentGeneration: number;
  readonly result?: EventResult;

  constructor(generation: number, currentGeneration: number, result?: EventResult) {
    super(
      `Socket generation ${generation} is stale; current generation is ${currentGeneration}`,
      "STALE_SOCKET",
    );
    this.name = "StaleSocketError";
    this.generation = generation;
    this.currentGeneration = currentGeneration;
    this.result = result;
  }
}

export class KeepaliveTimeoutError extends ConnectionStateError {
  readonly elapsedMs: number;
  readonly timeoutMs: number;

  constructor(elapsedMs: number, timeoutMs: number) {
    super(
      `Keepalive timeout: no activity for ${elapsedMs}ms (limit ${timeoutMs}ms)`,
      "KEEPALIVE_TIMEOUT",
    );
    this.name = "KeepaliveTimeoutError";
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
  }
}

/** Compatibility aliases. */
export { EventConflictError as ConflictError };
export { ConnectionStateError as SubscriptionStateError };
