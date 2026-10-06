import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  SessionDelta,
  SessionEvent,
  Sessionizer,
  sessionKey,
} from '../src/sessionizer';
import { referenceSessions } from '../src/reference';

const ev = (userId: string, eventId: string, ts: number): SessionEvent => ({
  userId,
  eventId,
  ts,
});

const summarize = (sessions: Session[]): string[] =>
  sessions.map((s) => `${s.userId}[${s.start}..${s.end}]x${s.count}`);

test('gap <= G groups into one session, larger gap splits', () => {
  const s = new Sessionizer({ gapMs: 10 });
  s.add(ev('u1', 'a', 0));
  s.add(ev('u1', 'b', 10)); // gap 10 <= G: same session
  s.add(ev('u1', 'c', 25)); // gap 15 > G: new session
  assert.deepEqual(summarize(s.getSessions('u1')), [
    'u1[0..10]x2',
    'u1[25..25]x1',
  ]);
});

test('out-of-order event bridges two sessions into one', () => {
  const s = new Sessionizer({ gapMs: 10 });
  s.add(ev('u1', 'a', 0));
  s.add(ev('u1', 'c', 20));
  assert.deepEqual(summarize(s.getSessions('u1')), [
    'u1[0..0]x1',
    'u1[20..20]x1',
  ]);

  const deltas = s.add(ev('u1', 'b', 10)); // bridges both sides
  assert.deepEqual(summarize(s.getSessions('u1')), ['u1[0..20]x3']);

  // session identity = start ts: the earlier session absorbs the later one
  const removed = deltas.filter((d) => d.type === 'removed');
  const updated = deltas.filter((d) => d.type === 'updated');
  assert.equal(deltas.length, 2);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].type === 'removed' && removed[0].before.start, 20);
  assert.equal(updated.length, 1);
  const up = updated[0];
  assert.equal(up.type === 'updated' && up.before.end, 0);
  assert.equal(up.type === 'updated' && up.after.end, 20);
  assert.equal(up.type === 'updated' && up.after.count, 3);
});

test('retracting the bridge event splits the session back', () => {
  const s = new Sessionizer({ gapMs: 10 });
  s.add(ev('u1', 'a', 0));
  s.add(ev('u1', 'c', 20));
  s.add(ev('u1', 'b', 10));
  assert.deepEqual(summarize(s.getSessions('u1')), ['u1[0..20]x3']);

  const deltas = s.retract('u1', 'b');
  assert.deepEqual(summarize(s.getSessions('u1')), [
    'u1[0..0]x1',
    'u1[20..20]x1',
  ]);

  // the head session survives (shrinks), the tail session is new
  const updated = deltas.filter((d) => d.type === 'updated');
  const added = deltas.filter((d) => d.type === 'added');
  assert.equal(deltas.length, 2);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].type === 'updated' && updated[0].after.end, 0);
  assert.equal(added.length, 1);
  assert.equal(added[0].type === 'added' && added[0].after.start, 20);
});

test('retracting an edge event updates instead of splitting', () => {
  const s = new Sessionizer({ gapMs: 10 });
  s.add(ev('u1', 'a', 0));
  s.add(ev('u1', 'b', 5));
  s.add(ev('u1', 'c', 10));
  const deltas = s.retract('u1', 'a');
  assert.deepEqual(summarize(s.getSessions('u1')), ['u1[5..10]x2']);
  // start moved 0 -> 5: old session removed, new one added
  assert.equal(deltas.filter((d) => d.type === 'removed').length, 1);
  assert.equal(deltas.filter((d) => d.type === 'added').length, 1);

  const deltas2 = s.add(ev('u1', 'd', 20)); // extends tail, same start
  assert.equal(deltas2.length, 1);
  assert.equal(deltas2[0].type, 'updated');
});

test('duplicate add and unknown retract are no-ops', () => {
  const s = new Sessionizer({ gapMs: 10 });
  s.add(ev('u1', 'a', 0));
  assert.deepEqual(s.add(ev('u1', 'a', 0)), []);
  assert.deepEqual(s.retract('u1', 'nope'), []);
  assert.deepEqual(s.retract('ghost', 'a'), []);
  assert.deepEqual(summarize(s.getSessions('u1')), ['u1[0..0]x1']);
});

test('watermark rejects events beyond allowed lateness', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 20 });
  s.add(ev('u1', 'a', 100));
  s.advanceWatermark(100); // horizon = 80
  assert.equal(s.isTooLate(79), true);
  assert.equal(s.isTooLate(80), false);

  assert.deepEqual(s.add(ev('u1', 'late', 50)), []); // dropped
  assert.notDeepEqual(s.add(ev('u1', 'ok', 90)), []); // accepted
  assert.deepEqual(summarize(s.getSessions('u1')), ['u1[90..100]x2']);
});

test('watermark GC keeps only the allowed-lateness range and emits deltas', () => {
  const s = new Sessionizer({ gapMs: 10, allowedLatenessMs: 20 });
  s.add(ev('u1', 'a', 0));
  s.add(ev('u1', 'b', 5));
  s.add(ev('u1', 'c', 100));

  const deltas = s.advanceWatermark(100); // horizon = 80, drops a and b
  assert.deepEqual(summarize(s.getSessions('u1')), ['u1[100..100]x1']);
  const removedStarts = deltas
    .filter((d) => d.type === 'removed')
    .map((d) => d.type === 'removed' && d.before.start);
  assert.deepEqual(removedStarts, [0]);
  // the surviving session [100..100] is untouched: no added/updated deltas
  assert.equal(deltas.filter((d) => d.type !== 'removed').length, 0);

  // watermark never goes backwards
  assert.deepEqual(s.advanceWatermark(50), []);
  assert.equal(s.currentWatermark, 100);
});

test('directed: bridge then retract matches full-sort reference', () => {
  const gapMs = 10;
  const s = new Sessionizer({ gapMs });
  const live: SessionEvent[] = [];
  const apply = (e: SessionEvent): void => {
    s.add(e);
    live.push(e);
  };
  apply(ev('u1', 'e0', 0));
  apply(ev('u1', 'e1', 8));
  apply(ev('u1', 'e2', 40));
  apply(ev('u1', 'e3', 48));
  // two sessions: [0..8], [40..48]; bridge them out of order
  apply(ev('u1', 'bridge1', 16));
  apply(ev('u1', 'bridge2', 24));
  apply(ev('u1', 'bridge3', 32));
  assert.deepEqual(s.getSessions(), referenceSessions(live, gapMs));
  assert.deepEqual(summarize(s.getSessions('u1')), ['u1[0..48]x7']);

  // retract the bridges one by one; every step must match the reference
  for (const id of ['bridge2', 'bridge1', 'bridge3']) {
    s.retract('u1', id);
    live.splice(live.findIndex((e) => e.eventId === id), 1);
    assert.deepEqual(s.getSessions(), referenceSessions(live, gapMs));
  }
  assert.deepEqual(summarize(s.getSessions('u1')), [
    'u1[0..8]x2',
    'u1[40..48]x2',
  ]);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized: incremental state and delta stream match reference', () => {
  const gapMs = 10;
  const allowedLatenessMs = 30;
  const users = ['u0', 'u1', 'u2'];
  const rand = mulberry32(42);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  for (let trial = 0; trial < 20; trial++) {
    const s = new Sessionizer({ gapMs, allowedLatenessMs });
    const live: SessionEvent[] = [];
    const materialized = new Map<string, Session>();
    let watermark = Number.NEGATIVE_INFINITY;
    let seq = 0;

    const applyDeltas = (deltas: SessionDelta[]): void => {
      for (const d of deltas) {
        if (d.type === 'removed') {
          assert.ok(materialized.delete(sessionKey(d.before)));
        } else if (d.type === 'added') {
          materialized.set(sessionKey(d.after), d.after);
        } else {
          assert.ok(materialized.delete(sessionKey(d.before)));
          materialized.set(sessionKey(d.after), d.after);
        }
      }
    };

    const check = (): void => {
      const expected = referenceSessions(live, gapMs);
      assert.deepEqual(s.getSessions(), expected);
      const fromDeltas = [...materialized.values()].sort(
        (a, b) =>
          (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0) ||
          a.start - b.start,
      );
      assert.deepEqual(fromDeltas, expected);
    };

    for (let op = 0; op < 300; op++) {
      const kind = rand();
      if (kind < 0.55) {
        // add, often out of order across the whole timeline
        const e = ev(pick(users), `t${trial}-e${seq++}`, Math.floor(rand() * 400));
        if (watermark !== Number.NEGATIVE_INFINITY && s.isTooLate(e.ts)) {
          assert.deepEqual(s.add(e), []);
        } else {
          applyDeltas(s.add(e));
          live.push(e);
        }
      } else if (kind < 0.8) {
        // retract a random live event (or a random unknown id)
        if (live.length > 0 && rand() < 0.9) {
          const target = pick(live);
          applyDeltas(s.retract(target.userId, target.eventId));
          live.splice(live.indexOf(target), 1);
        } else {
          assert.deepEqual(s.retract(pick(users), 'missing'), []);
        }
      } else {
        // advance watermark (never beyond max live ts + slack)
        const next = watermark === Number.NEGATIVE_INFINITY
          ? Math.floor(rand() * 100)
          : watermark + Math.floor(rand() * 40);
        watermark = next;
        applyDeltas(s.advanceWatermark(next));
        const horizon = next - allowedLatenessMs;
        for (let i = live.length - 1; i >= 0; i--) {
          if (live[i].ts < horizon) live.splice(i, 1);
        }
      }
      check();
    }
  }
});
