import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GateState } from '../src/state.js';
import { buildSchedule } from '../src/schedule.js';
import { findCounterexample } from '../src/counterexample.js';
import { baseConfig } from './helpers.js';

const T0 = '2026-10-04T20:00:00Z';
const iso = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const rel = (orderId, seq = 1, extra = {}) => ({
  seq, ts: iso(seq * 10), type: 'release', orderId, actor: 'planner', priority: 1, ...extra,
});

test('permission inherits productLine -> workCenter -> workOrder', () => {
  const config = baseConfig();
  config.policy.permissions.productLines.PL1 = 'deny';
  let state = GateState.replay(config, [rel('W1')]);
  assert.equal(state.isReleasable('W1'), false, 'line deny blocks order');

  config.policy.permissions.workCenters.WC1 = 'allow';
  state = GateState.replay(config, [rel('W1')]);
  assert.equal(state.isReleasable('W1'), true, 'work center overrides product line');

  config.policy.permissions.workOrders.W1 = 'deny';
  state = GateState.replay(config, [rel('W1')]);
  assert.equal(state.isReleasable('W1'), false, 'work order overrides work center');

  // unrelated order on another line still allowed by default
  state = GateState.replay(config, [rel('W3')]);
  assert.equal(state.isReleasable('W3'), true);
});

test('compensation event generated when a lock-consuming release is overridden', () => {
  const config = baseConfig();
  const state = new GateState(config);
  state.apply(rel('W2', 1));
  assert.equal(state.derived.available.M2, 45);
  state.apply({ seq: 2, ts: iso(20), type: 'freeze', orderId: 'W2', actor: 'planner', priority: 1 });
  assert.equal(state.compensations.length, 1);
  assert.deepEqual(state.compensations[0].locks, { M1: 10, M2: 5 });
  assert.equal(state.derived.available.M2, 50);
  // journal is append-only: no silent history rewrite
  assert.deepEqual(state.journal.map((e) => e.type), ['release', 'freeze']);
});

test('reschedule moves an order to another shift', () => {
  const config = baseConfig();
  const state = new GateState(config);
  state.apply(rel('W1', 1));
  state.apply({ seq: 2, ts: iso(20), type: 'reschedule', orderId: 'W1', actor: 'planner', toShift: 'S1' });
  const sched = buildSchedule(config, state);
  assert.equal(sched.queue[0].shift, 'S1');
  assert.equal(sched.remainingCapability.WC1.S1, 360);
  assert.equal(sched.remainingCapability.WC1.S3, 480);
});

test('capability-insufficient orders are unscheduled and reported as breach', () => {
  const config = baseConfig();
  config.capabilities.WC1.S3 = 100; // less than the 120 needed
  const state = GateState.replay(config, [rel('W1')]);
  const sched = buildSchedule(config, state);
  assert.equal(sched.queue.length, 0);
  assert.equal(sched.unscheduled[0].reason, 'capability-insufficient');
  assert.ok(sched.scheduleBreaches.some((b) => b.type === 'capability-insufficient'));
});

test('material-insufficient release is flagged and not releasable', () => {
  const config = baseConfig();
  config.materials.M1 = 5; // W1 needs 10
  const state = GateState.replay(config, [rel('W1')]);
  assert.equal(state.isReleasable('W1'), false);
  assert.ok(state.breaches.some((b) => b.type === 'material-insufficient' && b.orderId === 'W1'));
});

test('counterexample: minimal sequence flipping W1 from releasable to frozen', () => {
  const config = baseConfig();
  const base = [rel('W1', 1)];
  const result = findCounterexample(config, base, 'W1');
  assert.equal(result.found, true);
  assert.equal(result.depth, 1, 'single freeze suffices');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'freeze');
  const flipped = GateState.replay(
    config,
    [...base, ...result.events].map((e, i) => ({ ...e, seq: i + 1 })),
  );
  assert.equal(flipped.isReleasable('W1'), false);
});

test('counterexample: reports when order is not releasable in base state', () => {
  const config = baseConfig();
  const result = findCounterexample(config, [], 'W1');
  assert.equal(result.found, false);
  assert.equal(result.reason, 'order-not-releasable-in-base-state');
});
