import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const startsOf = (schedule) =>
  Object.fromEntries((schedule.assignments ?? []).map((a) => [a.id, a.start]));

test('apply upsert inserts and updates tasks, reporting affected ops', () => {
  const engine = new Engine({
    tasks: [{ id: 'a', line: 'L', duration: 1, due: 5 }],
  });
  const r1 = engine.apply({ op: 'upsertTask', task: { id: 'b', line: 'L', duration: 1, due: 1 } });
  assert.equal(r1.schedule.status, 'optimal');
  assert.deepEqual(startsOf(r1.schedule), { a: 1, b: 0 });
  assert.deepEqual(r1.affected, ['a', 'b']);
  assert.equal(r1.localRepairSufficient, false);

  const r2 = engine.apply({ op: 'upsertTask', task: { id: 'b', line: 'L', duration: 1, due: 5 } });
  assert.deepEqual(startsOf(r2.schedule), { a: 0, b: 1 });
  assert.deepEqual(r2.affected, ['a', 'b']);
});

test('apply removeTask drops the task and its precedence edges', () => {
  const engine = new Engine({
    tasks: [
      { id: 'a', line: 'L', duration: 1 },
      { id: 'b', line: 'L', duration: 1 },
    ],
    precedence: [['a', 'b']],
  });
  const r = engine.apply({ op: 'removeTask', id: 'a' });
  assert.deepEqual(startsOf(r.schedule), { b: 0 });
  assert.deepEqual(engine.state.precedence, []);
});

test('removing an unknown task fails with exit-worthy error', () => {
  const engine = new Engine({});
  assert.throws(() => engine.apply({ op: 'removeTask', id: 'nope' }), /unknown task/);
});

test('undo/redo restores full solution and stack state', () => {
  const engine = new Engine({ tasks: [{ id: 'a', line: 'L', duration: 2, due: 2 }] });
  engine.apply({ op: 'upsertTask', task: { id: 'b', line: 'L', duration: 1, due: 1 } });
  engine.apply({ op: 'setCapacity', capacity: { L: [{ start: 0, end: 5, capacity: 2 }] } });
  assert.equal(engine.log.length, 2);

  const before = startsOf(engine.schedule().schedule);
  const u1 = engine.undo();
  assert.equal(u1.undone, 'set capacity');
  assert.equal(engine.log.length, 1);
  const u2 = engine.undo();
  assert.equal(u2.undone, 'insert task b');
  assert.deepEqual(startsOf(u2.schedule), { a: 0 });
  assert.equal(engine.log.length, 0);

  const emptyUndo = engine.undo();
  assert.equal(emptyUndo.undone, null);

  engine.redo();
  engine.redo();
  assert.equal(engine.log.length, 2);
  assert.deepEqual(startsOf(engine.schedule().schedule), before);
  assert.equal(engine.redo().redone, null);
});

test('a new apply clears the redo tail', () => {
  const engine = new Engine({ tasks: [{ id: 'a', line: 'L', duration: 1 }] });
  engine.apply({ op: 'upsertTask', task: { id: 'b', line: 'L', duration: 1 } });
  engine.undo();
  engine.apply({ op: 'upsertTask', task: { id: 'c', line: 'L', duration: 1 } });
  assert.equal(engine.redo().redone, null);
  assert.deepEqual([...engine.state.tasks.keys()].sort(), ['a', 'c']);
});

test('persistence round-trip preserves state, log and pointer', () => {
  const engine = new Engine({ tasks: [{ id: 'a', line: 'L', duration: 1, due: 1 }] });
  engine.apply({ op: 'upsertTask', task: { id: 'b', line: 'L', duration: 1, due: 2 } });
  engine.undo();
  const restored = Engine.fromJSON(JSON.parse(JSON.stringify(engine.toJSON())));
  assert.equal(restored.log.length, 0); // nothing left to undo
  assert.equal(restored.log.canRedo, true); // one redoable entry
  const redone = restored.redo();
  assert.deepEqual(startsOf(redone.schedule), { a: 0, b: 1 });
});

test('infeasible apply returns certificate with minimum subset', () => {
  const engine = new Engine({
    tasks: [
      { id: 'a', line: 'L', duration: 1, due: 1 },
      { id: 'b', line: 'L', duration: 1, due: 1 },
    ],
  });
  assert.equal(engine.schedule().schedule.status, 'infeasible');
  const cert = engine.schedule().schedule.certificate;
  assert.equal(cert.method, 'exhaustive-enumeration');
  assert.equal(cert.minInfeasibleSubset.length, 2);
});
