/**
 * Public type surface for the webhook ingestion component.
 *
 * The component is storage agnostic: gateway code supplies an
 * {@link IngestionStore} (for example a database-backed implementation) while
 * the in-memory implementation shipped in `memory-store.ts` covers tests,
 * development and single-process deployments.
 */

/** A single key generation that may be active for an endpoint. */
export interface KeySecret {
  /** Stable generation identifier, carried in the signature header (`kid`). */
  readonly id: string;
  /** Shared secret used as the HMAC key. */
  readonly secret: string | Buffer;
}

/** Static configuration for one webhook endpoint. */
export interface EndpointConfig {
  readonly id: string;
  /**
   * Key generations known to the endpoint. The first entry is treated as the
   * current generation when producing signatures; every entry is accepted
   * during verification so that rotation overlap windows keep working.
   */
  readonly keys: readonly KeySecret[];
  /**
   * Absolute difference, in milliseconds, between the signature timestamp and
   * the verifier clock that is still accepted.
   */
  readonly timestampToleranceMs: number;
}

/** An event durably stored inside a committed transaction. */
export interface StoredEvent {
  readonly endpointId: string;
  readonly deliveryId: string;
  /** SHA-256 digest of the raw body, hex encoded. */
  readonly bodyDigest: string;
  /** Raw request body exactly as signed. */
  readonly body: Buffer;
  /** Signature timestamp (unix milliseconds). */
  readonly timestamp: number;
  /** Key generation that produced the verified signature. */
  readonly keyId: string;
  /** Monotonic, per-endpoint log offset assigned by the store. */
  readonly offset: bigint;
}

/**
 * Idempotency record for a delivery. The record is written in the same
 * transaction as the event, so a rolled-back transaction leaves no trace and
 * the same delivery can be retried.
 */
export interface DeliveryRecord {
  readonly endpointId: string;
  readonly deliveryId: string;
  readonly bodyDigest: string;
  readonly keyId: string;
  readonly timestamp: number;
  /** Offset of the committed event; present exactly when status is accepted. */
  readonly offset: bigint | null;
  readonly status: DeliveryStatus;
}

export type DeliveryStatus = "accepted" | "duplicate";

/**
 * Success receipt. Both first-time accepts and idempotent retries are success
 * receipts, and every one of them carries the offset that was committed for
 * the delivery.
 */
export interface CommitReceipt {
  readonly endpointId: string;
  readonly deliveryId: string;
  readonly bodyDigest: string;
  readonly status: DeliveryStatus;
  /** Offset as a decimal string so the receipt is JSON serializable. */
  readonly committedOffset: string;
  readonly keyId: string;
}

/** Transactional handle returned by {@link IngestionStore.begin}. */
export interface IngestionTransaction {
  /** Look up an existing idempotency record inside this transaction. */
  findDelivery(endpointId: string, deliveryId: string): Promise<DeliveryRecord | null>;
  /**
   * Append an event and reserve the next offset for the endpoint.
   * Implementations must return the same offset that will become visible after
   * commit.
   */
  appendEvent(event: Omit<StoredEvent, "offset">): Promise<StoredEvent>;
  /** Upsert the idempotency record inside the same transaction. */
  upsertDelivery(record: DeliveryRecord): Promise<void>;
  /** Atomically commit the event, offset and idempotency record. */
  commit(): Promise<CommitReceipt>;
  /** Discard every staged change; a later retry behaves like a first attempt. */
  rollback(): Promise<void>;
}

/** Durable, transactional storage contract implemented by gateway integrations. */
export interface IngestionStore {
  begin(endpointId: string): Promise<IngestionTransaction>;
}

/** A verified delivery handed to the ingestion pipeline. */
export interface VerifiedDelivery {
  readonly endpointId: string;
  readonly deliveryId: string;
  readonly timestamp: number;
  readonly body: Buffer;
  readonly bodyDigest: string;
  readonly keyId: string;
}

/** Names of the HTTP headers carrying the webhook envelope. */
export interface HeaderNames {
  readonly signature: string;
  readonly deliveryId: string;
  readonly timestamp: string;
}

/** Tunable envelope header names; the defaults follow common webhook practice. */
export const DEFAULT_HEADER_NAMES: HeaderNames = {
  signature: "webhook-signature",
  deliveryId: "webhook-delivery-id",
  timestamp: "webhook-timestamp",
};
