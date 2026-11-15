import { bodyDigest, verifySignature } from "./crypto.js";
import {
  BodyConflictError,
  TransactionFailedError,
  UnknownEndpointError,
} from "./errors.js";
import type {
  CommitReceipt,
  EndpointConfig,
  IngestionStore,
  IngestionTransaction,
  VerifiedDelivery,
} from "./types.js";

export interface IngestorOptions {
  /** Injectable clock (unix milliseconds); defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * Pipeline that turns a signed webhook request into a committed receipt.
 *
 * Invariants enforced here:
 *  - verification happens before any storage work, so invalid payloads never
 *    create state;
 *  - delivery id + body digest give idempotency: the same id with the same
 *    body returns the previously committed offset, a different body is a
 *    conflict;
 *  - the event, its offset and the idempotency record share one transaction:
 *    a rollback leaves nothing behind and the delivery stays retryable;
 *  - a success receipt is only produced after commit and always carries the
 *    committed offset.
 */
export class WebhookIngestor {
  private readonly endpointsById: Map<string, EndpointConfig>;
  private readonly store: IngestionStore;
  private readonly nowMs: () => number;

  constructor(
    endpoints: readonly EndpointConfig[],
    store: IngestionStore,
    options: IngestorOptions = {},
  ) {
    for (const endpoint of endpoints) {
      if (endpoint.keys.length === 0) {
        throw new Error(`Endpoint "${endpoint.id}" must configure at least one key generation`);
      }
      if (endpoint.timestampToleranceMs < 0) {
        throw new Error(`Endpoint "${endpoint.id}" tolerance must be non-negative`);
      }
    }
    this.endpointsById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
    this.store = store;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * Verify the envelope and ingest the body.
   *
   * @returns a commit-bound receipt for both first deliveries and retries.
   */
  async ingest(params: {
    endpointId: string;
    deliveryId: string;
    rawTimestamp: string;
    body: Buffer;
    signatureHeader: string;
  }): Promise<CommitReceipt> {
    const endpoint = this.endpointsById.get(params.endpointId);
    if (!endpoint) {
      throw new UnknownEndpointError(params.endpointId);
    }

    // Throws on replay-window, unknown-key or mac mismatch. No storage side
    // effects have happened at this point.
    const verified = verifySignature(
      endpoint,
      params.deliveryId,
      params.rawTimestamp,
      params.body,
      params.signatureHeader,
      this.nowMs(),
    );

    const delivery: VerifiedDelivery = {
      endpointId: params.endpointId,
      deliveryId: params.deliveryId,
      timestamp: verified.timestamp,
      body: params.body,
      bodyDigest: bodyDigest(params.body),
      keyId: verified.keyId,
    };

    return this.commitDelivery(delivery);
  }

  /**
   * Ingest an already-verified delivery. Useful when a transport layer has
   * already run {@link verifySignature} and wants to reuse the result.
   */
  async ingestVerified(delivery: VerifiedDelivery): Promise<CommitReceipt> {
    if (!this.endpointsById.has(delivery.endpointId)) {
      throw new UnknownEndpointError(delivery.endpointId);
    }
    return this.commitDelivery(delivery);
  }

  private async commitDelivery(delivery: VerifiedDelivery): Promise<CommitReceipt> {
    let tx: IngestionTransaction | undefined;
    try {
      tx = await this.store.begin(delivery.endpointId);
      const existing = await tx.findDelivery(delivery.endpointId, delivery.deliveryId);
      if (existing) {
        if (existing.bodyDigest !== delivery.bodyDigest) {
          // Permanent rejection: the same delivery id was committed before but
          // the new body hashes differently.
          await tx.rollback();
          throw new BodyConflictError(delivery.endpointId, delivery.deliveryId);
        }
        // Idempotent retry: read-only path. No new event/offset is allocated
        // and the original accepted record is left untouched; the receipt
        // points at the offset committed by the first delivery.
        await tx.rollback();
        if (existing.offset === null) {
          throw new Error(
            `Delivery record "${delivery.deliveryId}" has no committed offset; storage is inconsistent`,
          );
        }
        return {
          endpointId: existing.endpointId,
          deliveryId: existing.deliveryId,
          bodyDigest: existing.bodyDigest,
          status: "duplicate",
          committedOffset: existing.offset.toString(),
          keyId: existing.keyId,
        };
      }

      const event = await tx.appendEvent({
        endpointId: delivery.endpointId,
        deliveryId: delivery.deliveryId,
        bodyDigest: delivery.bodyDigest,
        body: delivery.body,
        timestamp: delivery.timestamp,
        keyId: delivery.keyId,
      });
      await tx.upsertDelivery({
        endpointId: delivery.endpointId,
        deliveryId: delivery.deliveryId,
        bodyDigest: delivery.bodyDigest,
        keyId: delivery.keyId,
        timestamp: delivery.timestamp,
        offset: event.offset,
        status: "accepted",
      });
      return await tx.commit();
    } catch (error) {
      if (tx) await safeRollback(tx);
      if (error instanceof BodyConflictError) {
        throw error;
      }
      // Commit failure (or any store error) means nothing was durably
      // recorded: surface a retryable failure and let the sender redeliver.
      throw new TransactionFailedError(
        delivery.endpointId,
        delivery.deliveryId,
        error,
      );
    }
  }
}

async function safeRollback(tx: IngestionTransaction): Promise<void> {
  try {
    await tx.rollback();
  } catch {
    // A rollback failure is swallowed: the original error is the meaningful
    // one and will be reported as retryable regardless.
  }
}
