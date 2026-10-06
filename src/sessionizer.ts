export interface SessionEvent {
  userId: string;
  eventId: string;
  ts: number;
}

export interface Session {
  userId: string;
  start: number;
  end: number;
  count: number;
  eventIds: string[];
}

export type SessionDelta =
  | { type: 'added'; after: Session }
  | { type: 'updated'; before: Session; after: Session }
  | { type: 'removed'; before: Session };

export function sessionKey(s: Session): string {
  return `${s.userId}#${s.start}`;
}

function sessionEquals(a: Session, b: Session): boolean {
  return (
    a.userId === b.userId &&
    a.start === b.start &&
    a.end === b.end &&
    a.count === b.count &&
    a.eventIds.join(',') === b.eventIds.join(',')
  );
}

function compareEvents(a: SessionEvent, b: SessionEvent): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Group one user's events into sessions: consecutive events (sorted by
 * (ts, eventId)) with gap <= gapMs belong to the same session.
 */
export function groupUserEvents(
  userId: string,
  events: SessionEvent[],
  gapMs: number,
): Session[] {
  const sorted = [...events].sort(compareEvents);
  const sessions: Session[] = [];
  for (const e of sorted) {
    const last = sessions[sessions.length - 1];
    if (last && e.ts - last.end <= gapMs) {
      last.end = e.ts;
      last.count += 1;
      last.eventIds.push(e.eventId);
    } else {
      sessions.push({
        userId,
        start: e.ts,
        end: e.ts,
        count: 1,
        eventIds: [e.eventId],
      });
    }
  }
  return sessions;
}

export function diffSessions(prev: Session[], next: Session[]): SessionDelta[] {
  const prevByKey = new Map(prev.map((s) => [sessionKey(s), s]));
  const nextByKey = new Map(next.map((s) => [sessionKey(s), s]));
  const deltas: SessionDelta[] = [];
  for (const [key, after] of nextByKey) {
    const before = prevByKey.get(key);
    if (!before) {
      deltas.push({ type: 'added', after });
    } else if (!sessionEquals(before, after)) {
      deltas.push({ type: 'updated', before, after });
    }
  }
  for (const [key, before] of prevByKey) {
    if (!nextByKey.has(key)) {
      deltas.push({ type: 'removed', before });
    }
  }
  return deltas;
}

export interface SessionizerOptions {
  /** Max gap between consecutive events of one user within a session. */
  gapMs: number;
  /** How far behind the watermark events may arrive / be retained. */
  allowedLatenessMs?: number;
}

/**
 * Incremental sessionizer.
 *
 * - add(): out-of-order inserts may bridge (merge) two sessions.
 * - retract(): removing an event may split a session.
 * - advanceWatermark(): events with ts < watermark - allowedLateness are
 *   dropped from state; later arrivals in that range are rejected.
 * Every mutation returns the session-change deltas it caused.
 */
export class Sessionizer {
  private readonly gapMs: number;
  private readonly allowedLatenessMs: number;
  private watermark = Number.NEGATIVE_INFINITY;
  private readonly eventsByUser = new Map<string, SessionEvent[]>();
  private readonly sessionsByUser = new Map<string, Session[]>();

  constructor(options: SessionizerOptions) {
    if (!(options.gapMs >= 0)) throw new Error('gapMs must be >= 0');
    this.gapMs = options.gapMs;
    this.allowedLatenessMs = options.allowedLatenessMs ?? 0;
    if (!(this.allowedLatenessMs >= 0)) {
      throw new Error('allowedLatenessMs must be >= 0');
    }
  }

  get currentWatermark(): number {
    return this.watermark;
  }

  /** True if an event at ts is beyond the allowed lateness horizon. */
  isTooLate(ts: number): boolean {
    return ts < this.watermark - this.allowedLatenessMs;
  }

  add(event: SessionEvent): SessionDelta[] {
    if (this.isTooLate(event.ts)) return [];
    const list = this.eventsByUser.get(event.userId) ?? [];
    if (list.some((e) => e.eventId === event.eventId)) return [];
    list.push(event);
    this.eventsByUser.set(event.userId, list);
    return this.recompute(event.userId);
  }

  retract(userId: string, eventId: string): SessionDelta[] {
    const list = this.eventsByUser.get(userId);
    if (!list) return [];
    const idx = list.findIndex((e) => e.eventId === eventId);
    if (idx < 0) return [];
    list.splice(idx, 1);
    if (list.length === 0) this.eventsByUser.delete(userId);
    return this.recompute(userId);
  }

  advanceWatermark(watermark: number): SessionDelta[] {
    if (watermark <= this.watermark) return [];
    this.watermark = watermark;
    const horizon = watermark - this.allowedLatenessMs;
    const deltas: SessionDelta[] = [];
    for (const [userId, list] of [...this.eventsByUser]) {
      const kept = list.filter((e) => e.ts >= horizon);
      if (kept.length === list.length) continue;
      if (kept.length === 0) this.eventsByUser.delete(userId);
      else this.eventsByUser.set(userId, kept);
      deltas.push(...this.recompute(userId));
    }
    return deltas;
  }

  getSessions(userId?: string): Session[] {
    const collect = (uid: string): Session[] =>
      (this.sessionsByUser.get(uid) ?? []).map((s) => ({
        ...s,
        eventIds: [...s.eventIds],
      }));
    if (userId !== undefined) return collect(userId);
    const all: Session[] = [];
    for (const uid of this.sessionsByUser.keys()) all.push(...collect(uid));
    return all.sort(
      (a, b) =>
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0) ||
        a.start - b.start,
    );
  }

  private recompute(userId: string): SessionDelta[] {
    const prev = this.sessionsByUser.get(userId) ?? [];
    const events = this.eventsByUser.get(userId) ?? [];
    const next = groupUserEvents(userId, events, this.gapMs);
    if (next.length === 0) this.sessionsByUser.delete(userId);
    else this.sessionsByUser.set(userId, next);
    return diffSessions(prev, next);
  }
}
