import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/planner.js';

function buildPlanner() {
  const p = new Planner();
  p.applyChange('换模后延迟 2 小时', {
    type: 'add',
    task: { id: 'a', resources: ['R1'], start: 0, end: 5, due: 5, budget: 2 },
  });
  p.applyChange('换模后延迟已缓解', {
    type: 'add',
    task: { id: 'b', resources: ['R2'], start: 20, end: 25, due: 25, budget: 2 },
  });
  p.applyChange('常规巡检', {
    type: 'shift', taskId: 'a', delta: 1,
  });
  return p;
}

// Acceptance 2 (window part): phrase query filtered by task time window
// matches brute-force filtering over raw change records.
test('phrase query with task time-window filter matches brute force', () => {
  const p = buildPlanner();
  const all = p.query('换模 后 延迟');
  assert.equal(all.length, 2);

  const brute = (from, to) => p.state.applied
    .filter((c) => c.note && c.note.replace(/\s+/g, '').includes('换模后延迟'))
    .filter((c) => c.window && c.window.start < to && from < c.window.end)
    .map((c) => c.id);

  assert.deepEqual(p.query('换模 后 延迟', { from: 0, to: 10 }), brute(0, 10));
  assert.deepEqual(p.query('换模 后 延迟', { from: 15, to: 30 }), brute(15, 30));
  assert.deepEqual(p.query('换模 后 延迟', { from: 6, to: 19 }), []);
  // proximity variant over the same window: "换模后延迟" spans 4 positions
  assert.deepEqual(p.query('换模 延迟', { near: 4, from: 0, to: 10 }), brute(0, 10));
  assert.deepEqual(p.query('换模 延迟', { near: 3, from: 0, to: 10 }), []);
});
