import {
  groupUserEvents,
  Session,
  SessionEvent,
} from './sessionizer';

/**
 * Reference implementation: full-sort regrouping of a batch of events.
 * Used to cross-check the incremental Sessionizer.
 */
export function referenceSessions(
  events: SessionEvent[],
  gapMs: number,
): Session[] {
  const byUser = new Map<string, SessionEvent[]>();
  for (const e of events) {
    const list = byUser.get(e.userId);
    if (list) list.push(e);
    else byUser.set(e.userId, [e]);
  }
  const all: Session[] = [];
  for (const [userId, list] of byUser) {
    all.push(...groupUserEvents(userId, list, gapMs));
  }
  return all.sort(
    (a, b) =>
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0) ||
      a.start - b.start,
  );
}
