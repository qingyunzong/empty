import { test } from 'node:test';
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import type { WorldConfig } from '../src/model.js';
import { replayEvents, statesEqual } from '../src/replay.js';
import {
  crossingActions,
  crossingWorld,
  deadlockActions,
  deadlockWorld,
} from '../src/scenarios.js';
import { Simulator } from '../src/simulator.js';
import type { SimEvent } from '../src/simulator.js';

function ofType<T extends SimEvent['type']>(
  events: SimEvent[],
  type: T,
): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

test('shared segment is mutually exclusive while two arms swap items', () => {
  const sim = new Simulator(crossingWorld(), { validateEachEvent: true });
  for (const action of crossingActions()) sim.submit(action);
  sim.run();

  equal(sim.results.length, 2);
  ok(sim.results.every((r) => r.ok), 'both deliveries should complete');
  deepEqual(sim.state.segments['A'].occupants, ['i2']);
  deepEqual(sim.state.segments['B'].occupants, ['i1']);
  ok(Object.values(sim.state.arms).every((a) => a.locks.length === 0));

  // the shared segment forced one arm to wait for the other
  ok(sim.events.some((e) => e.type === 'blocked' && e.segment === 'S'));

  // mutex on S never violated across the whole event log
  let held = 0;
  for (const e of sim.events) {
    if (e.type === 'acquired' && e.segment === 'S') {
      held += 1;
      ok(held <= 1, 'shared segment S held by more than one arm');
    }
    if (e.type === 'released' && e.segment === 'S') held -= 1;
  }
  equal(held, 0);
});

test('failed action releases only its own resources, in reverse order', () => {
  const world: WorldConfig = {
    segments: [
      { id: 'A', capacity: 1, lockCapacity: 1 },
      { id: 'B', capacity: 1, lockCapacity: 1 },
    ],
    items: [{ id: 'i1', at: 'A' }],
    arms: ['r1'],
  };
  const sim = new Simulator(world, { validateEachEvent: true });
  sim.submit({
    id: 'doomed',
    arm: 'r1',
    steps: [
      { kind: 'acquire', segment: 'A' },
      { kind: 'acquire', segment: 'B' },
      { kind: 'pick', item: 'ghost', segment: 'B' }, // fails: no such item on B
    ],
  });
  sim.run();

  const result = sim.results[0];
  equal(result.ok, false);
  match(result.reason ?? '', /not on segment/);

  const rollback = ofType(sim.events, 'released').filter((e) => e.cause === 'rollback');
  deepEqual(
    rollback.map((e) => e.segment),
    ['B', 'A'],
    'rollback must release in strict reverse (LIFO) order',
  );
  deepEqual(sim.state.arms['r1'].locks, []);
  deepEqual(sim.state.segments['A'].occupants, ['i1'], 'untouched item stays put');
});

test('circular wait is detected and the wait-for graph is emitted', () => {
  const sim = new Simulator(deadlockWorld(), { validateEachEvent: true });
  for (const action of deadlockActions()) sim.submit(action);
  sim.run();

  const deadlocks = ofType(sim.events, 'deadlock');
  equal(deadlocks.length, 1);
  const cycle = deadlocks[0].cycle;
  equal(cycle[0], cycle[cycle.length - 1], 'cycle is closed');
  ok(cycle.includes('r1') && cycle.includes('r2'));
  match(deadlocks[0].dot, /"r1" -> "r2"/);
  match(deadlocks[0].dot, /"r2" -> "r1"/);
  match(deadlocks[0].dot, /digraph wait_for/);

  // victim (fewest completed steps, tie broken by arm id) fails; other completes
  const byAction = new Map(sim.results.map((r) => [r.action, r]));
  equal(byAction.get('r1-forward')?.ok, false);
  match(byAction.get('r1-forward')?.reason ?? '', /deadlock victim/);
  equal(byAction.get('r2-backward')?.ok, true);

  // victim rollback released its lock, so everything is free again
  ok(Object.values(sim.state.arms).every((a) => a.locks.length === 0));
  ok(Object.values(sim.state.segments).every((s) => s.holders.length === 0));
});

test('snapshots at arbitrary events replay with item uniqueness and resource conservation', () => {
  const config = crossingWorld();
  const sim = new Simulator(config, {
    validateEachEvent: true,
    onEvent: (e, s) => {
      if (e.type !== 'snapshot' && e.seq % 5 === 2) s.snapshot(`snap@${e.seq}`);
    },
  });
  for (const action of crossingActions()) sim.submit(action);
  sim.run();

  ok(sim.snapshots.size >= 3, 'expected several arbitrary-event snapshots');
  const caughtItemInGripper = [...sim.snapshots.values()].some((snap) =>
    Object.values(snap.state.arms).some((a) => a.heldItem !== null),
  );
  ok(caughtItemInGripper, 'at least one snapshot should catch an item mid-transfer');

  const replay = replayEvents(config, sim.events);
  deepEqual(replay.violations, [], 'replay must not violate any invariant');
  ok(statesEqual(replay.state, sim.state), 'replayed final state matches live state');
  equal(replay.snapshots.size, sim.snapshots.size);
  for (const [label, snap] of sim.snapshots) {
    const replayed = replay.snapshots.get(label);
    if (replayed === undefined) throw new Error(`missing replayed snapshot ${label}`);
    ok(statesEqual(replayed, snap.state), `snapshot ${label} diverged on replay`);
  }
});

test('rollback undoes picks and places along the reverse path', () => {
  const world: WorldConfig = {
    segments: [
      { id: 'A', capacity: 1, lockCapacity: 1 },
      { id: 'B', capacity: 1, lockCapacity: 1 },
    ],
    items: [{ id: 'i1', at: 'A' }],
    arms: ['r1'],
  };
  const sim = new Simulator(world, { validateEachEvent: true });
  sim.submit({
    id: 'move-then-fail',
    arm: 'r1',
    steps: [
      { kind: 'acquire', segment: 'A' },
      { kind: 'pick', item: 'i1', segment: 'A' },
      { kind: 'acquire', segment: 'B' },
      { kind: 'place', item: 'i1', segment: 'B' },
      { kind: 'acquire', segment: 'NOWHERE' }, // fails: unknown segment
    ],
  });
  sim.run();

  equal(sim.results[0].ok, false);
  const rollback = sim.events.filter(
    (e): e is Extract<SimEvent, { type: 'picked' | 'placed' | 'released' }> =>
      (e.type === 'picked' || e.type === 'placed' || e.type === 'released') && e.cause === 'rollback',
  );
  const trace = rollback.map((e) =>
    e.type === 'released' ? `release ${e.segment}` : `${e.type} ${e.item}@${e.segment}`,
  );
  deepEqual(trace, ['picked i1@B', 'release B', 'placed i1@A', 'release A']);

  // item restored to its origin, no locks and no item left in the gripper
  deepEqual(sim.state.segments['A'].occupants, ['i1']);
  deepEqual(sim.state.segments['B'].occupants, []);
  deepEqual(sim.state.arms['r1'].locks, []);
  equal(sim.state.arms['r1'].heldItem, null);
});

test('action ending while still holding locks is failed and rolled back', () => {
  const world: WorldConfig = {
    segments: [{ id: 'A', capacity: 1, lockCapacity: 1 }],
    items: [],
    arms: ['r1'],
  };
  const sim = new Simulator(world, { validateEachEvent: true });
  sim.submit({ id: 'leaky', arm: 'r1', steps: [{ kind: 'acquire', segment: 'A' }] });
  sim.run();

  equal(sim.results[0].ok, false);
  match(sim.results[0].reason ?? '', /holding locks/);
  deepEqual(sim.state.segments['A'].holders, []);
  deepEqual(sim.state.arms['r1'].locks, []);
});
