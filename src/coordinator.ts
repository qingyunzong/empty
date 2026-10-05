import { Wal } from "./wal.js";
import type { Hub } from "./hub.js";
import type { CoordinatorRecord, Decision, Vote } from "./types.js";

interface TxState {
  participants: string[];
  votes: Map<string, Vote>;
  decision: Decision | null;
}

export type TxStatus = Decision | "PENDING";

/**
 * A 2PC coordinator whose only source of truth is its WAL. Recovery never
 * invents outcomes: an ABORT decision requires a recorded NO vote, a COMMIT
 * decision requires recorded YES votes from every participant. If votes are
 * missing (participant unreachable), the transaction stays PENDING and is
 * retried on the next recover() — an undecided transaction is never
 * masqueraded as a rollback.
 */
export class Coordinator {
  private readonly wal: Wal<CoordinatorRecord>;
  private readonly txs = new Map<string, TxState>();
  /** Failpoint hook invoked after every durable append (test-only). */
  onAppend: ((record: CoordinatorRecord) => void) | null = null;

  constructor(dir: string, private readonly hub: Hub) {
    this.wal = new Wal<CoordinatorRecord>(dir, "coordinator.log");
    for (const record of this.wal.readAll()) this.apply(record);
  }

  private apply(record: CoordinatorRecord): void {
    switch (record.kind) {
      case "BEGIN":
        this.txs.set(record.txId, {
          participants: record.participants,
          votes: new Map(),
          decision: null,
        });
        break;
      case "VOTE": {
        const tx = this.mustKnow(record.txId);
        tx.votes.set(record.from, record.vote);
        break;
      }
      case "DECISION": {
        const tx = this.mustKnow(record.txId);
        tx.decision = record.decision;
        break;
      }
    }
  }

  private mustKnow(txId: string): TxState {
    const tx = this.txs.get(txId);
    if (!tx) throw new Error(`coordinator: log record for unknown tx ${txId}`);
    return tx;
  }

  private append(record: CoordinatorRecord): void {
    this.wal.append(record);
    this.apply(record);
    this.onAppend?.(record);
  }

  records(): CoordinatorRecord[] {
    return this.wal.readAll();
  }

  status(txId: string): TxStatus {
    const tx = this.txs.get(txId);
    if (!tx) throw new Error(`coordinator: unknown tx ${txId}`);
    return tx.decision ?? "PENDING";
  }

  /** Start a new transaction and drive it as far as possible. */
  run(txId: string, participants: string[]): TxStatus {
    if (this.txs.has(txId)) throw new Error(`coordinator: duplicate tx ${txId}`);
    this.append({ kind: "BEGIN", txId, participants });
    this.drive(txId);
    return this.status(txId);
  }

  /** Resume every transaction exactly from the records in the log. */
  recover(): void {
    for (const txId of this.txs.keys()) this.drive(txId);
  }

  private drive(txId: string): void {
    const tx = this.mustKnow(txId);
    if (!tx.decision) {
      // Phase 1: collect votes still missing according to the log.
      for (const participant of tx.participants) {
        if (tx.votes.has(participant)) continue;
        const response = this.hub.send(participant, { type: "PREPARE", txId });
        if (response && response.type === "VOTE") {
          this.append({ kind: "VOTE", txId, from: participant, vote: response.vote });
        }
      }
      // Decide only from recorded votes — never from guesses.
      const votes = [...tx.votes.values()];
      if (votes.includes("NO")) {
        this.append({ kind: "DECISION", txId, decision: "ABORT" });
      } else if (tx.votes.size === tx.participants.length) {
        this.append({ kind: "DECISION", txId, decision: "COMMIT" });
      } else {
        return; // PENDING: undecided, must not fabricate a rollback.
      }
    }
    // Phase 2: (re-)deliver the recorded decision. Delivery is idempotent on
    // the participant side, so re-sending after a crash is safe.
    const decision = tx.decision;
    if (!decision) return;
    for (const participant of tx.participants) {
      this.hub.send(participant, { type: "DECISION", txId, decision });
    }
  }
}
