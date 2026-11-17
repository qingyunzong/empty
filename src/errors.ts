import type { Endpoint } from "./types.js";

export type RouterErrorCode =
  | "CROSS_SLOT"
  | "SLOT_NOT_ASSIGNED"
  | "INVALID_REDIRECT"
  | "TOO_MANY_REDIRECTS"
  | "INDETERMINATE_EXECUTION"
  | "RETRY_EXHAUSTED"
  | "TRANSPORT_FAILED"
  | "NO_NODES"
  | "INVALID_COMMAND";

export class RedisRouterError extends Error {
  readonly code: RouterErrorCode;

  constructor(code: RouterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisRouterError";
    this.code = code;
  }
}

export class CrossSlotError extends RedisRouterError {
  readonly keys: readonly string[];
  readonly slots: readonly number[];

  constructor(command: string, keys: readonly string[], slots: readonly number[]) {
    super(
      "CROSS_SLOT",
      `${command.toUpperCase()} spans multiple hash slots (${[...new Set(slots)].join(", ")}); ` +
        `Redis Cluster multi-key commands must stay in one slot`,
    );
    this.name = "CrossSlotError";
    this.keys = keys;
    this.slots = slots;
  }
}

export class SlotNotAssignedError extends RedisRouterError {
  readonly slot: number;

  constructor(slot: number) {
    super("SLOT_NOT_ASSIGNED", `No cluster node is assigned to hash slot ${slot}`);
    this.name = "SlotNotAssignedError";
    this.slot = slot;
  }
}

export class InvalidRedirectError extends RedisRouterError {
  readonly redirect: string;

  constructor(redirect: string, message: string) {
    super("INVALID_REDIRECT", `Invalid ${redirect} redirect: ${message}`);
    this.name = "InvalidRedirectError";
    this.redirect = redirect;
  }
}

export class TooManyRedirectsError extends RedisRouterError {
  readonly redirects: number;

  constructor(redirects: number) {
    super("TOO_MANY_REDIRECTS", `Exceeded the redirect limit after ${redirects} redirects`);
    this.name = "TooManyRedirectsError";
    this.redirects = redirects;
  }
}

/**
 * The command was written to a connection but no complete reply was received.
 * The router deliberately does not retry this state, because doing so could
 * execute a non-idempotent command twice.
 */
export class IndeterminateExecutionError extends RedisRouterError {
  readonly command: string;
  readonly node: Endpoint;

  constructor(command: string, node: Endpoint, cause: unknown) {
    super(
      "INDETERMINATE_EXECUTION",
      `Execution of ${command.toUpperCase()} on ${node.host}:${node.port} is indeterminate; ` +
        `the command was not retried to avoid a duplicate execution`,
      { cause },
    );
    this.name = "IndeterminateExecutionError";
    this.command = command;
    this.node = node;
  }
}

export class RetryExhaustedError extends RedisRouterError {
  readonly attempts: number;

  constructor(command: string, attempts: number, cause: unknown) {
    super(
      "RETRY_EXHAUSTED",
      `${command.toUpperCase()} was not executed after ${attempts} safe attempts`,
      { cause },
    );
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
  }
}

/**
 * Error reply sent by Redis (`-ERR ...`). `code` is the upper-case first word
 * of the reply, for example `WRONGTYPE`, `MOVED` or `ASK`.
 */
export class RedisReplyError extends Error {
  readonly code: string;
  readonly reply: string;

  constructor(reply: string) {
    const normalized = reply.startsWith("-") ? reply.slice(1) : reply;
    super(normalized);
    this.name = "RedisReplyError";
    this.reply = normalized;
    const separator = normalized.search(/[\s]/);
    this.code = (separator < 0 ? normalized : normalized.slice(0, separator)).toUpperCase();
  }
}

/**
 * `DeliveryState` is intentionally conservative:
 *
 * - `not-sent`: the transport is certain that no byte reached the server.
 *   Retrying is safe and is the only automatic transport retry the router does.
 * - `unknown`: bytes may have reached the server. The router surfaces an
 *   `IndeterminateExecutionError` instead of retrying.
 */
export type DeliveryState = "not-sent" | "unknown";

export class TransportError extends Error {
  readonly delivery: DeliveryState;

  constructor(message: string, delivery: DeliveryState, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransportError";
    this.delivery = delivery;
  }
}

export function notSentError(message: string, cause?: unknown): TransportError {
  return new TransportError(message, "not-sent", { cause });
}

export function unknownDeliveryError(message: string, cause?: unknown): TransportError {
  return new TransportError(message, "unknown", { cause });
}

export function isRedisReplyError(error: unknown): error is RedisReplyError {
  return (
    error instanceof RedisReplyError ||
    (error instanceof Error &&
      error.name === "RedisReplyError" &&
      typeof (error as { reply?: unknown }).reply === "string")
  );
}

export function isTransportError(error: unknown): error is TransportError {
  if (!(error instanceof Error) || error.name !== "TransportError") {
    return false;
  }
  const delivery = (error as { delivery?: unknown }).delivery;
  return delivery === "not-sent" || delivery === "unknown";
}
