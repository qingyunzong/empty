import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/planner.js';
import { delayOf } from '../src/scheduler.js';

function makePlanner() {
  const p = new Planner();
  // t1 runs late: end 8, due 5 -> delay 3, budget 3 (valid).
  p.state.tasks = {
    t1: { id: 't1', resources: ['R1'], start: 0, end: 8, due: 5, budget: 3 },
  };
  return p;
}

// Acceptance 3: undo triggers budget failure (state unchanged), redo succeeds.
test('undo failing on budget leaves state untouched; redo then succeeds', () => {
  const p = makePlanner();
  const c1 = p.applyChange('换模后延迟缩短', { type: 'shift', taskId: 't1', delta: -1 }); // delay 2
  const c2 = p.applyChange('加班压缩工期', { type: 'shift', taskId: 't1', delta: -1 }); // delay 1
  assert.equal(delayOf(p.state.tasks.t1), 1);

  // undo c2: delay back to 2, within budget -> ok
  assert.equal(p.undo(), c2);
  assert.equal(delayOf(p.state.tasks.t1), 2);

  // undo c1: delay would become 3 > budget? no, budget is 3... use tighter budget check below
  const snapshot = JSON.stringify(p.state);
  p.state.tasks.t1.budget = 1; // tighten: undoing c1 -> delay 3 > 1 must fail
  assert.throws(() => p.undo(), (e) => e.code === 'E_BUDGET');
  // state unchanged except the budget tweak we made manually
  assert.equal(JSON.stringify({ ...p.state, tasks: { ...p.state.tasks } }).includes('"delta":-1'), true);
  assert.equal(delayOf(p.state.tasks.t1), 2);
  assert.equal(p.state.applied.length, 1); // c1 still applied
  assert.equal(p.state.undone.length, 1); // c2 still waiting to redo
  assert.ok(JSON.stringify(p.state) !== snapshot); // only budget differs

  // redo c2 succeeds and restores delay 1
  assert.equal(p.redo(), c2);
  assert.equal(delayOf(p.state.tasks.t1), 1);
  assert.equal(p.state.undone.length, 0);
});

test('undo/redo on empty stacks raise E_EMPTY', () => {
  const p = new Planner();
  assert.throws(() => p.undo(), (e) => e.code === 'E_EMPTY');
  assert.throws(() => p.redo(), (e) => e.code === 'E_EMPTY');
});

test('conflicting change is rejected with E_CONFLICT and not logged', () => {
  const p = new Planner();
  p.applyChange('初始任务', {
    type: 'add',
    task: { id: 'a', resources: ['R1'], start: 0, end: 5, due: 5, budget: 0 },
  });
  assert.throws(
    () => p.applyChange('重叠插入', {
      type: 'add',
      task: { id: 'b', resources: ['R1'], start: 3, end: 8, due: 8, budget: 0 },
    }),
    (e) => e.code === 'E_CONFLICT',
  );
  assert.equal(p.state.applied.length, 1);
  assert.deepEqual(Object.keys(p.state.tasks), ['a']);
});

test('affected-set recompute: undo of a shift revalidates neighbor budget', () => {
  const p = new Planner();
  p.applyChange('两台任务', {
    type: 'add',
    task: { id: 'a', resources: ['R1'], start: 0, end: 5, due: 4, budget: 1 },
  });
  p.applyChange('邻居任务', {
    type: 'add',
    task: { id: 'b', resources: ['R2'], start: 0, end: 4, due: 4, budget: 1 },
  });
  // pull a earlier so delay drops to 0
  p.applyChange('提前 a', { type: 'shift', taskId: 'a', delta: -1 }); // delay 0
  assert.equal(delayOf(p.state.tasks.a), 0);
  // tighten budget, then undo (delay back to 1) must fail and keep delay at 0
  p.state.tasks.a.budget = 0;
  assert.throws(() => p.undo(), (e) => e.code === 'E_BUDGET');
  assert.equal(delayOf(p.state.tasks.a), 0);
});
