/** Maximum number of requirement slots supported by the solver. */
export const MAX_REQUIREMENTS = 12;

/** A single log event. Events are ordered by (time, id). */
export interface LogEvent {
  readonly time: number;
  readonly id: string;
  readonly source: string;
  readonly keywords: readonly string[];
}

/**
 * One requirement slot.
 * - keyword: the matched event must contain this keyword.
 * - dependsOn: indices of requirements whose matched events must appear
 *   strictly earlier in the (time, id) ordering.
 * - mutexGroup: requirements sharing a group name must be matched to events
 *   from pairwise distinct sources.
 */
export interface Requirement {
  readonly keyword: string;
  readonly dependsOn?: readonly number[];
  readonly mutexGroup?: string;
}

/** One entry of the one-to-one matching certificate. */
export interface MatchEntry {
  readonly requirement: number;
  readonly event: number; // index into the sorted event array
  readonly eventId: string;
  readonly keyword: string;
  readonly source: string;
}

/** Certificate produced by the solver for the shortest segment. */
export interface SearchCertificate {
  readonly lo: number; // inclusive start index into the sorted events
  readonly hi: number; // inclusive end index into the sorted events
  readonly length: number; // number of events in the segment (hi - lo + 1)
  readonly requirementCount: number; // number of requirement slots satisfied
  readonly matching: readonly MatchEntry[]; // one-to-one requirement -> event
}

/** Result of the independent verification pass. */
export interface VerificationReport {
  readonly ok: boolean;
  readonly matchingLegal: boolean;
  readonly countCertificateOk: boolean;
  readonly minimal: boolean;
  readonly tieBreakOk: boolean;
  readonly errors: readonly string[];
}
