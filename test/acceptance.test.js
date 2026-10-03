import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GateState } from '../src/state.js';
import { buildSchedule, shiftMinutes, crossesMidnight } from '../src/schedule.js';
import { parseEvents } from '../src/events.js';
import { baseConfig, mulberry32 } from './helpers.js';

const T0 = '2026-10-04T20:00:00Z';
const iso = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();

function ev(seq, type, orderId, extra = {}) {
  return { seq, ts: iso(seq * 10), type, orderId, actor: 'planner', priority: 1, ...extra };
}

test('A: three-shift rotation crossing midnight', () => {
  const config = baseConfig();
  assert.equal(config.calendar.shifts.length, 3);
  const s3 = config.calendar.shifts[2];
  assert.equal(crossesMidnight(s3), true);
  assert.equal(shiftMinutes(s3), 480);
  assert.equal(crossesMidnight(config.calendar.shifts[0]), false);

  const state = new GateState(config);
  state.apply(ev(1, 'release', 'W1'));
  state.apply(ev(2, 'release', 'W2'));
  state.apply(ev(3, 'release', 'W3'));
  const sched = buildSchedule(config, state);
  assert.equal(sched.queue.length, 3);
  const w1 = sched.queue.find((q) => q.orderId === 'W1');
  assert.equal(w1.shift, 'S3');
  assert.equal(w1.start, '22:00');
  assert.equal(w1.end, '06:00');
  assert.equal(w1.crossesMidnight, true);
  // W1+W2 consume 240 of WC1/S3's 480 minutes
  assert.equal(sched.remainingCapability.WC1.S3, 240);
  assert.equal(sched.remainingCapability.WC2.S1, 180);
});

test('B: material locks restored after supervisor revokes freeze', () => {
  const config = baseConfig();
  const state = new GateState(config);
  state.apply(ev(1, 'release', 'W1'));
  assert.equal(state.derived.available.M1, 90);
  assert.equal(state.isReleasable('W1'), true);

  state.apply(ev(2, 'freeze', 'W1', { actor: 'planner', priority: 1, ts: iso(20) }));
  assert.equal(state.isReleasable('W1'), false);
  assert.equal(state.derived.available.M1, 100); // locks returned
  assert.equal(state.compensations.length, 1); // compensation event generated
  assert.equal(state.compensations[0].type, 'compensate');
  assert.deepEqual(state.compensations[0].locks, { M1: 10 });

  state.apply(ev(3, 'revoke', 'W1', { actor: 'supervisor', priority: 2, ts: iso(30) }));
  assert.equal(state.isReleasable('W1'), true);
  assert.equal(state.derived.available.M1, 90); // locks restored
  // history untouched: journal only ever appended
  assert.equal(state.journal.length, 3);
});

test('B2: non-supervisor cannot revoke a freeze', () => {
  const config = baseConfig();
  const state = new GateState(config);
  state.apply(ev(1, 'release', 'W1'));
  state.apply(ev(2, 'freeze', 'W1', { ts: iso(20) }));
  state.apply(ev(3, 'revoke', 'W1', { actor: 'planner', priority: 1, ts: iso(30) }));
  assert.equal(state.isReleasable('W1'), false);
  assert.ok(state.breaches.some((b) => b.type === 'unauthorized-revoke'));
});

test('C: concurrent same-timestamp events use deterministic tie-break', () => {
  const config = baseConfig();
  const ts = iso(10);
  // same ts, same priority: freeze wins regardless of file order
  for (const order of [
    [
      { seq: 1, ts, type: 'release', orderId: 'W1', actor: 'planner', priority: 1 },
      { seq: 2, ts, type: 'freeze', orderId: 'W1', actor: 'planner', priority: 1 },
    ],
    [
      { seq: 1, ts, type: 'freeze', orderId: 'W1', actor: 'planner', priority: 1 },
      { seq: 2, ts, type: 'release', orderId: 'W1', actor: 'planner', priority: 1 },
    ],
  ]) {
    const state = GateState.replay(config, order);
    assert.equal(state.isReleasable('W1'), false, `order ${order.map((e) => e.type)} must end frozen`);
  }
  // same ts, higher priority release beats lower priority freeze
  const state = GateState.replay(config, [
    { seq: 1, ts, type: 'freeze', orderId: 'W1', actor: 'planner', priority: 1 },
    { seq: 2, ts, type: 'release', orderId: 'W1', actor: 'supervisor', priority: 2 },
  ]);
  assert.equal(state.isReleasable('W1'), true);
  // later timestamp always wins over priority
  const state2 = GateState.replay(config, [
    { seq: 1, ts, type: 'release', orderId: 'W1', actor: 'supervisor', priority: 2 },
    { seq: 2, ts: iso(20), type: 'freeze', orderId: 'W1', actor: 'planner', priority: 1 },
  ]);
  assert.equal(state2.isReleasable('W1'), false);
});

test('D: 100 random events, incremental state matches brute-force replay at every prefix', () => {
  const config = baseConfig();
  const rand = mulberry32(20261004);
  const types = ['release', 'freeze', 'revoke', 'reschedule'];
  const orders = ['W1', 'W2', 'W3'];
  const actors = ['planner', 'supervisor'];
  const shifts = ['S1', 'S2', 'S3'];
  const events = [];
  let tsMs = Date.parse(T0);
  for (let i = 0; i < 100; i++) {
    tsMs += Math.floor(rand() * 4) * 60_000; // 0..3 min steps -> frequent same-ts clusters
    const type = types[Math.floor(rand() * types.length)];
    const e = {
      seq: i + 1,
      ts: new Date(tsMs).toISOString(),
      type,
      orderId: orders[Math.floor(rand() * orders.length)],
      actor: actors[Math.floor(rand() * actors.length)],
      priority: 1 + Math.floor(rand() * 2),
    };
    if (type === 'reschedule') e.toShift = shifts[Math.floor(rand() * shifts.length)];
    events.push(e);
  }
  // incremental pass
  const inc = new GateState(config);
  const hashes = [];
  for (const e of events) {
    inc.apply(e);
    hashes.push(inc.hash());
  }
  // brute-force replay from scratch for every prefix
  for (let k = 1; k <= events.length; k++) {
    const re = GateState.replay(config, events, k);
    assert.equal(re.hash(), hashes[k - 1], `prefix ${k} hash mismatch`);
  }
  // and the full final state snapshot must be identical
  const full = GateState.replay(config, events);
  assert.deepEqual(full.snapshotData(), inc.snapshotData());
});

test('D2: parseEvents accepts the random stream (monotonic ts)', () => {
  const rand = mulberry32(7);
  let tsMs = Date.parse(T0);
  const lines = [];
  for (let i = 0; i < 100; i++) {
    tsMs += Math.floor(rand() * 2) * 1000;
    lines.push(JSON.stringify({ ts: new Date(tsMs).toISOString(), type: 'release', orderId: 'W1' }));
  }
  const events = parseEvents(lines.join('\n'));
  assert.equal(events.length, 100);
  assert.equal(events[99].seq, 100);
});
