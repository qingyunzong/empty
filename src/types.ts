export type Vote = "YES" | "NO";
export type Decision = "COMMIT" | "ABORT";

export type CoordinatorRecord =
  | { kind: "BEGIN"; txId: string; participants: string[] }
  | { kind: "VOTE"; txId: string; from: string; vote: Vote }
  | { kind: "DECISION"; txId: string; decision: Decision };

export type ParticipantRecord =
  | { kind: "PREPARED"; txId: string }
  | { kind: "ABORTED"; txId: string; cause: "VOTE_NO" | "DECISION" }
  | { kind: "COMMITTED"; txId: string };

export type Message =
  | { type: "PREPARE"; txId: string }
  | { type: "DECISION"; txId: string; decision: Decision };

export type Response =
  | { type: "VOTE"; txId: string; vote: Vote }
  | { type: "ACK"; txId: string };

/** Thrown by failpoint hooks to simulate an abrupt crash after a durable write. */
export class CrashFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashFault";
  }
}
