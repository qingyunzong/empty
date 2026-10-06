"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.referenceSessions = referenceSessions;
const sessionizer_1 = require("./sessionizer");
/**
 * Reference implementation: sorts all live events per user and regroups
 * from scratch. Used to differentially verify the incremental Sessionizer.
 *
 * Note: the reference has no notion of watermark; callers model GC by
 * removing expired events from the input (or filtering the output).
 */
function referenceSessions(events, gapMs) {
    const byUser = new Map();
    for (const event of events) {
        let list = byUser.get(event.userId);
        if (!list) {
            list = [];
            byUser.set(event.userId, list);
        }
        list.push({ timestamp: event.timestamp, id: event.id });
    }
    const sessions = [];
    for (const [userId, userEvents] of byUser) {
        userEvents.sort(sessionizer_1.compareTimedEvents);
        sessions.push(...(0, sessionizer_1.groupEvents)(userId, userEvents, gapMs));
    }
    sessions.sort((a, b) => a.userId === b.userId ? a.start - b.start : a.userId < b.userId ? -1 : 1);
    return sessions;
}
