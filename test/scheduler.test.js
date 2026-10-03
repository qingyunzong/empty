import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, E_BUDGET, E_CONFLICT, E_EMPTY } from '../src/scheduler.js';

function baseScheduler(budget = Infinity) {
  const s = new Scheduler({ budget });
  s.addTask({ id: 'A', resources: ['R1'], start: 0, end: 4, deadline: 4 });
  s.addTask({ id: 'B', resources: ['R1'], start: 4, end: 8, deadline: 8 });
  s.addTask({ id: 'C', resources: ['R2'], start: 0, end: 4, deadline: 4 });
  return s;
}

test('conflicts: shared resource + overlapping interval', () => {
  const s = baseScheduler();
  assert.deepEqual(s.conflicts(), []);
  s.applyChange({ taskId: 'A', shift: 2 }); // A now [2,6) overlaps B [4,8) on R1
  assert.deepEqual(s.conflicts(), [['A', 'B']]);
  assert.deepEqual(s.conflicts(['A', 'C']), []); // different resources
});

test('affectedSet groups tasks by shared resource', () => {
  const s = baseScheduler();
  assert.deepEqual([...s.affectedSet('A')].sort(), ['A', 'B']);
  assert.deepEqual([...s.affectedSet('C')].sort(), ['C']);
});

test('undo/redo on empty stacks raises E_EMPTY', () => {
  const s = baseScheduler();
  assert.throws(() => s.undo(), (e) => e.code === E_EMPTY);
  assert.throws(() => s.redo(), (e) => e.code === E_EMPTY);
});

test('undo restores previous state and redo reapplies it', () => {
  const s = baseScheduler();
  s.applyChange({ taskId: 'A', shift: 2 });
  assert.equal(s.getTask('A').start, 2);
  s.undo();
  assert.equal(s.getTask('A').start, 0);
  assert.deepEqual(s.conflicts(), []);
  s.redo();
  assert.equal(s.getTask('A').start, 2);
  assert.deepEqual(s.conflicts(), [['A', 'B']]);
});

test('undo recomputes affected set and fails on budget without changing state', () => {
  // Budget 2; A has deadline 1 so reverting a -3 shift costs 3 delay.
  const s = new Scheduler({ budget: 2 });
  s.addTask({ id: 'A', resources: ['R1'], start: 0, end: 4, deadline: 1 });
  s.addTask({ id: 'D', resources: ['R1'], start: 10, end: 14, deadline: 14 });
  s.applyChange({ taskId: 'A', shift: -3 }); // delay 0
  s.applyChange({ taskId: 'D', shift: -1 }); // delay 0
  s.undo(); // revert D -> delay 0, ok
  assert.equal(s.getTask('D').start, 10);
  assert.throws(() => s.undo(), (e) => e.code === E_BUDGET); // revert A -> delay 3 > 2
  // state unchanged after failed rollback
  assert.equal(s.getTask('A').start, -3);
  assert.equal(s.undoStack.length, 1);
  assert.equal(s.redoStack.length, 1);
  // redo of the still-pending change succeeds
  const r = s.redo();
  assert.equal(s.getTask('D').start, 9);
  assert.deepEqual(r.affected, ['A', 'D']);
});

test('applyChange enforces budget too and leaves state untouched on failure', () => {
  const s = new Scheduler({ budget: 1 });
  s.addTask({ id: 'A', resources: ['R1'], start: 0, end: 4, deadline: 4 });
  assert.throws(() => s.applyChange({ taskId: 'A', shift: 2 }), (e) => e.code === E_BUDGET);
  assert.equal(s.getTask('A').start, 0);
  assert.equal(s.undoStack.length, 0);
});

test('placement tie-break: conflicts, resource count, delay, lexicographic', () => {
  const s = new Scheduler();
  s.addTask({ id: 'A', resources: ['R1'], start: 0, end: 4, deadline: 4 });
  // Both R2 and R3 are conflict-free; equal resource count and delay ->
  // lexicographic picks R2; earliest start wins within the same option.
  const best = s.findBestPlacement({
    duration: 2,
    resourceOptions: [['R3'], ['R2'], ['R1', 'R2']],
    windowStart: 0,
    windowEnd: 10,
    deadline: 6,
  });
  assert.deepEqual(best.resources, ['R2']);
  assert.equal(best.start, 0);
  assert.equal(best.conflicts, 0);
  // Delay breaks a tie before lexicographic order.
  const s2 = new Scheduler();
  const best2 = s2.findBestPlacement({
    duration: 4,
    resourceOptions: [['R1'], ['R2']],
    windowStart: 0,
    windowEnd: 10,
    deadline: 4,
  });
  assert.equal(best2.delay, 0);
  assert.equal(best2.start, 0);
  // Fewer resources beats lexicographic order.
  const best3 = s2.findBestPlacement({
    duration: 2,
    resourceOptions: [['A1', 'A2'], ['Z1']],
    windowStart: 0,
    windowEnd: 6,
  });
  assert.deepEqual(best3.resources, ['Z1']);
});

test('duplicate task id rejected with E_CONFLICT', () => {
  const s = baseScheduler();
  assert.throws(() => s.addTask({ id: 'A', resources: ['R9'], start: 0, end: 1 }), (e) => e.code === E_CONFLICT);
});
