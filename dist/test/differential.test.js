"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const sessionizer_1 = require("../src/sessionizer");
const reference_1 = require("../src/reference");
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function normalize(sessions) {
    return sessions
        .map((s) => ({
        sessionId: s.sessionId,
        userId: s.userId,
        start: s.start,
        end: s.end,
        eventIds: s.eventIds,
    }))
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
}
/**
 * Differential test: random adds (in-order, out-of-order, too-late),
 * retractions and watermark advances. After every step the incremental
 * engine state must equal the full-sort reference over the events that
 * should still be live, and the emitted delta stream must materialize to
 * the same state.
 */
function runDifferential(seed, gapMs, allowedLatenessMs, steps) {
    const rand = mulberry32(seed);
    const engine = new sessionizer_1.Sessionizer({ gapMs, allowedLatenessMs });
    const known = new Map(); // accepted and not yet GC'd
    const materialized = new Map();
    let watermark = 0;
    let counter = 0;
    engine.advanceWatermark(watermark); // sync engine watermark with the model
    const applyDeltas = (deltas) => {
        for (const d of deltas) {
            if (d.kind === 'added')
                materialized.set(d.session.sessionId, d.session);
            else {
                strict_1.default.ok(materialized.delete(d.session.sessionId), `retract of unknown session ${d.session.sessionId}`);
            }
        }
    };
    const check = (op) => {
        const expected = (0, reference_1.referenceSessions)(known.values(), gapMs);
        strict_1.default.deepEqual(normalize(engine.getSessions()), normalize(expected), op);
        const fromDeltas = [...materialized.values()];
        strict_1.default.deepEqual(normalize(fromDeltas), normalize(expected), `${op} (deltas)`);
    };
    for (let step = 0; step < steps; step++) {
        const r = rand();
        if (r < 0.55) {
            // add: timestamps scatter around the watermark, some too late
            const spread = allowedLatenessMs + 4 * gapMs + 20;
            const timestamp = watermark + Math.floor(rand() * 2 * spread) - spread;
            const event = {
                id: `e${counter++}`,
                userId: `u${Math.floor(rand() * 4)}`,
                timestamp,
            };
            const tooLate = timestamp < watermark - allowedLatenessMs;
            const deltas = engine.addEvent(event);
            if (tooLate) {
                strict_1.default.deepEqual(deltas, [], 'late event must not emit deltas');
            }
            else {
                known.set(event.id, event);
                applyDeltas(deltas);
            }
            check(`add ${event.id}@${timestamp}`);
        }
        else if (r < 0.8 && known.size > 0) {
            const ids = [...known.keys()];
            const id = ids[Math.floor(rand() * ids.length)];
            applyDeltas(engine.retractEvent(id));
            known.delete(id);
            check(`retract ${id}`);
        }
        else {
            watermark += Math.floor(rand() * (3 * gapMs + 5));
            engine.advanceWatermark(watermark);
            // Mirror the GC in the model: sessions with end < horizon - gapMs
            // are dropped as a whole, together with all their events.
            const cutoff = watermark - allowedLatenessMs - gapMs;
            for (const session of (0, reference_1.referenceSessions)(known.values(), gapMs)) {
                if (session.end < cutoff) {
                    for (const id of session.eventIds)
                        known.delete(id);
                }
            }
            for (const [id, session] of materialized) {
                if (session.end < cutoff)
                    materialized.delete(id);
            }
            check(`watermark ${watermark}`);
        }
    }
}
(0, node_test_1.test)('differential: gap=10 lateness=50, several seeds', () => {
    for (const seed of [1, 7, 42, 1337]) {
        runDifferential(seed, 10, 50, 1500);
    }
});
(0, node_test_1.test)('differential: gap=0 (only identical timestamps group)', () => {
    runDifferential(99, 0, 20, 1500);
});
(0, node_test_1.test)('differential: no allowed lateness', () => {
    runDifferential(2024, 5, 0, 1500);
});
(0, node_test_1.test)('differential: large gap (frequent bridging)', () => {
    runDifferential(555, 100, 30, 1500);
});
