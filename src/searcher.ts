import type {
  CountCertificate,
  LogEvent,
  Requirement,
  SearchResult,
  VerificationReport,
} from "./model.js";
import { topoOrder } from "./matching.js";
import { findShortestSegment } from "./search.js";
import { enumerateCertificate, verifyResult } from "./verify.js";

export const MAX_REQUIREMENTS = 12;

function compareEvents(a: LogEvent, b: LogEvent): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Maintains a sorted log-event stream and incrementally recomputes the
 * shortest feasible segment after every mutation (insertion, deletion, or
 * late-arriving correction). Results are cached and only recomputed when
 * the stream has changed since the last query.
 */
export class LogSegmentSearcher {
  private events: LogEvent[] = [];
  private readonly reqs: readonly Requirement[];
  private cached: SearchResult | null = null;
  private dirty = true;
  private mutationCount = 0;

  constructor(requirements: readonly Requirement[]) {
    if (requirements.length === 0) {
      throw new Error("at least one requirement is needed");
    }
    if (requirements.length > MAX_REQUIREMENTS) {
      throw new Error(
        `too many requirements: ${requirements.length} (max ${MAX_REQUIREMENTS})`,
      );
    }
    for (const req of requirements) {
      if (req.keyword.length === 0) throw new Error("requirement keyword must be non-empty");
    }
    topoOrder(requirements); // validates prereq indices and acyclicity
    this.reqs = requirements.map((r) => ({ ...r, prereqs: r.prereqs?.slice() }));
  }

  get size(): number {
    return this.events.length;
  }

  /** Number of mutations applied so far (useful for staleness checks). */
  get version(): number {
    return this.mutationCount;
  }

  /** Sorted snapshot of the current event stream. */
  getEvents(): readonly LogEvent[] {
    return this.events.slice();
  }

  private indexOfId(id: string): number {
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i]!.id === id) return i;
    }
    return -1;
  }

  private insertSorted(event: LogEvent): void {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEvents(this.events[mid]!, event) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.events.splice(lo, 0, event);
  }

  private static checkEvent(event: LogEvent): void {
    if (event.id.length === 0) throw new Error("event id must be non-empty");
    if (!Number.isFinite(event.time)) throw new Error("event time must be finite");
  }

  private mutate(event: LogEvent, removeExisting: boolean): void {
    LogSegmentSearcher.checkEvent(event);
    if (removeExisting) {
      const at = this.indexOfId(event.id);
      if (at !== -1) this.events.splice(at, 1);
    } else if (this.indexOfId(event.id) !== -1) {
      throw new Error(`duplicate event id "${event.id}"`);
    }
    this.insertSorted(event);
    this.dirty = true;
    this.mutationCount++;
  }

  /** Inserts a new event; throws if the id already exists. */
  addEvent(event: LogEvent): void {
    this.mutate(event, false);
  }

  /**
   * Applies a late-arriving correction: replaces the event with the same id
   * (any of time, source, or keywords may change) or inserts it if the id
   * is unknown, then triggers recomputation.
   */
  correctEvent(event: LogEvent): void {
    this.mutate(event, true);
  }

  /** Removes an event by id and recomputes. Returns false if unknown. */
  deleteEvent(id: string): boolean {
    const at = this.indexOfId(id);
    if (at === -1) return false;
    this.events.splice(at, 1);
    this.dirty = true;
    this.mutationCount++;
    return true;
  }

  /** Forces recomputation and returns the current shortest segment. */
  recompute(): SearchResult | null {
    const segment = findShortestSegment(this.events, this.reqs);
    this.cached =
      segment === null
        ? null
        : {
            start: segment.start,
            end: segment.end,
            length: segment.end - segment.start + 1,
            matching: segment.match.map((pos, requirement) => ({
              requirement,
              eventId: this.events[pos]!.id,
            })),
          };
    this.dirty = false;
    return this.cached;
  }

  /** Returns the cached shortest segment, recomputing only when stale. */
  result(): SearchResult | null {
    return this.dirty ? this.recompute() : this.cached;
  }

  /**
   * Requirement-count certificate for the current stream, produced by
   * exhaustive enumeration of all intervals (independent of the fast path).
   */
  certificate(): CountCertificate {
    return enumerateCertificate(this.events, this.reqs);
  }

  /**
   * Independently verifies the current result: re-enumerates every interval
   * with a separate matching oracle and re-validates the one-to-one
   * matching certificate.
   */
  verify(): VerificationReport {
    return verifyResult(this.events, this.reqs, this.result());
  }
}
