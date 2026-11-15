import type {
  CommitReceipt,
  DeliveryRecord,
  IngestionStore,
  IngestionTransaction,
  StoredEvent,
} from "./types.js";

interface EndpointState {
  nextOffset: bigint;
  /** Ordered event log, keyed by insertion order. */
  events: StoredEvent[];
  deliveries: Map<string, DeliveryRecord>;
  /**
   * Serialization gate for transactions on this endpoint. A transaction owns
   * the endpoint from `begin` until settle, so concurrent deliveries observe
   * each other's committed idempotency records and a delivery id can only be
   * accepted once.
   */
  txQueue: Promise<void>;
}

export interface MemoryStoreHooks {
  /**
   * Called inside `commit()` before anything is made durable. Throwing here
   * forces a rollback, which simulates a database transaction failure so
   * retry semantics can be exercised.
   */
  beforeCommit?(tx: IngestionTransaction): Promise<void> | void;
}

/**
 * Reference {@link IngestionStore} with real transactional semantics:
 * a transaction works on an isolated snapshot and all staged writes become
 * visible atomically on commit (or disappear on rollback/error).
 *
 * Transactions on the same endpoint are serialized from `begin` until they
 * settle via a per-endpoint queue, which is enough for tests and single-process
 * gateways; production deployments plug in a database-backed store implementing
 * the same contract (row locks or a unique constraint on delivery id).
 */
export class MemoryIngestionStore implements IngestionStore {
  private readonly endpoints = new Map<string, EndpointState>();
  private readonly hooks: MemoryStoreHooks;

  constructor(hooks: MemoryStoreHooks = {}) {
    this.hooks = hooks;
  }

  async begin(endpointId: string): Promise<IngestionTransaction> {
    const state = this.stateFor(endpointId);

    // Wait for every earlier transaction on this endpoint to settle before
    // taking a snapshot. Database-backed stores would instead rely on row
    // locks / unique constraints; the observable contract is identical.
    const turn = state.txQueue.then(() => undefined);
    let releaseTurn: () => void;
    state.txQueue = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    await turn;

    const snapshot: EndpointState = {
      nextOffset: state.nextOffset,
      events: [...state.events],
      deliveries: new Map(state.deliveries),
      txQueue: Promise.resolve(),
    };
    const stagedEvents: StoredEvent[] = [];
    const stagedDeliveries: DeliveryRecord[] = [];
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      releaseTurn!();
    };

    const tx: IngestionTransaction = {
      async findDelivery(targetEndpointId, deliveryId) {
        assertSameEndpoint(endpointId, targetEndpointId);
        return snapshot.deliveries.get(deliveryId) ?? null;
      },

      async appendEvent(input) {
        const event: StoredEvent = { ...input, offset: snapshot.nextOffset };
        snapshot.nextOffset += 1n;
        snapshot.events.push(event);
        stagedEvents.push(event);
        return event;
      },

      async upsertDelivery(record) {
        assertSameEndpoint(endpointId, record.endpointId);
        snapshot.deliveries.set(record.deliveryId, record);
        stagedDeliveries.push(record);
      },

      commit: async () => {
        if (settled) {
          throw new Error("Transaction already settled");
        }
        try {
          if (this.hooks.beforeCommit) {
            await this.hooks.beforeCommit(tx);
          }

          const committed = this.stateFor(endpointId);
          for (const event of stagedEvents) {
            committed.events.push(event);
          }
          for (const record of stagedDeliveries) {
            committed.deliveries.set(record.deliveryId, record);
          }
          committed.nextOffset = snapshot.nextOffset;
        } catch (error) {
          release();
          throw error;
        }
        release();

        const last = stagedEvents.at(-1);
        const record = stagedDeliveries.at(-1);
        if (!record) {
          throw new Error("Cannot commit a transaction without a delivery record");
        }
        const offset = last ? last.offset : (record.offset ?? 0n);
        return receiptFor(record, offset);
      },

      rollback: async () => {
        // Snapshot is discarded; the shared state was never touched.
        stagedEvents.length = 0;
        stagedDeliveries.length = 0;
        release();
      },
    };

    return tx;
  }

  /** Read-only view of committed events for an endpoint, in offset order. */
  events(endpointId: string): readonly StoredEvent[] {
    return this.stateFor(endpointId).events;
  }

  /** Read-only view of a committed delivery record. */
  delivery(endpointId: string, deliveryId: string): DeliveryRecord | null {
    return this.stateFor(endpointId).deliveries.get(deliveryId) ?? null;
  }

  /** Next offset that would be assigned; mainly useful for tests. */
  readonly nextOffset = (endpointId: string): bigint => this.stateFor(endpointId).nextOffset;

  private stateFor(endpointId: string): EndpointState {
    let state = this.endpoints.get(endpointId);
    if (!state) {
      state = {
        nextOffset: 0n,
        events: [],
        deliveries: new Map(),
        txQueue: Promise.resolve(),
      };
      this.endpoints.set(endpointId, state);
    }
    return state;
  }
}

function assertSameEndpoint(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(`Transaction is bound to endpoint "${expected}", not "${actual}"`);
  }
}

function receiptFor(record: DeliveryRecord, offset: bigint): CommitReceipt {
  return {
    endpointId: record.endpointId,
    deliveryId: record.deliveryId,
    bodyDigest: record.bodyDigest,
    status: record.status,
    committedOffset: offset.toString(),
    keyId: record.keyId,
  };
}
