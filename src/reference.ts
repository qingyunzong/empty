import {
  compareTimedEvents,
  groupEvents,
  InputEvent,
  Session,
  TimedEvent,
} from './sessionizer';

/**
 * Reference implementation: sorts all live events per user and regroups
 * from scratch. Used to differentially verify the incremental Sessionizer.
 *
 * Note: the reference has no notion of watermark; callers model GC by
 * removing expired events from the input (or filtering the output).
 */
export function referenceSessions(
  events: Iterable<InputEvent>,
  gapMs: number,
): Session[] {
  const byUser = new Map<string, TimedEvent[]>();
  for (const event of events) {
    let list = byUser.get(event.userId);
    if (!list) {
      list = [];
      byUser.set(event.userId, list);
    }
    list.push({ timestamp: event.timestamp, id: event.id });
  }
  const sessions: Session[] = [];
  for (const [userId, userEvents] of byUser) {
    userEvents.sort(compareTimedEvents);
    sessions.push(...groupEvents(userId, userEvents, gapMs));
  }
  sessions.sort((a, b) =>
    a.userId === b.userId ? a.start - b.start : a.userId < b.userId ? -1 : 1,
  );
  return sessions;
}
