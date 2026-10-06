import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InputEvent,
  Session,
  SessionDelta,
  Sessionizer,
} from '../src/sessionizer';
import { referenceSessions } from '../src/reference';

function ev(id: string, userId: string, timestamp: number): InputEvent {
  return { id, userId, timestamp };
}

function sessionTuples(sessions: Session[]): Array<[string, number, number, string[]]> {
  return sessions.map((s) => [s.userId, s.start, s.end, s.eventIds]);
}

function kinds(deltas: SessionDelta[]): string[] {
  return deltas.map((d) => d.kind);
}

test('in-order events group by gap', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  s.addEvent(ev('a', 'u', 0));
  s.addEvent(ev('b', 'u', 5));
  s.addEvent(ev('c', 'u', 30)); // gap 25 > 10 -> new session
  s.addEvent(ev('d', 'u', 40)); // gap 10 <= 10 -> same session
  assert.deepEqual(sessionTuples(s.getSessions()), [
    ['u', 0, 5, ['a', 'b']],
    ['u', 30, 40, ['c', 'd']],
  ]);
});

test('out-of-order event bridges two sessions into one', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  s.addEvent(ev('a', 'u', 0));
  s.addEvent(ev('b', 'u', 20));
  assert.equal(s.getSessions().length, 2);

  const deltas = s.addEvent(ev('c', 'u', 10)); // within 10 of both -> bridge
  assert.deepEqual(kinds(deltas), ['retracted', 'retracted', 'added']);
  const merged = deltas[2]!.kind === 'added' ? deltas[2]!.session : undefined;
  assert.deepEqual(sessionTuples(s.getSessions()), [['u', 0, 20, ['a', 'c', 'b']]]);
  assert.equal(merged!.eventCount, 3);
});

test('retracting the bridge event splits the session back', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  s.addEvent(ev('a', 'u', 0));
  s.addEvent(ev('b', 'u', 20));
  const before = s.getSessions();

  s.addEvent(ev('c', 'u', 10)); // bridge
  const splitDeltas = s.retractEvent('c'); // un-bridge

  assert.deepEqual(kinds(splitDeltas), ['retracted', 'added', 'added']);
  const after = s.getSessions();
  assert.equal(after.length, 2);
  // Deterministic session ids: the split restores the exact original sessions.
  assert.deepEqual(after, before);
});

test('retracting the last event of a session removes it', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  s.addEvent(ev('a', 'u', 0));
  const deltas = s.retractEvent('a');
  assert.deepEqual(kinds(deltas), ['retracted']);
  assert.deepEqual(s.getSessions(), []);
});

test('retracting an edge event shrinks a session without splitting', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  s.addEvent(ev('a', 'u', 0));
  s.addEvent(ev('b', 'u', 5));
  s.addEvent(ev('c', 'u', 9));
  const deltas = s.retractEvent('c');
  assert.deepEqual(kinds(deltas), ['retracted', 'added']);
  assert.deepEqual(sessionTuples(s.getSessions()), [['u', 0, 5, ['a', 'b']]]);
});

test('events arriving exactly at gap boundary stay in one session', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  s.addEvent(ev('a', 'u', 0));
  s.addEvent(ev('b', 'u', 10)); // gap == gapMs -> same session
  s.addEvent(ev('c', 'u', 21)); // gap 11 -> new session
  assert.deepEqual(sessionTuples(s.getSessions()), [
    ['u', 0, 10, ['a', 'b']],
    ['u', 21, 21, ['c']],
  ]);
});

test('late events beyond allowed lateness are dropped silently', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 100 });
  s.addEvent(ev('a', 'u', 1000));
  s.advanceWatermark(1000); // horizon = 900
  const deltas = s.addEvent(ev('late', 'u', 899));
  assert.deepEqual(deltas, []);
  assert.equal(s.stats.droppedLate, 1);
  assert.equal(s.getSessions().length, 1);
  // timestamp == horizon is still accepted
  s.addEvent(ev('edge', 'u', 900));
  assert.equal(s.getSessions().length, 2);
});

test('watermark GC keeps sessions still reachable by allowed late events', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 100 });
  s.addEvent(ev('a', 'u', 0));
  s.addEvent(ev('b', 'u', 20)); // two sessions: [0,0], [20,20]
  s.advanceWatermark(50); // horizon -50, cutoff -60: nothing collected
  assert.equal(s.getSessions().length, 2);

  // A late-but-allowed event can still bridge the old sessions.
  s.addEvent(ev('c', 'u', 10));
  assert.deepEqual(sessionTuples(s.getSessions()), [['u', 0, 20, ['a', 'c', 'b']]]);

  s.advanceWatermark(115); // horizon 15, cutoff 5: end 20 >= 5 -> kept
  assert.equal(s.getSessions().length, 1);
  s.advanceWatermark(200); // horizon 100, cutoff 90: end 20 < 90 -> collected
  assert.equal(s.getSessions().length, 0);
  assert.equal(s.stats.gcSessions, 1);
  // Events of collected sessions are forgotten.
  assert.throws(() => s.retractEvent('a'), /unknown event id/);
});

test('duplicate add and unknown retract are rejected', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 100 });
  s.addEvent(ev('a', 'u', 0));
  assert.throws(() => s.addEvent(ev('a', 'u', 1)), /duplicate event id/);
  assert.throws(() => s.retractEvent('nope'), /unknown event id/);
});

test('users are sessionized independently', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  s.addEvent(ev('a', 'u1', 0));
  s.addEvent(ev('b', 'u2', 5));
  s.addEvent(ev('c', 'u1', 8));
  assert.deepEqual(sessionTuples(s.getSessions()), [
    ['u1', 0, 8, ['a', 'c']],
    ['u2', 5, 5, ['b']],
  ]);
});

test('delta stream materializes to the same state as the engine', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 1000 });
  const materialized = new Map<string, Session>();
  const apply = (deltas: SessionDelta[]) => {
    for (const d of deltas) {
      if (d.kind === 'added') materialized.set(d.session.sessionId, d.session);
      else materialized.delete(d.session.sessionId);
    }
  };
  apply(s.addEvent(ev('a', 'u', 0)));
  apply(s.addEvent(ev('b', 'u', 20)));
  apply(s.addEvent(ev('c', 'u', 10))); // bridge
  apply(s.retractEvent('c')); // split
  apply(s.retractEvent('a'));
  const fromDeltas = [...materialized.values()].sort((x, y) =>
    x.sessionId < y.sessionId ? -1 : 1,
  );
  assert.deepEqual(fromDeltas, s.getSessions());
  assert.deepEqual(
    fromDeltas,
    referenceSessions([ev('b', 'u', 20)], 10),
  );
});
