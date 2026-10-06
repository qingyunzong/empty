"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const sessionizer_1 = require("../src/sessionizer");
const reference_1 = require("../src/reference");
function ev(id, userId, timestamp) {
    return { id, userId, timestamp };
}
function sessionTuples(sessions) {
    return sessions.map((s) => [s.userId, s.start, s.end, s.eventIds]);
}
function kinds(deltas) {
    return deltas.map((d) => d.kind);
}
(0, node_test_1.test)('in-order events group by gap', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    s.addEvent(ev('a', 'u', 0));
    s.addEvent(ev('b', 'u', 5));
    s.addEvent(ev('c', 'u', 30)); // gap 25 > 10 -> new session
    s.addEvent(ev('d', 'u', 40)); // gap 10 <= 10 -> same session
    strict_1.default.deepEqual(sessionTuples(s.getSessions()), [
        ['u', 0, 5, ['a', 'b']],
        ['u', 30, 40, ['c', 'd']],
    ]);
});
(0, node_test_1.test)('out-of-order event bridges two sessions into one', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    s.addEvent(ev('a', 'u', 0));
    s.addEvent(ev('b', 'u', 20));
    strict_1.default.equal(s.getSessions().length, 2);
    const deltas = s.addEvent(ev('c', 'u', 10)); // within 10 of both -> bridge
    strict_1.default.deepEqual(kinds(deltas), ['retracted', 'retracted', 'added']);
    const merged = deltas[2].kind === 'added' ? deltas[2].session : undefined;
    strict_1.default.deepEqual(sessionTuples(s.getSessions()), [['u', 0, 20, ['a', 'c', 'b']]]);
    strict_1.default.equal(merged.eventCount, 3);
});
(0, node_test_1.test)('retracting the bridge event splits the session back', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    s.addEvent(ev('a', 'u', 0));
    s.addEvent(ev('b', 'u', 20));
    const before = s.getSessions();
    s.addEvent(ev('c', 'u', 10)); // bridge
    const splitDeltas = s.retractEvent('c'); // un-bridge
    strict_1.default.deepEqual(kinds(splitDeltas), ['retracted', 'added', 'added']);
    const after = s.getSessions();
    strict_1.default.equal(after.length, 2);
    // Deterministic session ids: the split restores the exact original sessions.
    strict_1.default.deepEqual(after, before);
});
(0, node_test_1.test)('retracting the last event of a session removes it', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    s.addEvent(ev('a', 'u', 0));
    const deltas = s.retractEvent('a');
    strict_1.default.deepEqual(kinds(deltas), ['retracted']);
    strict_1.default.deepEqual(s.getSessions(), []);
});
(0, node_test_1.test)('retracting an edge event shrinks a session without splitting', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    s.addEvent(ev('a', 'u', 0));
    s.addEvent(ev('b', 'u', 5));
    s.addEvent(ev('c', 'u', 9));
    const deltas = s.retractEvent('c');
    strict_1.default.deepEqual(kinds(deltas), ['retracted', 'added']);
    strict_1.default.deepEqual(sessionTuples(s.getSessions()), [['u', 0, 5, ['a', 'b']]]);
});
(0, node_test_1.test)('events arriving exactly at gap boundary stay in one session', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    s.addEvent(ev('a', 'u', 0));
    s.addEvent(ev('b', 'u', 10)); // gap == gapMs -> same session
    s.addEvent(ev('c', 'u', 21)); // gap 11 -> new session
    strict_1.default.deepEqual(sessionTuples(s.getSessions()), [
        ['u', 0, 10, ['a', 'b']],
        ['u', 21, 21, ['c']],
    ]);
});
(0, node_test_1.test)('late events beyond allowed lateness are dropped silently', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 100 });
    s.addEvent(ev('a', 'u', 1000));
    s.advanceWatermark(1000); // horizon = 900
    const deltas = s.addEvent(ev('late', 'u', 899));
    strict_1.default.deepEqual(deltas, []);
    strict_1.default.equal(s.stats.droppedLate, 1);
    strict_1.default.equal(s.getSessions().length, 1);
    // timestamp == horizon is still accepted
    s.addEvent(ev('edge', 'u', 900));
    strict_1.default.equal(s.getSessions().length, 2);
});
(0, node_test_1.test)('watermark GC keeps sessions still reachable by allowed late events', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 100 });
    s.addEvent(ev('a', 'u', 0));
    s.addEvent(ev('b', 'u', 20)); // two sessions: [0,0], [20,20]
    s.advanceWatermark(50); // horizon -50, cutoff -60: nothing collected
    strict_1.default.equal(s.getSessions().length, 2);
    // A late-but-allowed event can still bridge the old sessions.
    s.addEvent(ev('c', 'u', 10));
    strict_1.default.deepEqual(sessionTuples(s.getSessions()), [['u', 0, 20, ['a', 'c', 'b']]]);
    s.advanceWatermark(115); // horizon 15, cutoff 5: end 20 >= 5 -> kept
    strict_1.default.equal(s.getSessions().length, 1);
    s.advanceWatermark(200); // horizon 100, cutoff 90: end 20 < 90 -> collected
    strict_1.default.equal(s.getSessions().length, 0);
    strict_1.default.equal(s.stats.gcSessions, 1);
    // Events of collected sessions are forgotten.
    strict_1.default.throws(() => s.retractEvent('a'), /unknown event id/);
});
(0, node_test_1.test)('duplicate add and unknown retract are rejected', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 100 });
    s.addEvent(ev('a', 'u', 0));
    strict_1.default.throws(() => s.addEvent(ev('a', 'u', 1)), /duplicate event id/);
    strict_1.default.throws(() => s.retractEvent('nope'), /unknown event id/);
});
(0, node_test_1.test)('users are sessionized independently', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    s.addEvent(ev('a', 'u1', 0));
    s.addEvent(ev('b', 'u2', 5));
    s.addEvent(ev('c', 'u1', 8));
    strict_1.default.deepEqual(sessionTuples(s.getSessions()), [
        ['u1', 0, 8, ['a', 'c']],
        ['u2', 5, 5, ['b']],
    ]);
});
(0, node_test_1.test)('delta stream materializes to the same state as the engine', () => {
    const s = new sessionizer_1.Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
    const materialized = new Map();
    const apply = (deltas) => {
        for (const d of deltas) {
            if (d.kind === 'added')
                materialized.set(d.session.sessionId, d.session);
            else
                materialized.delete(d.session.sessionId);
        }
    };
    apply(s.addEvent(ev('a', 'u', 0)));
    apply(s.addEvent(ev('b', 'u', 20)));
    apply(s.addEvent(ev('c', 'u', 10))); // bridge
    apply(s.retractEvent('c')); // split
    apply(s.retractEvent('a'));
    const fromDeltas = [...materialized.values()].sort((x, y) => x.sessionId < y.sessionId ? -1 : 1);
    strict_1.default.deepEqual(fromDeltas, s.getSessions());
    strict_1.default.deepEqual(fromDeltas, (0, reference_1.referenceSessions)([ev('b', 'u', 20)], 10));
});
