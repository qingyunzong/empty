'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/state');

function scheduleMap(result) {
  return Object.fromEntries(result.schedule.map((op) => [op.id, op.start]));
}

test('scenario 3: undo of capacity cut restores the original optimal schedule', () => {
  const store = Store.create({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: null, due: 6 },
      { id: 'b', line: 'L1', duration: 2, release: null, due: 6 },
    ],
    capacity: { L1: { '*': 2 } },
  });
  assert.equal(store.result.feasible, true);
  assert.deepEqual(scheduleMap(store.result), { a: 0, b: 0 });
  assert.equal(store.result.maxLateness, -4);

  const cut = store.applyEdit({ op: 'setCapacity', line: 'L1', slot: null, capacity: 1 });
  assert.equal(cut.feasible, true);
  assert.deepEqual(scheduleMap(cut), { a: 0, b: 2 });
  assert.equal(cut.maxLateness, -2);
  assert.deepEqual(cut.affectedOps, ['a', 'b']);
  assert.equal(cut.undoDepth, 1);
  assert.equal(cut.redoDepth, 0);

  const undone = store.undo();
  assert.deepEqual(scheduleMap(undone), { a: 0, b: 0 }, 'undo restores the original optimum');
  assert.equal(undone.maxLateness, -4);
  assert.equal(undone.undoDepth, 0);
  assert.equal(undone.redoDepth, 1);

  const redone = store.redo();
  assert.deepEqual(scheduleMap(redone), { a: 0, b: 2 }, 'redo reapplies the capacity cut');
  assert.equal(redone.undoDepth, 1);
  assert.equal(redone.redoDepth, 0);
});

test('undo/redo restore full stack state across multiple edits', () => {
  const store = Store.create({
    tasks: [{ id: 'a', line: 'L1', duration: 1, release: null, due: null }],
  });
  store.applyEdit({ op: 'upsertTask', task: { id: 'b', line: 'L1', duration: 1, release: null, due: null } });
  store.applyEdit({ op: 'upsertTask', task: { id: 'c', line: 'L1', duration: 1, release: null, due: null } });
  assert.deepEqual(scheduleMap(store.result), { a: 0, b: 1, c: 2 });
  assert.equal(store.undoStack.length, 2);

  assert.deepEqual(scheduleMap(store.undo()), { a: 0, b: 1 });
  assert.deepEqual(scheduleMap(store.undo()), { a: 0 });
  assert.equal(store.undoStack.length, 0);
  assert.equal(store.redoStack.length, 2);
  assert.throws(() => store.undo(), /nothing to undo/);

  assert.deepEqual(scheduleMap(store.redo()), { a: 0, b: 1 });
  assert.deepEqual(scheduleMap(store.redo()), { a: 0, b: 1, c: 2 });
  assert.throws(() => store.redo(), /nothing to redo/);

  store.undo();
  store.applyEdit({ op: 'deleteTask', id: 'b' });
  assert.equal(store.redoStack.length, 0, 'a new edit clears the redo stack');
});

test('local repair suffices for an isolated edit on another line', () => {
  const store = Store.create({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: null, due: 4 },
      { id: 'b', line: 'L1', duration: 2, release: null, due: 4 },
      { id: 'x', line: 'L2', duration: 1, release: null, due: null },
    ],
  });
  assert.deepEqual(scheduleMap(store.result), { a: 0, b: 2, x: 0 });
  const out = store.applyEdit({
    op: 'upsertTask',
    task: { id: 'x', line: 'L2', duration: 2, release: null, due: null },
  });
  assert.equal(out.feasible, true);
  assert.deepEqual(out.affectedOps, ['x']);
  assert.equal(out.localRepair, true);
  assert.deepEqual(scheduleMap(out), { a: 0, b: 2, x: 0 });
});

test('local repair is impossible when a new task must displace frozen ones', () => {
  const store = Store.create({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: null, due: 8 },
      { id: 'b', line: 'L1', duration: 2, release: null, due: 8 },
    ],
  });
  assert.deepEqual(scheduleMap(store.result), { a: 0, b: 2 });
  const out = store.applyEdit({
    op: 'upsertTask',
    task: { id: 'c', line: 'L1', duration: 2, release: 0, due: 2 },
  });
  assert.equal(out.feasible, true);
  assert.deepEqual(out.affectedOps, ['c']);
  assert.equal(out.localRepair, false, 'c needs slot 0-1 which frozen a occupies');
  assert.deepEqual(scheduleMap(out), { a: 2, b: 4, c: 0 });
});

test('affected ops include the transitive precedence closure', () => {
  const store = Store.create({
    tasks: [
      { id: 'a', line: 'L1', duration: 1, release: null, due: null },
      { id: 'b', line: 'L1', duration: 1, release: null, due: null },
      { id: 'c', line: 'L1', duration: 1, release: null, due: null },
      { id: 'z', line: 'L2', duration: 1, release: null, due: null },
    ],
    precedence: [['a', 'b'], ['b', 'c']],
  });
  const out = store.applyEdit({
    op: 'upsertTask',
    task: { id: 'b', line: 'L1', duration: 2, release: null, due: null },
  });
  assert.deepEqual(out.affectedOps, ['a', 'b', 'c']);
  assert.equal(out.localRepair, true);
});

test('affected ops include tasks whose slots lost capacity', () => {
  const store = Store.create({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: null, due: null },
      { id: 'b', line: 'L1', duration: 2, release: null, due: null },
    ],
    capacity: { L1: { '*': 2 } },
  });
  const out = store.applyEdit({ op: 'setCapacity', line: 'L1', slot: 0, capacity: 1 });
  assert.deepEqual(out.affectedOps, ['a', 'b'], 'both tasks occupied slot 0');
  assert.equal(out.feasible, true);
  assert.equal(out.localRepair, true);
});

test('delete and precedence edits re-solve correctly', () => {
  const store = Store.create({
    tasks: [
      { id: 'a', line: 'L1', duration: 1, release: null, due: null },
      { id: 'b', line: 'L1', duration: 1, release: null, due: null },
    ],
  });
  let out = store.applyEdit({ op: 'addPrecedence', before: 'b', after: 'a' });
  assert.deepEqual(scheduleMap(out), { a: 1, b: 0 });
  out = store.applyEdit({ op: 'deleteTask', id: 'b' });
  assert.deepEqual(scheduleMap(out), { a: 0 });
  assert.deepEqual(out.affectedOps, ['a', 'b']);
  out = store.undo();
  assert.deepEqual(scheduleMap(out), { a: 1, b: 0 });
});

test('apply resulting in infeasibility returns a certificate', () => {
  const store = Store.create({
    tasks: [{ id: 'a', line: 'L1', duration: 2, release: 0, due: 2 }],
  });
  const out = store.applyEdit({
    op: 'upsertTask',
    task: { id: 'b', line: 'L1', duration: 2, release: 0, due: 2 },
  });
  assert.equal(out.feasible, false);
  assert.equal(out.localRepair, false);
  assert.equal(out.certificate.kind, 'minimalInfeasibleSubset');
  assert.deepEqual(out.certificate.tasks.map((t) => t.id).sort(), ['a', 'b']);
  const restored = store.undo();
  assert.equal(restored.feasible, true);
});

test('store survives JSON round-trip (persistence for the CLI)', () => {
  const store = Store.create({
    tasks: [{ id: 'a', line: 'L1', duration: 1, release: null, due: null }],
  });
  store.applyEdit({ op: 'upsertTask', task: { id: 'b', line: 'L1', duration: 1, release: null, due: null } });
  const revived = Store.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  assert.deepEqual(revived.result, store.result);
  assert.deepEqual(scheduleMap(revived.undo()), { a: 0 });
});
