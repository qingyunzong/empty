export type EventKind =
  | "spawn"
  | "await"
  | "resume"
  | "complete"
  | "fail"
  | "cancel"
  | "timeout";

export interface TraceEvent {
  seq: number;
  kind: EventKind;
  /** Task label, e.g. "worker-1". */
  task: string;
  /** Event detail, e.g. "sleep:10", "T3:cancel", "ok". */
  detail: string;
  /** Virtual clock at record time. */
  clock: number;
  /** PRNG state right after this event was recorded. */
  rngState: number;
  /**
   * Sorted schedulable-event set at the choice step that produced this event.
   * Only choice events (resume/cancel/timeout) carry it; replay compares it
   * against its own ready set and rejects on any mismatch.
   */
  candidates: string[];
}

export interface Snapshot {
  /** Scheduler choice steps completed so far. */
  steps: number;
  /** Trace events recorded so far. */
  events: number;
  clock: number;
  /** Full PRNG state: restoring it resumes the identical random stream. */
  rngState: number;
  /** Rolling FNV-1a digest of the trace so far. */
  digest: string;
}

export function fnv1a(prev: number, text: string): number {
  let h = prev >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
