'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LINEAR_STATUSES,
  STATUSES,
  EXIT,
  MergeConflict,
  isLegalTransition,
  diffOrders,
  applyPatch,
  undoPatch,
  redoPatch,
  mergeOrders,
} = require('../lib/orders');

const order = (id, status, assignee = null, priority = 'low') => ({
  id,
  status,
  assignee,
  priority,
});

test('state machine: all 16 linear transitions match an independent reference', () => {
  const rank = new Map(LINEAR_STATUSES.map((status, index) => [status, index]));
  const reference = (from, to) => rank.get(to) === rank.get(from) + 1;
  assert.equal(LINEAR_STATUSES.length, 4);
  let checked = 0;
  for (const from of LINEAR_STATUSES) {
    for (const to of LINEAR_STATUSES) {
      assert.equal(isLegalTransition(from, to), reference(from, to), `${from} -> ${to}`);
      checked += 1;
    }
  }
  assert.equal(checked, 16);
});

test('state machine: canceled only from the three non-terminal states', () => {
  assert.equal(isLegalTransition('created', 'canceled'), true);
  assert.equal(isLegalTransition('assigned', 'canceled'), true);
  assert.equal(isLegalTransition('in_progress', 'canceled'), true);
  assert.equal(isLegalTransition('done', 'canceled'), false);
  assert.equal(isLegalTransition('canceled', 'canceled'), false);
});

test('state machine: done and canceled are terminal', () => {
  for (const status of STATUSES) {
    assert.equal(isLegalTransition('done', status), false, `done -> ${status}`);
    assert.equal(isLegalTransition('canceled', status), false, `canceled -> ${status}`);
  }
  assert.equal(isLegalTransition('bogus', 'created'), false);
  assert.equal(isLegalTransition('created', 'bogus'), false);
});

test('apply: field updates and legal status transitions', () => {
  const orders = [order('a', 'created'), order('b', 'in_progress', 'amy', 'high')];
  const patch = {
    changes: [
      { id: 'a', field: 'status', from: 'created', to: 'assigned' },
      { id: 'a', field: 'assignee', from: null, to: 'amy' },
      { id: 'b', field: 'priority', from: 'high', to: 'critical' },
      { id: 'b', field: 'status', from: 'in_progress', to: 'done' },
    ],
  };
  const result = applyPatch(orders, patch);
  assert.deepEqual(result, [
    order('a', 'assigned', 'amy', 'low'),
    order('b', 'done', 'amy', 'critical'),
  ]);
  assert.equal(orders[0].status, 'created', 'input must not be mutated');
});

test('apply: unknown order exits with code 2', () => {
  assert.throws(
    () => applyPatch([order('a', 'created')], { changes: [{ id: 'nope', field: 'priority', from: 'low', to: 'high' }] }),
    (err) => err.exitCode === EXIT.INVALID && /unknown order: nope/.test(err.message)
  );
});

test('apply: illegal status transition exits with code 2', () => {
  const patch = { changes: [{ id: 'a', field: 'status', from: 'created', to: 'done' }] };
  assert.throws(
    () => applyPatch([order('a', 'created')], patch),
    (err) => err.exitCode === EXIT.INVALID && /illegal status transition/.test(err.message)
  );
});

test('apply: stale from-value exits with code 2', () => {
  const patch = { changes: [{ id: 'a', field: 'priority', from: 'high', to: 'low' }] };
  assert.throws(
    () => applyPatch([order('a', 'created')], patch),
    (err) => err.exitCode === EXIT.INVALID && /does not apply/.test(err.message)
  );
});

test('undo restores via inverse patch; redo re-applies under the state machine', () => {
  const orders = [order('a', 'created')];
  const p1 = { changes: [{ id: 'a', field: 'status', from: 'created', to: 'assigned' }] };
  const p2 = { changes: [{ id: 'a', field: 'status', from: 'assigned', to: 'in_progress' }] };
  const p3 = { changes: [{ id: 'a', field: 'status', from: 'in_progress', to: 'done' }] };

  let state = applyPatch(orders, p1);
  state = applyPatch(state, p2);
  state = applyPatch(state, p3);
  assert.equal(state[0].status, 'done');

  state = undoPatch(state, p3);
  assert.equal(state[0].status, 'in_progress');
  state = undoPatch(state, p2);
  state = undoPatch(state, p1);
  assert.equal(state[0].status, 'created', 'inverse patch restores past non-forward moves');

  state = redoPatch(state, p1);
  state = redoPatch(state, p2);
  state = redoPatch(state, p3);
  assert.equal(state[0].status, 'done');
});

test('redo is constrained by the state machine', () => {
  const notAppliedYet = { changes: [{ id: 'a', field: 'status', from: 'assigned', to: 'in_progress' }] };
  assert.throws(
    () => redoPatch([order('a', 'created')], notAppliedYet),
    (err) => err.exitCode === EXIT.INVALID
  );
  const illegal = { changes: [{ id: 'a', field: 'status', from: 'created', to: 'in_progress' }] };
  assert.throws(
    () => redoPatch([order('a', 'created')], illegal),
    (err) => err.exitCode === EXIT.INVALID && /illegal status transition/.test(err.message)
  );
});

test('diff round-trips through apply and undo', () => {
  const base = [order('a', 'created'), order('b', 'assigned', 'amy')];
  const target = [order('a', 'assigned', 'amy'), order('b', 'in_progress', 'amy', 'high')];
  const patch = diffOrders(base, target);
  assert.deepEqual(applyPatch(base, patch), target);
  assert.deepEqual(undoPatch(target, patch), base);
});

test('diff: unknown order in target exits with code 2', () => {
  assert.throws(
    () => diffOrders([order('a', 'created')], [order('a', 'created'), order('b', 'created')]),
    (err) => err.exitCode === EXIT.INVALID
  );
});

test('merge acceptance 1: assignee on one side, priority on the other merges', () => {
  const base = [order('a', 'assigned', 'amy', 'low')];
  const local = [order('a', 'assigned', 'bob', 'low')];
  const remote = [order('a', 'assigned', 'amy', 'high')];
  assert.deepEqual(mergeOrders(base, local, remote), [order('a', 'assigned', 'bob', 'high')]);
});

test('merge acceptance 2: both sides set different assignee -> conflict', () => {
  const base = [order('a', 'assigned', 'amy')];
  const local = [order('a', 'assigned', 'bob')];
  const remote = [order('a', 'assigned', 'carol')];
  assert.throws(
    () => mergeOrders(base, local, remote),
    (err) => {
      assert.ok(err instanceof MergeConflict);
      assert.equal(err.exitCode, EXIT.CONFLICT);
      assert.equal(err.conflicts.length, 1);
      assert.equal(err.conflicts[0].reason, 'both-modified');
      assert.equal(err.conflicts[0].field, 'assignee');
      assert.equal(err.conflicts[0].local, 'bob');
      assert.equal(err.conflicts[0].remote, 'carol');
      return true;
    }
  );
});

test('merge acceptance 3: undo past done vs terminal update -> conflict', () => {
  const beforeDone = [order('a', 'in_progress', 'amy', 'high')];
  const donePatch = { changes: [{ id: 'a', field: 'status', from: 'in_progress', to: 'done' }] };
  const base = applyPatch(beforeDone, donePatch);
  const local = undoPatch(base, donePatch);
  const remote = [order('a', 'done', 'amy', 'critical')];
  assert.equal(local[0].status, 'in_progress');
  assert.throws(
    () => mergeOrders(base, local, remote),
    (err) => {
      assert.equal(err.exitCode, EXIT.CONFLICT);
      assert.ok(err.conflicts.some((c) => c.reason === 'terminal-order-modified'));
      return true;
    }
  );
});

test('merge: changes to different orders auto-merge', () => {
  const base = [order('a', 'created'), order('b', 'assigned', 'amy')];
  const local = [order('a', 'assigned'), order('b', 'assigned', 'amy')];
  const remote = [order('a', 'created'), order('b', 'in_progress', 'amy')];
  assert.deepEqual(mergeOrders(base, local, remote), [
    order('a', 'assigned'),
    order('b', 'in_progress', 'amy'),
  ]);
});

test('merge: identical change on both sides merges', () => {
  const base = [order('a', 'created')];
  const local = [order('a', 'created', 'amy')];
  const remote = [order('a', 'created', 'amy')];
  assert.deepEqual(mergeOrders(base, local, remote), [order('a', 'created', 'amy')]);
});

test('merge: legal status advance on one side plus field edit on the other', () => {
  const base = [order('a', 'created')];
  const local = [order('a', 'assigned', 'amy')];
  const remote = [order('a', 'created', null, 'high')];
  assert.deepEqual(mergeOrders(base, local, remote), [order('a', 'assigned', 'amy', 'high')]);
});

test('merge: resulting illegal status transition conflicts', () => {
  const base = [order('a', 'created')];
  const local = [order('a', 'in_progress')];
  const remote = [order('a', 'created', null, 'high')];
  assert.throws(
    () => mergeOrders(base, local, remote),
    (err) => err.exitCode === EXIT.CONFLICT &&
      err.conflicts.some((c) => c.reason === 'illegal-transition')
  );
});

test('merge: any modification of a terminal order conflicts', () => {
  const base = [order('a', 'canceled', 'amy')];
  const local = [order('a', 'canceled', 'amy', 'high')];
  const remote = [order('a', 'canceled', 'amy')];
  assert.throws(
    () => mergeOrders(base, local, remote),
    (err) => err.exitCode === EXIT.CONFLICT &&
      err.conflicts.some((c) => c.reason === 'terminal-order-modified')
  );
});

test('merge: unknown order on either side exits with code 2', () => {
  const base = [order('a', 'created')];
  const remote = [order('a', 'created'), order('ghost', 'created')];
  assert.throws(
    () => mergeOrders(base, base, remote),
    (err) => err.exitCode === EXIT.INVALID && /unknown order: ghost/.test(err.message)
  );
});
