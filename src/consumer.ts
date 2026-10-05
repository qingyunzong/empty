import { Broker } from "./broker";
import { LedgerStore } from "./store";

export interface Transfer {
  account: string;
  amount: number;
}

export type Effect = "applied" | "duplicate" | "rolled-back";
export type AckOutcome = "acked" | "stale-rejected" | "broker-failed" | "not-attempted";

/**
 * Append-only delivery trace. Every delivery attempt is recorded, including
 * duplicates — the trace is where redeliveries remain visible even though the
 * business effect is applied exactly once.
 */
export interface TraceEntry {
  messageId: string;
  generation: number;
  attempt: number;
  effect: Effect;
  ack: AckOutcome;
}

export class Consumer {
  readonly trace: TraceEntry[] = [];

  constructor(
    private broker: Broker,
    private store: LedgerStore,
    private subId: string,
    private batchSize = 10,
  ) {}

  /** One poll cycle: fetch a lease batch, apply idempotently, ACK. */
  poll(): void {
    const { generation, deliveries } = this.broker.fetch(this.subId, this.batchSize);
    for (const d of deliveries) {
      const { account, amount } = d.payload as Transfer;
      let effect: Effect;
      try {
        effect = this.store.applyTransfer(d.id, account, amount) ? "applied" : "duplicate";
      } catch {
        // Commit failed and rolled back: do not ACK, let the lease expire so
        // the broker redelivers and the transfer is retried.
        this.trace.push({
          messageId: d.id,
          generation,
          attempt: d.attempt,
          effect: "rolled-back",
          ack: "not-attempted",
        });
        continue;
      }
      let ack: AckOutcome;
      try {
        const res = this.broker.ack(this.subId, generation, [d.id]);
        ack = res.acked.includes(d.id) ? "acked" : "stale-rejected";
      } catch {
        // Broker ACK failed: the lease will expire and the message will be
        // redelivered; the store dedups it on the next attempt.
        ack = "broker-failed";
      }
      this.trace.push({ messageId: d.id, generation, attempt: d.attempt, effect, ack });
    }
  }
}
