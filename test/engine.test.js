'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/engine');
const { fullRecompute } = require('../src/reference');
const { DomainError } = require('../src/validate');

const H = 3600 * 1000;
const SHIFTS = [
  { id: 'S1', start: '2026-01-01T00:00:00Z', end: '2026-01-01T08:00:00Z' },
  { id: 'S2', start: '2026-01-01T08:00:00Z', end: '2026-01-01T16:00:00Z' },
];

function metric(store, id) {
  return store.shiftMetrics().find((s) => s.id === id);
}

test('out-of-order backfill merges sessions and matches full recompute', () => {
  const events = [
    { id: 'a', start: '2026-01-01T01:00:00Z', end: '2026-01-01T02:00:00Z', state: 'RUN' },
    { id: 'b', start: '2026-01-01T03:00:00Z', end: '2026-01-01T04:00:00Z', state: 'FAIL' },
    { id: 'c', start: '2026-01-01T02:00:00Z', end: '2026-01-01T03:00:00Z', state: 'RUN' }, // late, bridges a
    { id: 'd', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z', state: 'RUN' }, // backfill before a
    { id: 'e', start: '2026-01-01T04:00:00Z', end: '2026-01-01T05:00:00Z', state: 'IDLE' },
  ];
  const store = new Store(SHIFTS);
  const diffs = events.map((e) => store.append(e));

  const sessions = store.sessionList();
  assert.deepEqual(
    sessions.map((s) => [s.state, s.start, s.end]),
    [
      ['RUN', '2026-01-01T00:00:00.000Z', '2026-01-01T03:00:00.000Z'],
      ['FAIL', '2026-01-01T03:00:00.000Z', '2026-01-01T04:00:00.000Z'],
      ['IDLE', '2026-01-01T04:00:00.000Z', '2026-01-01T05:00:00.000Z'],
    ],
  );

  // metrics changed as late events landed
  const s1 = metric(store, 'S1');
  assert.equal(s1.runMs, 3 * H);
  assert.equal(s1.failMs, 1 * H);
  assert.equal(s1.availability, 3 / 8);
  assert.equal(metric(store, 'S2').runMs, 0);

  // the bridging append rewrote the RUN session (extended) and re-emitted its
  // FAIL neighbor because both intersect the rebuild window
  const bridgeDiff = diffs[2];
  assert.equal(bridgeDiff.removedSessions.length, 2);
  assert.equal(bridgeDiff.addedSessions.length, 2);
  assert.equal(bridgeDiff.addedSessions[0].durationMs, 2 * H);

  // incremental result identical to full-sort recompute reference
  const ref = fullRecompute(events, SHIFTS);
  assert.deepEqual(store.sessionList(), ref.sessions);
  assert.deepEqual(store.shiftMetrics(), ref.shifts);
});

test('retroactive correction propagates across shift boundary', () => {
  const store = new Store(SHIFTS);
  store.append({ id: 'x', start: '2026-01-01T06:00:00Z', end: '2026-01-01T08:00:00Z', state: 'RUN' });
  const diff = store.correct('x', { start: '2026-01-01T06:00:00Z', end: '2026-01-01T10:00:00Z', state: 'RUN' });

  const s1 = metric(store, 'S1');
  const s2 = metric(store, 'S2');
  assert.equal(s1.runMs, 2 * H);
  assert.equal(s2.runMs, 2 * H);
  assert.equal(s1.availability, 2 / 8);
  assert.equal(s2.availability, 2 / 8);

  // diff reports only the shift whose metrics actually changed (S1 kept 2h RUN)
  const shiftIds = diff.shifts.map((s) => s.id).sort();
  assert.deepEqual(shiftIds, ['S2']);
  const s2diff = diff.shifts.find((s) => s.id === 'S2');
  assert.equal(s2diff.before.runMs, 0);
  assert.equal(s2diff.after.runMs, 2 * H);

  // matches reference recompute
  const ref = fullRecompute(
    [{ id: 'x', start: '2026-01-01T06:00:00Z', end: '2026-01-01T10:00:00Z', state: 'RUN' }],
    SHIFTS,
  );
  assert.deepEqual(store.sessionList(), ref.sessions);
  assert.deepEqual(store.shiftMetrics(), ref.shifts);
});

test('delete splits nothing but removes session contribution; undo/redo restore state', () => {
  const store = new Store(SHIFTS);
  store.append({ id: 'a', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z', state: 'RUN' });
  store.append({ id: 'b', start: '2026-01-01T01:00:00Z', end: '2026-01-01T02:00:00Z', state: 'RUN' });
  const hashBefore = store.version();
  assert.equal(store.sessionList().length, 1); // merged

  // deleting the middle piece is impossible (no such interval), delete b
  store.delete('b');
  assert.equal(store.sessionList().length, 1);
  assert.equal(metric(store, 'S1').runMs, 1 * H);

  store.undo();
  assert.equal(store.version(), hashBefore);
  assert.equal(metric(store, 'S1').runMs, 2 * H);

  store.redo();
  assert.equal(metric(store, 'S1').runMs, 1 * H);
  store.undo();
  assert.equal(store.version(), hashBefore);

  // undo of append removes the interval entirely
  store.undo();
  store.undo();
  assert.equal(store.sessionList().length, 0);
  assert.equal(metric(store, 'S1').runMs, 0);
});

test('undo/redo across a correct restores exact hash', () => {
  const store = new Store(SHIFTS);
  store.append({ id: 'a', start: '2026-01-01T00:00:00Z', end: '2026-01-01T02:00:00Z', state: 'RUN' });
  const h0 = store.version();
  store.correct('a', { start: '2026-01-01T00:00:00Z', end: '2026-01-01T03:00:00Z', state: 'FAIL' });
  assert.notEqual(store.version(), h0);
  store.undo();
  assert.equal(store.version(), h0);
  store.redo();
  assert.equal(metric(store, 'S1').failMs, 3 * H);
  store.undo();
  assert.equal(store.version(), h0);
});

test('overlap, backward clock, unknown state and unknown id are rejected', () => {
  const store = new Store(SHIFTS);
  store.append({ id: 'a', start: '2026-01-01T01:00:00Z', end: '2026-01-01T02:00:00Z', state: 'RUN' });

  assert.throws(
    () => store.append({ id: 'b', start: '2026-01-01T01:30:00Z', end: '2026-01-01T03:00:00Z', state: 'IDLE' }),
    (err) => err instanceof DomainError && err.code === 'OVERLAP',
  );
  assert.throws(
    () => store.append({ id: 'c', start: '2026-01-01T03:00:00Z', end: '2026-01-01T03:00:00Z', state: 'IDLE' }),
    (err) => err.code === 'BACKWARD_CLOCK',
  );
  assert.throws(
    () => store.append({ id: 'd', start: '2026-01-01T03:00:00Z', end: '2026-01-01T04:00:00Z', state: 'BOGUS' }),
    (err) => err.code === 'UNKNOWN_STATE',
  );
  assert.throws(() => store.delete('nope'), (err) => err.code === 'UNKNOWN_ID');
  assert.throws(
    () => store.correct('nope', { start: '2026-01-01T03:00:00Z', end: '2026-01-01T04:00:00Z', state: 'RUN' }),
    (err) => err.code === 'UNKNOWN_ID',
  );

  // failed mutations leave the store untouched
  assert.equal(store.sessionList().length, 1);
  assert.equal(metric(store, 'S1').runMs, 1 * H);
});

test('correct that would overlap is rejected and original interval restored', () => {
  const store = new Store(SHIFTS);
  store.append({ id: 'a', start: '2026-01-01T01:00:00Z', end: '2026-01-01T02:00:00Z', state: 'RUN' });
  store.append({ id: 'b', start: '2026-01-01T03:00:00Z', end: '2026-01-01T04:00:00Z', state: 'RUN' });
  assert.throws(
    () => store.correct('a', { start: '2026-01-01T01:00:00Z', end: '2026-01-01T03:30:00Z', state: 'RUN' }),
    (err) => err.code === 'OVERLAP',
  );
  const sessions = store.sessionList();
  assert.equal(sessions.length, 2);
  assert.equal(metric(store, 'S1').runMs, 2 * H);
});

test('randomized out-of-order mutations always match full recompute', () => {
  // deterministic PRNG
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const states = ['RUN', 'IDLE', 'FAIL', 'MAINT'];
  const base = Date.parse('2026-01-01T00:00:00Z');
  const shifts = [
    { id: 'S1', start: base, end: base + 8 * H },
    { id: 'S2', start: base + 8 * H, end: base + 16 * H },
  ];

  for (let trial = 0; trial < 20; trial += 1) {
    // generate a random non-overlapping interval set on a 30-min grid
    const slots = 32;
    const grid = new Array(slots).fill(null);
    for (let i = 0; i < slots; i += 1) {
      if (rand() < 0.7) grid[i] = states[Math.floor(rand() * states.length)];
    }
    const events = [];
    let n = 0;
    for (let i = 0; i < slots; i += 1) {
      if (!grid[i]) continue;
      n += 1;
      events.push({
        id: `t${trial}e${n}`,
        start: new Date(base + i * 0.5 * H).toISOString(),
        end: new Date(base + (i + 1) * 0.5 * H).toISOString(),
        state: grid[i],
      });
    }
    // shuffle append order
    const order = events.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    const store = new Store(shifts);
    const applied = [];
    for (const idx of order) {
      store.append(events[idx]);
      applied.push(events[idx]);
    }
    // random deletes and corrects
    for (const idx of order) {
      if (rand() < 0.3) {
        store.delete(events[idx].id);
        applied.splice(applied.findIndex((e) => e.id === events[idx].id), 1);
      } else if (rand() < 0.3) {
        const i = Math.floor((Date.parse(events[idx].start) - base) / (0.5 * H));
        const newState = states[Math.floor(rand() * states.length)];
        store.correct(events[idx].id, {
          start: new Date(base + i * 0.5 * H).toISOString(),
          end: new Date(base + (i + 1) * 0.5 * H).toISOString(),
          state: newState,
        });
        applied.find((e) => e.id === events[idx].id).state = newState;
      }
    }

    const ref = fullRecompute(applied, shifts);
    assert.deepEqual(store.sessionList(), ref.sessions, `sessions mismatch in trial ${trial}`);
    assert.deepEqual(store.shiftMetrics(), ref.shifts, `metrics mismatch in trial ${trial}`);
  }
});
