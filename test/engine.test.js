'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { computeReference } = require('../src/reference');
const { OeeError } = require('../src/model');

const H = 3600 * 1000;
const iso = (h) => new Date(h * H).toISOString();

function makeEngine(intervals = []) {
  const engine = new Engine();
  engine.loadEvents({ intervals });
  return engine;
}

function assertMatchesReference(engine, allIntervals) {
  const snap = engine.snapshot();
  const ref = computeReference(allIntervals);
  assert.deepEqual(snap.sessions, ref.sessions, 'sessions must match full recompute');
  assert.deepEqual(snap.shifts, ref.shifts, 'shift metrics must match full recompute');
  return snap;
}

test('out-of-order backfill merges sessions and matches full recompute after every step', () => {
  const engine = makeEngine();
  const all = [];
  const appends = [
    { id: 'a1', device: 'press-1', start: iso(4), end: iso(6), state: 'RUN' },
    { id: 'a2', device: 'press-1', start: iso(0), end: iso(2), state: 'RUN' },
    { id: 'a3', device: 'press-1', start: iso(2), end: iso(4), state: 'RUN' },
    { id: 'a4', device: 'press-1', start: iso(6), end: iso(7), state: 'FAIL' },
    { id: 'a5', device: 'press-1', start: iso(7), end: iso(9), state: 'FAIL' },
    { id: 'a6', device: 'press-1', start: iso(9), end: iso(10), state: 'IDLE' },
  ];
  const seenMergedRun = [];
  for (const iv of appends) {
    const diff = engine.executeCommand({ op: 'append', interval: iv });
    all.push(iv);
    const snap = assertMatchesReference(engine, all);
    seenMergedRun.push(snap.sessions.filter((s) => s.state === 'RUN').map((s) => s.durationMs));
    assert.ok(diff.sessionsAdded.length > 0, 'append must produce a session diff');
  }
  assert.deepEqual(seenMergedRun[0], [2 * H]);
  assert.deepEqual(seenMergedRun[1], [2 * H, 2 * H]);
  assert.deepEqual(seenMergedRun[2], [6 * H], 'adjacent RUN intervals merge into one session');

  const snap = engine.snapshot();
  const run = snap.sessions.find((s) => s.state === 'RUN');
  assert.equal(run.start, iso(0));
  assert.equal(run.end, iso(6));
  assert.deepEqual(run.sourceIds, ['a2', 'a3', 'a1']);
  const fail = snap.sessions.find((s) => s.state === 'FAIL');
  assert.equal(fail.durationMs, 3 * H, 'backfilled FAIL intervals merge too');

  const shift0 = snap.shifts.find((s) => s.device === 'press-1' && s.shiftIndex === 0);
  assert.equal(shift0.runMs, 6 * H);
  assert.equal(shift0.failMs, 2 * H);
  assert.equal(shift0.availability, 6 / 8);
  const shift1 = snap.shifts.find((s) => s.device === 'press-1' && s.shiftIndex === 1);
  assert.equal(shift1.failMs, 1 * H);
  assert.equal(shift1.idleMs, 1 * H);
  assert.equal(shift1.availability, 0);
});

test('retroactive correction propagates metrics across shift boundary', () => {
  const engine = makeEngine([
    { id: 'e1', device: 'line-a', start: iso(6), end: iso(8), state: 'RUN' },
  ]);
  const before = engine.snapshot();
  assert.equal(before.shifts.length, 1);
  assert.equal(before.shifts[0].shiftIndex, 0);
  assert.equal(before.shifts[0].runMs, 2 * H);

  const diff = engine.executeCommand({
    op: 'correct',
    id: 'e1',
    interval: { start: iso(5), end: iso(10), state: 'RUN' },
  });
  const snap = engine.snapshot();
  assertMatchesReference(engine, [
    { id: 'e1', device: 'line-a', start: iso(5), end: iso(10), state: 'RUN' },
  ]);

  const s0 = snap.shifts.find((s) => s.shiftIndex === 0);
  const s1 = snap.shifts.find((s) => s.shiftIndex === 1);
  assert.equal(s0.runMs, 3 * H, 'correction extends RUN earlier within shift 0');
  assert.equal(s1.runMs, 2 * H, 'correction extends RUN into the next shift');
  assert.equal(s1.availability, 1);

  const changed = diff.shifts.map((d) => d.shiftIndex).sort();
  assert.deepEqual(changed, [0, 1], 'diff reports both affected shifts');
  const shift0Diff = diff.shifts.find((d) => d.shiftIndex === 0);
  assert.equal(shift0Diff.before.runMs, 2 * H);
  assert.equal(shift0Diff.after.runMs, 3 * H);
  const shift1Diff = diff.shifts.find((d) => d.shiftIndex === 1);
  assert.equal(shift1Diff.before, null);
  assert.equal(shift1Diff.after.runMs, 2 * H);

  const session = snap.sessions.find((s) => s.device === 'line-a');
  assert.equal(session.end, iso(10));
  assert.equal(session.start, iso(5));
  assert.equal(session.durationMs, 5 * H);
});

test('correction changing state splits a merged session', () => {
  const engine = makeEngine([
    { id: 'x1', device: 'd1', start: iso(0), end: iso(2), state: 'RUN' },
    { id: 'x2', device: 'd1', start: iso(2), end: iso(4), state: 'RUN' },
    { id: 'x3', device: 'd1', start: iso(4), end: iso(6), state: 'RUN' },
  ]);
  assert.equal(engine.snapshot().sessions.length, 1);
  engine.executeCommand({ op: 'correct', id: 'x2', interval: { state: 'FAIL' } });
  const snap = engine.snapshot();
  assertMatchesReference(engine, [
    { id: 'x1', device: 'd1', start: iso(0), end: iso(2), state: 'RUN' },
    { id: 'x2', device: 'd1', start: iso(2), end: iso(4), state: 'FAIL' },
    { id: 'x3', device: 'd1', start: iso(4), end: iso(6), state: 'RUN' },
  ]);
  assert.equal(snap.sessions.length, 3);
  assert.deepEqual(snap.sessions.map((s) => s.state), ['RUN', 'FAIL', 'RUN']);
});

test('overlapping intervals on the same device are rejected and state is unchanged', () => {
  const engine = makeEngine([
    { id: 'o1', device: 'd1', start: iso(0), end: iso(4), state: 'RUN' },
  ]);
  const before = engine.snapshot();
  assert.throws(
    () =>
      engine.executeCommand({
        op: 'append',
        interval: { id: 'o2', device: 'd1', start: iso(3), end: iso(5), state: 'IDLE' },
      }),
    (err) => err instanceof OeeError && err.code === 'OVERLAP'
  );
  assert.deepEqual(engine.snapshot(), before, 'failed append must not mutate state');
});

test('touching intervals on the same device are not an overlap', () => {
  const engine = makeEngine([
    { id: 't1', device: 'd1', start: iso(0), end: iso(4), state: 'RUN' },
  ]);
  engine.executeCommand({
    op: 'append',
    interval: { id: 't2', device: 'd1', start: iso(4), end: iso(6), state: 'IDLE' },
  });
  assert.equal(engine.snapshot().sessions.length, 2);
});

test('unknown state is rejected', () => {
  const engine = makeEngine();
  assert.throws(
    () =>
      engine.executeCommand({
        op: 'append',
        interval: { id: 'u1', device: 'd1', start: iso(0), end: iso(1), state: 'BROKEN' },
      }),
    (err) => err instanceof OeeError && err.code === 'UNKNOWN_STATE'
  );
  assert.throws(
    () => makeEngine([{ id: 'u2', device: 'd1', start: iso(0), end: iso(1), state: 'run' }]),
    (err) => err instanceof OeeError && err.code === 'UNKNOWN_STATE'
  );
});

test('backward clock (end <= start) is rejected', () => {
  const engine = makeEngine();
  assert.throws(
    () =>
      engine.executeCommand({
        op: 'append',
        interval: { id: 'b1', device: 'd1', start: iso(5), end: iso(5), state: 'RUN' },
      }),
    (err) => err instanceof OeeError && err.code === 'BACKWARD_CLOCK'
  );
  assert.throws(
    () =>
      engine.executeCommand({
        op: 'append',
        interval: { id: 'b2', device: 'd1', start: iso(6), end: iso(5), state: 'RUN' },
      }),
    (err) => err instanceof OeeError && err.code === 'BACKWARD_CLOCK'
  );
});

test('delete removes interval, splits metrics, and unknown id fails', () => {
  const engine = makeEngine([
    { id: 'd1', device: 'dev', start: iso(0), end: iso(3), state: 'RUN' },
    { id: 'd2', device: 'dev', start: iso(3), end: iso(6), state: 'RUN' },
  ]);
  assert.equal(engine.snapshot().sessions.length, 1);
  const diff = engine.executeCommand({ op: 'delete', id: 'd2' });
  const snap = engine.snapshot();
  assertMatchesReference(engine, [
    { id: 'd1', device: 'dev', start: iso(0), end: iso(3), state: 'RUN' },
  ]);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].durationMs, 3 * H);
  assert.equal(snap.shifts[0].runMs, 3 * H);
  assert.ok(diff.sessionsRemoved.length >= 1);
  assert.throws(
    () => engine.executeCommand({ op: 'delete', id: 'nope' }),
    (err) => err instanceof OeeError && err.code === 'NOT_FOUND'
  );
});

test('undo and redo restore identical state and version hash', () => {
  const engine = makeEngine([
    { id: 'r1', device: 'dev', start: iso(0), end: iso(2), state: 'RUN' },
  ]);
  const v0 = engine.snapshot().version;
  engine.executeCommand({
    op: 'append',
    interval: { id: 'r2', device: 'dev', start: iso(2), end: iso(5), state: 'FAIL' },
  });
  const v1 = engine.snapshot().version;
  assert.notEqual(v0, v1);
  engine.executeCommand({ op: 'correct', id: 'r2', interval: { state: 'IDLE' } });
  const v2 = engine.snapshot().version;

  engine.executeCommand({ op: 'undo' });
  assert.equal(engine.snapshot().version, v1, 'undo restores previous version hash');
  engine.executeCommand({ op: 'undo' });
  assert.equal(engine.snapshot().version, v0);
  engine.executeCommand({ op: 'redo' });
  assert.equal(engine.snapshot().version, v1);
  engine.executeCommand({ op: 'redo' });
  assert.equal(engine.snapshot().version, v2, 'redo restores corrected state');
  assertMatchesReference(engine, [
    { id: 'r1', device: 'dev', start: iso(0), end: iso(2), state: 'RUN' },
    { id: 'r2', device: 'dev', start: iso(2), end: iso(5), state: 'IDLE' },
  ]);
});

test('undo/redo with empty stacks fail with structured errors', () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.executeCommand({ op: 'undo' }),
    (err) => err instanceof OeeError && err.code === 'NOTHING_TO_UNDO'
  );
  assert.throws(
    () => engine.executeCommand({ op: 'redo' }),
    (err) => err instanceof OeeError && err.code === 'NOTHING_TO_REDO'
  );
});

test('multi-device changes stay independent and deterministic', () => {
  const engine = makeEngine([
    { id: 'm1', device: 'b', start: iso(0), end: iso(1), state: 'RUN' },
    { id: 'm2', device: 'a', start: iso(0), end: iso(1), state: 'FAIL' },
  ]);
  engine.executeCommand({
    op: 'append',
    interval: { id: 'm3', device: 'a', start: iso(1), end: iso(2), state: 'RUN' },
  });
  const snap = engine.snapshot();
  assertMatchesReference(engine, [
    { id: 'm1', device: 'b', start: iso(0), end: iso(1), state: 'RUN' },
    { id: 'm2', device: 'a', start: iso(0), end: iso(1), state: 'FAIL' },
    { id: 'm3', device: 'a', start: iso(1), end: iso(2), state: 'RUN' },
  ]);
  assert.equal(snap.shifts.filter((s) => s.device === 'a')[0].failMs, 1 * H);
  assert.equal(snap.shifts.filter((s) => s.device === 'b')[0].runMs, 1 * H);

  const engine2 = makeEngine([
    { id: 'm2', device: 'a', start: iso(0), end: iso(1), state: 'FAIL' },
    { id: 'm3', device: 'a', start: iso(1), end: iso(2), state: 'RUN' },
    { id: 'm1', device: 'b', start: iso(0), end: iso(1), state: 'RUN' },
  ]);
  assert.equal(engine2.snapshot().version, snap.version, 'version hash is order-independent');
});

test('custom shift configuration from events is honored', () => {
  const engine = new Engine();
  engine.loadEvents({
    shift: { anchor: iso(0), lengthHours: 12 },
    intervals: [{ id: 's1', device: 'd', start: iso(10), end: iso(14), state: 'RUN' }],
  });
  const snap = engine.snapshot();
  assert.equal(snap.shifts.length, 2);
  assert.equal(snap.shifts[0].runMs, 2 * H);
  assert.equal(snap.shifts[1].runMs, 2 * H);
});

test('randomized differential test: incremental engine always matches full recompute', () => {
  let seed = 0xC0FFEE;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const states = ['RUN', 'IDLE', 'FAIL', 'MAINT'];
  const devices = ['d1', 'd2'];

  const engine = new Engine();
  engine.loadEvents({ shift: { anchor: iso(0), lengthHours: 8 }, intervals: [] });
  const live = new Map();
  let counter = 0;

  for (let step = 0; step < 300; step++) {
    const roll = rand();
    try {
      if (roll < 0.5 || live.size === 0) {
        const startH = Math.floor(rand() * 48);
        const lenH = 1 + Math.floor(rand() * 4);
        const iv = {
          id: `f${counter++}`,
          device: pick(devices),
          start: iso(startH),
          end: iso(startH + lenH),
          state: pick(states),
        };
        engine.executeCommand({ op: 'append', interval: iv });
        live.set(iv.id, iv);
      } else if (roll < 0.7) {
        const id = pick([...live.keys()]);
        const old = live.get(id);
        const patch = {};
        if (rand() < 0.5) patch.state = pick(states);
        if (rand() < 0.5) {
          const startH = Math.floor(rand() * 48);
          patch.start = iso(startH);
          patch.end = iso(startH + 1 + Math.floor(rand() * 4));
        }
        engine.executeCommand({ op: 'correct', id, interval: patch });
        live.set(id, { ...old, ...patch, id });
      } else if (roll < 0.85) {
        const id = pick([...live.keys()]);
        engine.executeCommand({ op: 'delete', id });
        live.delete(id);
      } else if (roll < 0.95) {
        engine.executeCommand({ op: 'undo' });
        rebuildLive();
      } else {
        engine.executeCommand({ op: 'redo' });
        rebuildLive();
      }
    } catch (err) {
      assert.ok(err instanceof OeeError, `unexpected error type: ${err}`);
      if (err.code === 'OVERLAP' || err.code === 'NOTHING_TO_UNDO' || err.code === 'NOTHING_TO_REDO') {
        rebuildLive();
      } else {
        throw err;
      }
    }
    assertMatchesReference(engine, [...live.values()]);
  }

  function rebuildLive() {
    live.clear();
    for (const iv of engine.snapshot().intervals) live.set(iv.id, iv);
  }
});
