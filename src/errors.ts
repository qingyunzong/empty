/**
 * Error hierarchy for webhook verification and ingestion.
 *
 * Every error carries a stable {@link WebhookError.code} so HTTP adapters and
 * log pipelines can branch on machine-readable values, and an explicit
 * {@link WebhookError.retryable} flag that tells callers whether redelivery
 * has any chance of succeeding.
 */
export type WebhookErrorCode =
  | "UNKNOWN_ENDPOINT"
  | "MALFORMED_ENVELOPE"
  | "MISSING_ENVELOPE"
  | "TIMESTAMP_SKEW"
  | "UNKNOWN_KEY"
  | "INVALID_SIGNATURE"
  | "BODY_CONFLICT"
  | "TRANSACTION_FAILED";

export interface WebhookErrorOptions {
  readonly code: WebhookErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly endpointId?: string;
  readonly deliveryId?: string;
  readonly cause?: unknown;
}

export class WebhookError extends Error {
  readonly code: WebhookErrorCode;
  /** Suggested HTTP status for transport adapters. */
  readonly statusCode: number;
  /**
   * Retryable failures (for example a rolled-back transaction) must return a
   * non-2xx response so the sender redelivers; verification failures are not
   * retryable because the signed payload itself is invalid.
   */
  readonly retryable: boolean;
  readonly endpointId?: string;
  readonly deliveryId?: string;

  constructor(message: string, options: WebhookErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "WebhookError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
    this.endpointId = options.endpointId;
    this.deliveryId = options.deliveryId;
  }
}

export class UnknownEndpointError extends WebhookError {
  constructor(endpointId: string) {
    super(`No endpoint configured with id "${endpointId}"`, {
      code: "UNKNOWN_ENDPOINT",
      statusCode: 404,
      retryable: false,
      endpointId,
    });
    this.name = "UnknownEndpointError";
  }
}

export class MalformedEnvelopeError extends WebhookError {
  constructor(message: string, endpointId?: string) {
    super(message, {
      code: "MALFORMED_ENVELOPE",
      statusCode: 400,
      retryable: false,
      endpointId,
    });
    this.name = "MalformedEnvelopeError";
  }
}

export class MissingEnvelopeError extends WebhookError {
  constructor(headerName: string, endpointId?: string) {
    super(`Required envelope header "${headerName}" is missing or empty`, {
      code: "MISSING_ENVELOPE",
      statusCode: 401,
      retryable: false,
      endpointId,
    });
    this.name = "MissingEnvelopeError";
  }
}

export class TimestampSkewError extends WebhookError {
  constructor(timestamp: number, toleranceMs: number, endpointId: string, deliveryId?: string) {
    super(
      `Signature timestamp ${timestamp} is outside the ${toleranceMs}ms tolerance window`,
      {
        code: "TIMESTAMP_SKEW",
        statusCode: 401,
        retryable: false,
        endpointId,
        deliveryId,
      },
    );
    this.name = "TimestampSkewError";
  }
}

export class UnknownKeyError extends WebhookError {
  constructor(keyId: string, endpointId: string, deliveryId?: string) {
    super(`Key generation "${keyId}" is not known to endpoint "${endpointId}"`, {
      code: "UNKNOWN_KEY",
      statusCode: 401,
      retryable: false,
      endpointId,
      deliveryId,
    });
    this.name = "UnknownKeyError";
  }
}

export class InvalidSignatureError extends WebhookError {
  constructor(endpointId: string, deliveryId?: string) {
    super("Signature verification failed for the supplied body and timestamp", {
      code: "INVALID_SIGNATURE",
      statusCode: 401,
      retryable: false,
      endpointId,
      deliveryId,
    });
    this.name = "InvalidSignatureError";
  }
}

export class BodyConflictError extends WebhookError {
  constructor(endpointId: string, deliveryId: string) {
    super(
      `Delivery id "${deliveryId}" was already committed with a different body digest`,
      {
        code: "BODY_CONFLICT",
        statusCode: 409,
        retryable: false,
        endpointId,
        deliveryId,
      },
    );
    this.name = "BodyConflictError";
  }
}

export class TransactionFailedError extends WebhookError {
  constructor(endpointId: string, deliveryId: string, cause?: unknown) {
    super(
      `Storage transaction for delivery "${deliveryId}" did not commit; the delivery is retryable`,
      {
        code: "TRANSACTION_FAILED",
        statusCode: 503,
        retryable: true,
        endpointId,
        deliveryId,
        cause,
      },
    );
    this.name = "TransactionFailedError";
  }
}
