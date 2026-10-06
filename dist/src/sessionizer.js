"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sessionizer = void 0;
exports.compareTimedEvents = compareTimedEvents;
exports.buildSession = buildSession;
exports.groupEvents = groupEvents;
function compareTimedEvents(a, b) {
    if (a.timestamp !== b.timestamp)
        return a.timestamp - b.timestamp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** Deterministic id derived from the session content, so identical
 *  sessions always get identical ids (across incremental and reference
 *  computation) and any content change yields a new id. */
function buildSession(userId, events) {
    if (events.length === 0)
        throw new Error('cannot build an empty session');
    const first = events[0];
    const last = events[events.length - 1];
    const eventIds = events.map((e) => e.id);
    return {
        sessionId: `${userId}|${first.timestamp}|${last.timestamp}|${first.id}|${last.id}`,
        userId,
        start: first.timestamp,
        end: last.timestamp,
        eventIds,
        eventCount: events.length,
    };
}
/** Group events sorted by (timestamp, id) into sessions, cutting whenever
 *  the gap between consecutive events exceeds gapMs. */
function groupEvents(userId, sortedEvents, gapMs) {
    const sessions = [];
    let begin = 0;
    for (let i = 1; i <= sortedEvents.length; i++) {
        if (i === sortedEvents.length ||
            sortedEvents[i].timestamp - sortedEvents[i - 1].timestamp > gapMs) {
            sessions.push(buildSession(userId, sortedEvents.slice(begin, i)));
            begin = i;
        }
    }
    return sessions;
}
function lowerBound(events, target) {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareTimedEvents(events[mid], target) < 0)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
/**
 * Incremental sessionizer.
 *
 * - Events of one user with inter-event gap <= gapMs form a session.
 * - Out-of-order arrivals may bridge (merge) two existing sessions.
 * - Retractions may split a session into two.
 * - Events with timestamp < watermark - allowedLatenessMs are dropped.
 * - advanceWatermark garbage-collects sessions that can no longer be
 *   touched by any acceptable (late) event, i.e. sessions with
 *   end < watermark - allowedLatenessMs - gapMs.
 *
 * Every mutation returns the delta against the previously emitted state:
 * retracted sessions (old versions) followed by added sessions (new
 * versions). Session ids are content-derived, so a downstream sink can
 * key its state by sessionId and apply retract/add pairs.
 */
class Sessionizer {
    gapMs;
    allowedLatenessMs;
    wm = Number.NEGATIVE_INFINITY;
    users = new Map();
    index = new Map();
    stats = { added: 0, droppedLate: 0, retracted: 0, gcSessions: 0 };
    constructor(options) {
        if (options.gapMs < 0)
            throw new Error('gapMs must be >= 0');
        if (options.allowedLatenessMs < 0)
            throw new Error('allowedLatenessMs must be >= 0');
        this.gapMs = options.gapMs;
        this.allowedLatenessMs = options.allowedLatenessMs;
    }
    get watermark() {
        return this.wm;
    }
    /** Events with timestamp strictly below the horizon are too late. */
    get horizon() {
        return this.wm - this.allowedLatenessMs;
    }
    addEvent(event) {
        if (this.index.has(event.id)) {
            throw new Error(`duplicate event id: ${event.id}`);
        }
        if (event.timestamp < this.horizon) {
            this.stats.droppedLate++;
            return [];
        }
        let state = this.users.get(event.userId);
        if (!state) {
            state = { events: [], sessions: [] };
            this.users.set(event.userId, state);
        }
        const timed = { timestamp: event.timestamp, id: event.id };
        state.events.splice(lowerBound(state.events, timed), 0, timed);
        this.index.set(event.id, { userId: event.userId, timestamp: event.timestamp });
        // Sessions containing an event within [t-gap, t+gap] are affected.
        // Because sessions are separated by gaps > gapMs, these form one
        // contiguous run [lo..hi] and all merge into a single session.
        const loBound = event.timestamp - this.gapMs;
        const hiBound = event.timestamp + this.gapMs;
        let lo = 0;
        while (lo < state.sessions.length && state.sessions[lo].end < loBound)
            lo++;
        let hi = state.sessions.length - 1;
        while (hi >= 0 && state.sessions[hi].start > hiBound)
            hi--;
        const affected = hi >= lo ? state.sessions.slice(lo, hi + 1) : [];
        let startIdx = 0;
        for (let i = 0; i < lo; i++)
            startIdx += state.sessions[i].eventCount;
        let affectedEvents = 0;
        for (const session of affected)
            affectedEvents += session.eventCount;
        const mergedEvents = state.events.slice(startIdx, startIdx + affectedEvents + 1);
        const merged = buildSession(event.userId, mergedEvents);
        state.sessions.splice(lo, affected.length, merged);
        this.stats.added++;
        const deltas = affected.map((session) => ({
            kind: 'retracted',
            session,
        }));
        deltas.push({ kind: 'added', session: merged });
        return deltas;
    }
    retractEvent(eventId) {
        const meta = this.index.get(eventId);
        if (!meta)
            throw new Error(`unknown event id: ${eventId}`);
        const state = this.users.get(meta.userId);
        const timed = { timestamp: meta.timestamp, id: eventId };
        const at = lowerBound(state.events, timed);
        if (at >= state.events.length || state.events[at].id !== eventId) {
            throw new Error(`internal state corrupt: event ${eventId} not found`);
        }
        state.events.splice(at, 1);
        this.index.delete(eventId);
        // The event belongs to the last session with start <= timestamp.
        let si = state.sessions.length - 1;
        while (si >= 0 && state.sessions[si].start > meta.timestamp)
            si--;
        const old = state.sessions[si];
        let startIdx = 0;
        for (let i = 0; i < si; i++)
            startIdx += state.sessions[i].eventCount;
        const remaining = state.events.slice(startIdx, startIdx + old.eventCount - 1);
        const parts = groupEvents(meta.userId, remaining, this.gapMs);
        state.sessions.splice(si, 1, ...parts);
        if (state.sessions.length === 0)
            this.users.delete(meta.userId);
        this.stats.retracted++;
        const deltas = [{ kind: 'retracted', session: old }];
        for (const session of parts)
            deltas.push({ kind: 'added', session });
        return deltas;
    }
    /** Advances the watermark (monotonic) and garbage-collects sessions
     *  that no acceptable event could ever join or bridge again. */
    advanceWatermark(watermark) {
        if (watermark <= this.wm)
            return;
        this.wm = watermark;
        const cutoff = this.horizon - this.gapMs; // keep sessions with end >= cutoff
        for (const [userId, state] of this.users) {
            let drop = 0;
            while (drop < state.sessions.length && state.sessions[drop].end < cutoff)
                drop++;
            if (drop === 0)
                continue;
            let droppedEvents = 0;
            for (let i = 0; i < drop; i++) {
                const session = state.sessions[i];
                droppedEvents += session.eventCount;
                for (const id of session.eventIds)
                    this.index.delete(id);
            }
            state.sessions.splice(0, drop);
            state.events.splice(0, droppedEvents);
            this.stats.gcSessions += drop;
            if (state.sessions.length === 0)
                this.users.delete(userId);
        }
    }
    getSessions() {
        const all = [];
        for (const state of this.users.values())
            all.push(...state.sessions);
        all.sort((a, b) => a.userId === b.userId ? a.start - b.start : a.userId < b.userId ? -1 : 1);
        return all;
    }
    getSessionsForUser(userId) {
        const state = this.users.get(userId);
        return state ? [...state.sessions] : [];
    }
}
exports.Sessionizer = Sessionizer;
