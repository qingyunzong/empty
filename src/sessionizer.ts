/**
 * Incremental sessionization with net diffs.
 *
 * Rules:
 * - Events of the same user, sorted by (ts, id), belong to one session while
 *   the gap between adjacent events is <= `gapMs`; a larger gap splits.
 * - Session ID is the minimum member event ID.
 * - Out-of-order inserts/deletes are applied to incrementally maintained
 *   per-user sorted event lists; `apply` returns the NET diff of the batch
 *   (transient changes inside one batch cancel out).
 * - `rebuild()` recomputes sessions from scratch (independent sorted rebuild)
 *   so callers/tests can cross-check the incremental state.
 */

export type EventId = string | number;

export interface SessionEvent {
  id: EventId;
  userId: string;
  ts: number;
}

export interface Session {
  /** Minimum member event ID. */
  id: EventId;
  userId: string;
  start: number;
  end: number;
  /** Member event IDs ordered by (ts, id). */
  eventIds: EventId[];
}

export interface SessionDiff {
  added: Session[];
  removed: Session[];
}

export type Operation =
  | { type: "insert"; event: SessionEvent }
  | { type: "delete"; id: EventId };

function compareIds(a: EventId, b: EventId): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvents(a: SessionEvent, b: SessionEvent): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return compareIds(a.id, b.id);
}

function lowerBound(arr: SessionEvent[], ev: SessionEvent): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareEvents(arr[mid]!, ev) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sessionize(userId: string, sorted: SessionEvent[], gapMs: number): Session[] {
  const sessions: Session[] = [];
  let eventIds: EventId[] = [];
  let minId: EventId = "";
  let start = 0;
  let prevTs = 0;
  for (const ev of sorted) {
    if (eventIds.length > 0 && ev.ts - prevTs > gapMs) {
      sessions.push({ id: minId, userId, start, end: prevTs, eventIds });
      eventIds = [];
    }
    if (eventIds.length === 0) {
      minId = ev.id;
      start = ev.ts;
    } else if (compareIds(ev.id, minId) < 0) {
      minId = ev.id;
    }
    eventIds.push(ev.id);
    prevTs = ev.ts;
  }
  if (eventIds.length > 0) {
    sessions.push({ id: minId, userId, start, end: prevTs, eventIds });
  }
  return sessions;
}

/** Stable content key: two sessions are "the same" iff their keys match. */
export function sessionKey(s: Session): string {
  return JSON.stringify([s.id, s.userId, s.start, s.end, s.eventIds]);
}

function compareSessions(a: Session, b: Session): number {
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  if (a.start !== b.start) return a.start - b.start;
  return compareIds(a.id, b.id);
}

/** Net diff between two session lists (multiset comparison by content). */
export function diffSessions(before: Session[], after: Session[]): SessionDiff {
  const remaining = new Map<string, number>();
  for (const s of before) {
    const k = sessionKey(s);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const added: Session[] = [];
  for (const s of after) {
    const k = sessionKey(s);
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else added.push(s);
  }
  const removedKeys = new Map<string, number>();
  for (const [k, n] of remaining) {
    if (n > 0) removedKeys.set(k, n);
  }
  const removed: Session[] = [];
  for (const s of before) {
    const k = sessionKey(s);
    const n = removedKeys.get(k) ?? 0;
    if (n > 0) {
      removed.push(s);
      removedKeys.set(k, n - 1);
    }
  }
  added.sort(compareSessions);
  removed.sort(compareSessions);
  return { added, removed };
}

export class SessionStore {
  private readonly gapMs: number;
  private readonly events = new Map<EventId, SessionEvent>();
  private readonly byUser = new Map<string, SessionEvent[]>();
  private readonly cache = new Map<string, Session[]>();

  constructor(gapMs: number) {
    if (!Number.isFinite(gapMs) || gapMs < 0) {
      throw new RangeError("gapMs must be a non-negative finite number");
    }
    this.gapMs = gapMs;
  }

  /**
   * Apply a batch of out-of-order operations and return the NET session diff
   * (sessions present before but not after are `removed`, and vice versa).
   * Inserting an existing ID replaces the old event (e.g. time correction).
   */
  apply(ops: Operation[]): SessionDiff {
    const before = new Map<string, Session[]>();
    const touch = (userId: string): void => {
      if (!before.has(userId)) before.set(userId, this.sessionsOf(userId));
    };
    for (const op of ops) {
      if (op.type === "insert") {
        const existing = this.events.get(op.event.id);
        if (existing) touch(existing.userId);
        touch(op.event.userId);
      } else {
        const existing = this.events.get(op.id);
        if (existing) touch(existing.userId);
      }
    }

    for (const op of ops) {
      if (op.type === "insert") this.insertOne(op.event);
      else this.deleteOne(op.id);
    }

    const added: Session[] = [];
    const removed: Session[] = [];
    for (const [userId, beforeSessions] of before) {
      const d = diffSessions(beforeSessions, this.sessionsOf(userId));
      added.push(...d.added);
      removed.push(...d.removed);
    }
    added.sort(compareSessions);
    removed.sort(compareSessions);
    return { added, removed };
  }

  insert(event: SessionEvent): SessionDiff {
    return this.apply([{ type: "insert", event }]);
  }

  delete(id: EventId): SessionDiff {
    return this.apply([{ type: "delete", id }]);
  }

  /** Current sessions from the incrementally maintained state. */
  sessions(): Session[] {
    const all: Session[] = [];
    for (const userId of this.byUser.keys()) all.push(...this.sessionsOf(userId));
    all.sort(compareSessions);
    return all;
  }

  /** Independent sorted rebuild from the raw event set (for cross-checking). */
  rebuild(): Session[] {
    const groups = new Map<string, SessionEvent[]>();
    for (const ev of this.events.values()) {
      let g = groups.get(ev.userId);
      if (!g) groups.set(ev.userId, (g = []));
      g.push(ev);
    }
    const all: Session[] = [];
    for (const [userId, evs] of groups) {
      const sorted = [...evs].sort(compareEvents);
      all.push(...sessionize(userId, sorted, this.gapMs));
    }
    all.sort(compareSessions);
    return all;
  }

  size(): number {
    return this.events.size;
  }

  private sessionsOf(userId: string): Session[] {
    let s = this.cache.get(userId);
    if (!s) {
      s = sessionize(userId, this.byUser.get(userId) ?? [], this.gapMs);
      this.cache.set(userId, s);
    }
    return s;
  }

  private insertOne(event: SessionEvent): void {
    const existing = this.events.get(event.id);
    if (existing) this.deleteOne(event.id);
    this.events.set(event.id, event);
    let arr = this.byUser.get(event.userId);
    if (!arr) this.byUser.set(event.userId, (arr = []));
    arr.splice(lowerBound(arr, event), 0, event);
    this.cache.delete(event.userId);
  }

  private deleteOne(id: EventId): void {
    const existing = this.events.get(id);
    if (!existing) return;
    this.events.delete(id);
    const arr = this.byUser.get(existing.userId)!;
    let i = lowerBound(arr, existing);
    while (i < arr.length && arr[i]!.id !== id) i++;
    arr.splice(i, 1);
    if (arr.length === 0) this.byUser.delete(existing.userId);
    this.cache.delete(existing.userId);
  }
}
