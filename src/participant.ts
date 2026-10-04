import type { Decision, ParticipantHandle, Vote } from "./coordinator.js";
import { CrashInjector } from "./fault.js";
import { Wal } from "./wal.js";

export type ParticipantStatus = "NOT_INVOLVED" | "IN_DOUBT" | "COMMITTED" | "ABORTED";

/**
 * 2PC participant backed by its own WAL. A participant that voted YES but
 * has not yet received the decision is IN_DOUBT: it is blocked and must
 * not unilaterally resolve the transaction -- in particular it must never
 * report the transaction as aborted ("undecided must not masquerade as
 * rollback").
 */
export class Participant implements ParticipantHandle {
  private readonly wal: Wal;

  constructor(
    readonly id: string,
    file: string,
    private readonly voteScript: (txnId: string) => Vote,
    private readonly injector: CrashInjector = new CrashInjector(),
  ) {
    this.wal = new Wal(file);
  }

  prepare(txnId: string): Vote {
    const persisted = this.persistedVote(txnId);
    if (persisted !== undefined) return persisted; // duplicate vote: idempotent
    const vote = this.voteScript(txnId);
    this.wal.append({ type: "VOTE", txnId, participant: this.id, vote });
    this.injector.checkpoint("participant:" + this.id + ":vote");
    return vote;
  }

  decide(txnId: string, decision: Decision): void {
    const persisted = this.persistedDecision(txnId);
    if (persisted !== undefined) {
      if (persisted !== decision) {
        throw new Error(
          "participant " + this.id + ": conflicting decision " + decision +
          " after persisted " + persisted,
        );
      }
      return; // duplicate delivery: idempotent
    }
    const vote = this.persistedVote(txnId);
    if (vote === undefined) {
      throw new Error("participant " + this.id + ": decision received before any vote");
    }
    if (decision === "COMMIT" && vote !== "YES") {
      throw new Error("participant " + this.id + ": cannot COMMIT after voting " + vote);
    }
    this.wal.append({ type: "DECISION", txnId, participant: this.id, decision });
    this.injector.checkpoint("participant:" + this.id + ":decision");
  }

  /** Honest report of the persisted state; IN_DOUBT is never hidden. */
  status(txnId: string): ParticipantStatus {
    const decision = this.persistedDecision(txnId);
    if (decision !== undefined) return decision === "COMMIT" ? "COMMITTED" : "ABORTED";
    const vote = this.persistedVote(txnId);
    if (vote === undefined) return "NOT_INVOLVED";
    return "IN_DOUBT";
  }

  persistedVote(txnId: string): Vote | undefined {
    return this.find(txnId, "VOTE")?.vote as Vote | undefined;
  }

  persistedDecision(txnId: string): Decision | undefined {
    return this.find(txnId, "DECISION")?.decision as Decision | undefined;
  }

  private find(txnId: string, type: string) {
    return this.wal.readAll().find((r) => r.txnId === txnId && r.type === type);
  }
}
