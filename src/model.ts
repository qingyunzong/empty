export interface LogEvent {
  /** Unique event identifier. */
  id: string;
  /** Event timestamp; events are ordered by (time, id). */
  time: number;
  /** Origin source of the event (used by source-mutex constraints). */
  source: string;
  /** Keywords this event contains. */
  keywords: readonly string[];
}

export interface Requirement {
  /** Keyword that the matched event must contain. */
  keyword: string;
  /**
   * Indices of prerequisite requirements. The event matched to this
   * requirement must appear strictly after the events matched to every
   * prerequisite (in event order). Must form a DAG.
   */
  prereqs?: readonly number[];
  /**
   * Requirements sharing the same mutex group must be matched to events
   * coming from pairwise distinct sources.
   */
  mutexGroup?: string;
}

export interface MatchingEntry {
  /** Requirement index. */
  requirement: number;
  /** Matched event id. */
  eventId: string;
}

export interface SearchResult {
  /** Inclusive start index into the sorted event list. */
  start: number;
  /** Inclusive end index into the sorted event list. */
  end: number;
  /** Number of events in the segment (end - start + 1). */
  length: number;
  /** One-to-one matching certificate: requirement index -> event id. */
  matching: MatchingEntry[];
}

export interface CountCertificate {
  /** Whether any feasible segment exists. */
  feasible: boolean;
  /** Total number of requirements. */
  requirementCount: number;
  /** Number of requirements satisfied (== requirementCount when feasible). */
  satisfiedCount: number;
  /** Minimal feasible segment length in events, or null when infeasible. */
  minLength: number | null;
  /** How many intervals of length minLength are feasible. */
  minLengthIntervalCount: number;
  /** Earliest start index among feasible intervals of minimal length. */
  earliestStartAtMinLength: number | null;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  checks: VerificationCheck[];
}
