import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../src/config.js';
import { foldEvents, createState, applyEvent } from '../src/state.js';
import { buildSchedule } from '../src/schedule.js';
import { findCounterexample, isReleasable } from '../src/counterexample.js';
import { canonical, stateHash } from '../src/serialize.js';
import { threeShiftConfig, mulberry32 } from './helpers.js';

const T0 = '2026-10-04T20:00:00Z';
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();

test('A: three-shift rotation crossing midnight', () => {
  const idx = buildIndex(threeShiftConfig());
  const events = [
    { seq: 1, ts: Date.parse(at(0)), type: 'release', order: 'WO-2', priority: 0, actor: 'planner' },
    { seq: 2, ts: Date.parse(at(30)), type: 'reschedule', order: 'WO-2', to: Date.parse('2026-10-04T22:30:00Z'), actor: 'planner' },
  ];
  const state = foldEvents(events, idx);
  const { schedule } = buildSchedule(idx, state, '2026-10-04');
  assert.equal(schedule.shifts.length, 3);
  const night = schedule.shifts[2];
  assert.equal(night.name, 'night');
  assert.equal(night.start, '2026-10-04T22:00:00.000Z');
  assert.equal(night.end, '2026-10-05T06:00:00.000Z', 'night shift wraps past midnight');
  assert.equal(night.orders.length, 1);
  const placed = night.orders[0];
  assert.equal(placed.order, 'WO-2');
  assert.equal(placed.start, '2026-10-04T22:30:00.000Z');
  assert.equal(placed.end, '2026-10-05T06:30:00.000Z', '8h job from 22:30 ends next day');
  assert.equal(placed.crossesMidnight, true);
});

test('B: revoke freeze restores material locks, history untouched', () => {
  const idx = buildIndex(threeShiftConfig());
  const events = [
    { seq: 1, ts: Date.parse(at(0)), type: 'release', order: 'WO-2', priority: 0, actor: 'planner' },
    { seq: 2, ts: Date.parse(at(10)), type: 'freeze', order: 'WO-2', priority: 0, actor: 'planner' },
    { seq: 3, ts: Date.parse(at(20)), type: 'revoke', target: 2, actor: 'supervisor' },
  ];
  const snapshotIn = structuredClone(events);
  const state = createState(idx);

  applyEvent(state, events[0], idx);
  assert.deepEqual(state.orders['WO-2'].locks, { 'M-1': 1, 'M-2': 2 }, 'release consumes locks');
  assert.equal(state.stock['M-1'], 9);
  assert.equal(state.stock['M-2'], 2);

  applyEvent(state, events[1], idx);
  assert.equal(state.orders['WO-2'].decision, 'frozen');
  assert.deepEqual(state.orders['WO-2'].locks, {}, 'freeze frees locks');
  assert.equal(state.stock['M-1'], 10);
  assert.equal(state.stock['M-2'], 4);
  assert.equal(state.compensations.length, 1, 'consumed locks force a compensation event');
  assert.deepEqual(state.compensations[0].restores, { 'M-1': 1, 'M-2': 2 });
  assert.equal(state.compensations[0].cause, 2);

  applyEvent(state, events[2], idx);
  assert.equal(state.orders['WO-2'].decision, 'released', 'supervisor revoke reinstates release');
  assert.deepEqual(state.orders['WO-2'].locks, { 'M-1': 1, 'M-2': 2 }, 'locks restored');
  assert.equal(state.stock['M-1'], 9);
  assert.equal(state.stock['M-2'], 2);

  assert.deepEqual(events, snapshotIn, 'input history is never mutated');
});

test('C: same-instant release/freeze resolves deterministically, freeze wins', () => {
  const idx = buildIndex(threeShiftConfig());
  const sameTs = Date.parse(at(0));
  const release = { seq: 0, ts: sameTs, type: 'release', order: 'WO-1', priority: 0, actor: 'planner' };
  const freeze = { seq: 0, ts: sameTs, type: 'freeze', order: 'WO-1', priority: 0, actor: 'planner' };

  const orderA = [{ ...release, seq: 1 }, { ...freeze, seq: 2 }];
  const orderB = [{ ...freeze, seq: 1 }, { ...release, seq: 2 }];
  for (const evs of [orderA, orderB]) {
    const state = foldEvents(evs, idx);
    assert.equal(state.orders['WO-1'].decision, 'frozen', 'freeze wins the tie regardless of file order');
  }
  // Determinism: folding the same log twice yields identical hashes.
  const h1 = stateHash(foldEvents(orderA, idx));
  const h2 = stateHash(foldEvents(orderA, idx));
  assert.equal(h1, h2);
});

test('D: 100 random events - incremental snapshots match brute-force replay', () => {
  const idx = buildIndex(threeShiftConfig());
  const rand = mulberry32(20261004);
  const orderIds = ['WO-1', 'WO-2', 'WO-3', 'WO-4'];
  const events = [];
  let t = Date.parse(T0);
  for (let i = 1; i <= 100; i++) {
    t += Math.floor(rand() * 5) * 60000; // non-decreasing, ties allowed
    const roll = rand();
    const order = orderIds[Math.floor(rand() * orderIds.length)];
    if (roll < 0.4) {
      events.push({ seq: i, ts: t, type: 'release', order, priority: Math.floor(rand() * 3), actor: 'planner' });
    } else if (roll < 0.7) {
      events.push({ seq: i, ts: t, type: 'freeze', order, priority: Math.floor(rand() * 3), actor: 'planner' });
    } else if (roll < 0.85) {
      const freezes = events.filter((e) => e.type === 'freeze');
      const target = freezes.length ? freezes[Math.floor(rand() * freezes.length)].seq : 1;
      const actor = rand() < 0.8 ? 'supervisor' : 'planner';
      events.push({ seq: i, ts: t, type: 'revoke', target, actor });
    } else {
      events.push({ seq: i, ts: t, type: 'reschedule', order, to: t + 3600000, actor: 'planner' });
    }
  }

  // Incremental fold, snapshotting after every event.
  const snapshots = [structuredClone(createState(idx))];
  let state = createState(idx);
  for (const e of events) {
    applyEvent(state, e, idx);
    snapshots.push(structuredClone(state));
  }
  const fullHash = stateHash(state);

  // Brute force: replay every prefix from scratch, compare with snapshots.
  for (const k of [0, 1, 2, 17, 50, 77, 99, 100]) {
    const brute = foldEvents(events.slice(0, k), idx);
    assert.equal(stateHash(brute), stateHash(snapshots[k]), `prefix ${k} mismatch`);
  }

  // Replay from arbitrary event numbers: snapshot k + suffix == full state.
  for (const k of [0, 1, 23, 42, 63, 88, 99]) {
    const resumed = structuredClone(snapshots[k]);
    foldEvents(events.slice(k), idx, resumed);
    assert.equal(canonical(resumed), canonical(state), `replay from event ${k} diverges`);
    assert.equal(stateHash(resumed), fullHash);
  }
});

test('counterexample: minimal sequence flipping a releasable order', () => {
  const idx = buildIndex(threeShiftConfig());
  const events = [
    { seq: 1, ts: Date.parse(at(0)), type: 'release', order: 'WO-1', priority: 0, actor: 'planner' },
  ];
  const base = foldEvents(events, idx);
  assert.equal(isReleasable(idx, base, 'WO-1'), true);

  const result = findCounterexample(idx, events, 'WO-1');
  assert.ok(result, 'a counterexample exists');
  assert.equal(result.sequence.length, 1, 'minimal sequence is a single freeze');
  assert.equal(result.sequence[0].type, 'freeze');
  assert.equal(result.sequence[0].order, 'WO-1');

  const flipped = foldEvents([...events, ...result.sequence], idx);
  assert.equal(isReleasable(idx, flipped, 'WO-1'), false);

  // Already non-releasable orders yield no counterexample.
  const frozenEvents = [...events, { seq: 2, ts: Date.parse(at(5)), type: 'freeze', order: 'WO-1', priority: 0, actor: 'planner' }];
  assert.equal(findCounterexample(idx, frozenEvents, 'WO-1'), null);
});
