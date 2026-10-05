/**
 * Event model for the transfer simulation.
 *
 * Every event carries a logical `tick` and an intra-tick sequence number
 * `seq`. The engine processes events strictly in (tick, seq) order, so a
 * permission change and a commit landing in the same tick are resolved by
 * their event order, never by arrival races.
 */

export type EventKind =
  | "grant"
  | "revoke"
  | "begin"
  | "submitBatch"
  | "pause"
  | "resume"
  | "commitBatch"
  | "publish";

interface Base {
  tick: number;
  seq: number;
}

export interface GrantEvent extends Base {
  kind: "grant";
  principal: string;
  objectId: string;
}

export interface RevokeEvent extends Base {
  kind: "revoke";
  principal: string;
  objectId: string;
}

export interface BeginEvent extends Base {
  kind: "begin";
  transferId: string;
  principal: string;
  objectId: string;
  totalChunks: number;
}

export interface SubmitBatchEvent extends Base {
  kind: "submitBatch";
  transferId: string;
  batchId: string;
  chunks: number[];
}

export interface PauseEvent extends Base {
  kind: "pause";
  transferId: string;
}

export interface ResumeEvent extends Base {
  kind: "resume";
  transferId: string;
}

export interface CommitBatchEvent extends Base {
  kind: "commitBatch";
  transferId: string;
  batchId: string;
}

export interface PublishEvent extends Base {
  kind: "publish";
  principal: string;
  objectId: string;
  payload: string;
}

export type SimEvent =
  | GrantEvent
  | RevokeEvent
  | BeginEvent
  | SubmitBatchEvent
  | PauseEvent
  | ResumeEvent
  | CommitBatchEvent
  | PublishEvent;

/** Total order over events: tick first, then intra-tick sequence. */
export function compareEvents(a: SimEvent, b: SimEvent): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  return a.seq - b.seq;
}

export function sortEvents(events: readonly SimEvent[]): SimEvent[] {
  return [...events].sort(compareEvents);
}
