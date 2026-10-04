import { CrashInjector } from "./fault.js";
import { Wal } from "./wal.js";

export type Vote = "YES" | "NO";
export type Decision = "COMMIT" | "ABORT";

export interface ParticipantHandle {
  readonly id: string;
  prepare(txnId: string): Vote;
  decide(txnId: string, decision: Decision): void;
}

interface CoordinatorState {
  begun: boolean;
  votes: Map<string, Vote>;
  decision: Decision | undefined;
  acked: Set<string>;
  ended: boolean;
}

/**
 * Two-phase commit coordinator. Holds NO authoritative in-memory state:
 * every run starts by replaying its WAL, so a restarted coordinator
 * continues exactly and only from the persisted records.
 *
 * Recovery rule: if no DECISION record exists the coordinator never
 * fabricates one to escape uncertainty -- it re-collects votes from the
 * participants (whose persisted votes make re-voting idempotent) and only
 * then persists a decision derived from those votes.
 */
export class Coordinator {
  constructor(
    private readonly wal: Wal,
    private readonly injector: CrashInjector = new CrashInjector(),
  ) {}

  private replay(txnId: string): CoordinatorState {
    const state: CoordinatorState = {
      begun: false,
      votes: new Map(),
      decision: undefined,
      acked: new Set(),
      ended: false,
    };
    for (const rec of this.wal.readAll()) {
      if (rec.txnId !== txnId) continue;
      switch (rec.type) {
        case "BEGIN":
          state.begun = true;
          break;
        case "VOTE": {
          const participant = rec.participant as string;
          const vote = rec.vote as Vote;
          const prev = state.votes.get(participant);
          if (prev !== undefined && prev !== vote) {
            throw new Error("coordinator log: conflicting votes from " + participant);
          }
          state.votes.set(participant, vote);
          break;
        }
        case "DECISION": {
          const decision = rec.decision as Decision;
          if (state.decision !== undefined && state.decision !== decision) {
            throw new Error("coordinator log: conflicting decisions");
          }
          state.decision = decision;
          break;
        }
        case "ACK":
          state.acked.add(rec.participant as string);
          break;
        case "END":
          state.ended = true;
          break;
      }
    }
    return state;
  }

  run(txnId: string, participants: ParticipantHandle[]): Decision {
    const state = this.replay(txnId);
    if (state.ended) return state.decision as Decision;

    this.injector.checkpoint("coordinator:start");

    if (!state.begun) {
      this.wal.append({ type: "BEGIN", txnId, participants: participants.map((p) => p.id) });
      this.injector.checkpoint("coordinator:begin");
      state.begun = true;
    }

    if (state.decision === undefined) {
      // Phase 1: collect votes. Votes already in the log are not re-asked;
      // participants answer duplicates idempotently from their own logs.
      for (const p of participants) {
        if (!state.votes.has(p.id)) {
          const vote = p.prepare(txnId);
          this.wal.append({ type: "VOTE", txnId, participant: p.id, vote });
          this.injector.checkpoint("coordinator:vote:" + p.id);
          state.votes.set(p.id, vote);
        }
      }
      const decision: Decision = [...state.votes.values()].every((v) => v === "YES")
        ? "COMMIT"
        : "ABORT";
      this.wal.append({ type: "DECISION", txnId, decision });
      this.injector.checkpoint("coordinator:decision");
      state.decision = decision;
    }

    // Phase 2: deliver the persisted decision. Delivery is idempotent on
    // the participant side, so re-sending after a crash is safe.
    for (const p of participants) {
      if (!state.acked.has(p.id)) {
        p.decide(txnId, state.decision);
        this.wal.append({ type: "ACK", txnId, participant: p.id });
        this.injector.checkpoint("coordinator:notify:" + p.id);
        state.acked.add(p.id);
      }
    }

    this.wal.append({ type: "END", txnId });
    this.injector.checkpoint("coordinator:end");
    return state.decision;
  }
}
