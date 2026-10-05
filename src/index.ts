import { compareEvents, validateRequirements } from "./matching.js";
import { findShortestSegment } from "./solver.js";
import { verifyCertificate } from "./verify.js";
import type {
  LogEvent,
  Requirement,
  SearchCertificate,
  VerificationReport,
} from "./types.js";

export { MAX_REQUIREMENTS } from "./types.js";
export type {
  LogEvent,
  MatchEntry,
  Requirement,
  SearchCertificate,
  VerificationReport,
} from "./types.js";
export { compareEvents } from "./matching.js";
export { findShortestSegment } from "./solver.js";
export { checkMatchingLegality, verifyCertificate } from "./verify.js";

/**
 * Incrementally maintained log index. Events are kept sorted by (time, id);
 * late-arriving corrections (out-of-order inserts) and deletions update the
 * sorted structure in place and invalidate the cached answer, which is
 * recomputed lazily on the next search.
 */
export class LogSearchIndex {
  private events: LogEvent[] = [];
  private readonly byId = new Map<string, LogEvent>();
  private dirty = true;
  private cachedKey: string | null = null;
  private cachedResult: SearchCertificate | null = null;

  get size(): number {
    return this.events.length;
  }

  /** Sorted view of the indexed events. */
  getEvents(): readonly LogEvent[] {
    return this.events;
  }

  private locate(event: LogEvent): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEvents(this.events[mid]!, event) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Insert an event (possibly a late correction with a past timestamp). */
  addEvent(event: LogEvent): void {
    if (this.byId.has(event.id)) {
      throw new Error(`duplicate event id "${event.id}"`);
    }
    this.events.splice(this.locate(event), 0, event);
    this.byId.set(event.id, event);
    this.dirty = true;
  }

  /** Remove an event by id. Returns false if the id is unknown. */
  removeEvent(id: string): boolean {
    const ev = this.byId.get(id);
    if (ev === undefined) return false;
    this.events.splice(this.locate(ev), 1);
    this.byId.delete(id);
    this.dirty = true;
    return true;
  }

  /**
   * Shortest segment satisfying all requirement slots, with a one-to-one
   * matching certificate. Recomputed only when the index changed or the
   * requirements differ from the cached query.
   */
  search(requirements: readonly Requirement[]): SearchCertificate | null {
    validateRequirements(requirements);
    const key = JSON.stringify(requirements);
    if (!this.dirty && this.cachedKey === key) return this.cachedResult;
    const result = findShortestSegment(this.events, requirements);
    this.cachedKey = key;
    this.cachedResult = result;
    this.dirty = false;
    return result;
  }

  /**
   * Independent verification of a certificate against the current index:
   * enumerates every interval with a naive matcher and cross-checks
   * legality, minimality and the earliest-start tie-break.
   */
  verify(
    requirements: readonly Requirement[],
    cert: SearchCertificate | null,
  ): VerificationReport {
    return verifyCertificate(this.events, requirements, cert);
  }
}
