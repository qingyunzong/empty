import { Wal } from "./wal.js";
import type { Message, ParticipantRecord, Response, Vote } from "./types.js";

type TxState =
  | { status: "PREPARED" }
  | { status: "COMMITTED" }
  | { status: "ABORTED"; cause: "VOTE_NO" | "DECISION" };

export type VotePolicy = Vote | ((txId: string) => Vote);

/**
 * A 2PC participant. All state transitions are written to its WAL before the
 * corresponding reply is sent, so a restarted instance rebuilt from the log
 * answers exactly like the crashed one. Duplicate PREPARE / DECISION messages
 * are idempotent: the recorded state is replayed, never re-decided.
 */
export class Participant {
  private readonly wal: Wal<ParticipantRecord>;
  private readonly state = new Map<string, TxState>();
  /** Failpoint hook invoked after every durable append (test-only). */
  onAppend: ((record: ParticipantRecord) => void) | null = null;

  constructor(
    dir: string,
    readonly id: string,
    private readonly policy: VotePolicy,
  ) {
    this.wal = new Wal<ParticipantRecord>(dir, `participant-${id}.log`);
    for (const record of this.wal.readAll()) this.apply(record);
  }

  private apply(record: ParticipantRecord): void {
    switch (record.kind) {
      case "PREPARED":
        this.state.set(record.txId, { status: "PREPARED" });
        break;
      case "COMMITTED":
        this.state.set(record.txId, { status: "COMMITTED" });
        break;
      case "ABORTED":
        this.state.set(record.txId, { status: "ABORTED", cause: record.cause });
        break;
    }
  }

  private append(record: ParticipantRecord): void {
    this.wal.append(record);
    this.apply(record);
    this.onAppend?.(record);
  }

  records(): ParticipantRecord[] {
    return this.wal.readAll();
  }

  handle(msg: Message): Response {
    switch (msg.type) {
      case "PREPARE":
        return this.onPrepare(msg.txId);
      case "DECISION":
        return this.onDecision(msg.txId, msg.decision);
    }
  }

  private onPrepare(txId: string): Response {
    const current = this.state.get(txId);
    if (current) {
      // Duplicate prepare: replay the recorded vote, never vote twice.
      if (current.status === "PREPARED") return { type: "VOTE", txId, vote: "YES" };
      if (current.status === "ABORTED") return { type: "VOTE", txId, vote: "NO" };
      throw new Error(`participant ${this.id}: PREPARE for committed tx ${txId}`);
    }
    const vote = typeof this.policy === "function" ? this.policy(txId) : this.policy;
    if (vote === "YES") {
      this.append({ kind: "PREPARED", txId });
    } else {
      this.append({ kind: "ABORTED", txId, cause: "VOTE_NO" });
    }
    return { type: "VOTE", txId, vote };
  }

  private onDecision(txId: string, decision: "COMMIT" | "ABORT"): Response {
    const current = this.state.get(txId);
    if (!current) {
      throw new Error(`participant ${this.id}: DECISION for unknown tx ${txId}`);
    }
    if (current.status === "COMMITTED") {
      if (decision !== "COMMIT") {
        throw new Error(`participant ${this.id}: conflicting ABORT for committed tx ${txId}`);
      }
      return { type: "ACK", txId }; // duplicate decision, already applied
    }
    if (current.status === "ABORTED") {
      if (decision !== "ABORT") {
        throw new Error(`participant ${this.id}: conflicting COMMIT for aborted tx ${txId}`);
      }
      return { type: "ACK", txId }; // duplicate decision, already applied
    }
    if (decision === "COMMIT") {
      this.append({ kind: "COMMITTED", txId });
    } else {
      this.append({ kind: "ABORTED", txId, cause: "DECISION" });
    }
    return { type: "ACK", txId };
  }
}
