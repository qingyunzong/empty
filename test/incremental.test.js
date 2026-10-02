import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, runCommandStream } from '../src/scheduler.js';

// Instance where the budget decides between fast+expensive and slow+cheap
// modes on a chain, so a budget cut must re-mode upstream tasks and push
// every successor later.
function chainInput() {
  return {
    budget: 30,
    crews: 2,
    tasks: [
      { id: 'A', modes: [{ duration: 4, cost: 2 }, { duration: 1, cost: 10 }] },
      { id: 'B', deps: ['A'], modes: [{ duration: 4, cost: 2 }, { duration: 1, cost: 10 }] },
      { id: 'C', deps: ['B'], modes: [{ duration: 4, cost: 2 }, { duration: 1, cost: 10 }] },
      { id: 'D', deps: ['C'], modes: [{ duration: 2, cost: 1 }] },
    ],
  };
}

test('budget cut triggers plan change and successor invalidation', () => {
  const { steps } = runCommandStream(chainInput(), [{ op: 'setBudget', budget: 7 }]);
  const before = steps[0];
  const after = steps[1];
  assert.equal(before.status, 'optimal');
  assert.equal(after.status, 'optimal');
  // fast modes are unaffordable now: cost drops, downtime grows
  assert.ok(after.schedule.cost <= 7, `cost ${after.schedule.cost} within budget 7`);
  assert.ok(after.schedule.downtime > before.schedule.downtime);
  // modes actually changed upstream
  assert.notDeepEqual(after.schedule.modes, before.schedule.modes);
  // successor intervals were invalidated: B, C, D all moved
  const moved = new Set(after.diff.intervalsChanged.map((c) => c.task));
  assert.ok(moved.has('B') && moved.has('C') && moved.has('D'), `successors shifted: ${[...moved]}`);
  assert.ok(after.diff.downtimeDelta > 0);
  assert.ok(after.diff.costDelta < 0);
});

test('budget cut below minimum cost makes state infeasible and it propagates', () => {
  const { steps } = runCommandStream(chainInput(), [
    { op: 'setBudget', budget: 6 }, // min cost is 2+2+2+1 = 7
    { op: 'addTask', task: { id: 'E', deps: ['D'], modes: [{ duration: 1, cost: 0 }] } },
    { op: 'setBudget', budget: 30 },
  ]);
  assert.equal(steps[1].status, 'infeasible');
  assert.equal(steps[1].violations[0].code, 'BUDGET_EXCEEDED');
  // the infeasibility propagates: the next step starts from the infeasible state
  assert.equal(steps[2].status, 'infeasible');
  // restoring the budget recovers an optimal plan including the new task
  assert.equal(steps[3].status, 'optimal');
  assert.ok(steps[3].schedule.sequence.includes('E'));
  assert.equal(steps[3].diff.statusChanged.to, 'optimal');
});

test('undo/redo restores exact states and reuses cached solutions', () => {
  const scheduler = new Scheduler(chainInput());
  const initial = scheduler.initialReport();
  const s1 = scheduler.applyCommand({ op: 'setBudget', budget: 7 });
  const s2 = scheduler.applyCommand({ op: 'repriceMode', task: 'A', mode: 0, cost: 5 });
  const s3 = scheduler.applyCommand({ op: 'addTask', task: { id: 'E', deps: ['D'], modes: [{ duration: 1, cost: 1 }] } });
  const s4 = scheduler.applyCommand({ op: 'removeTask', id: 'B' });

  const u1 = scheduler.applyCommand({ op: 'undo' });
  assert.equal(u1.stateHash, s3.stateHash);
  const u2 = scheduler.applyCommand({ op: 'undo' });
  assert.equal(u2.stateHash, s2.stateHash);
  const u3 = scheduler.applyCommand({ op: 'undo' });
  assert.equal(u3.stateHash, s1.stateHash);
  const u4 = scheduler.applyCommand({ op: 'undo' });
  assert.equal(u4.stateHash, initial.stateHash);
  const u5 = scheduler.applyCommand({ op: 'undo' });
  assert.equal(u5.status, 'noop');

  const r1 = scheduler.applyCommand({ op: 'redo' });
  assert.equal(r1.stateHash, s1.stateHash);
  assert.deepEqual(r1.schedule, s1.schedule);
  const r2 = scheduler.applyCommand({ op: 'redo' });
  assert.equal(r2.stateHash, s2.stateHash);
  const r3 = scheduler.applyCommand({ op: 'redo' });
  assert.equal(r3.stateHash, s3.stateHash);
  const r4 = scheduler.applyCommand({ op: 'redo' });
  assert.equal(r4.stateHash, s4.stateHash);
  const r5 = scheduler.applyCommand({ op: 'redo' });
  assert.equal(r5.status, 'noop');

  // every revisited state was served from the memo cache
  const cacheSize = scheduler.cache.size;
  scheduler.applyCommand({ op: 'undo' });
  scheduler.applyCommand({ op: 'redo' });
  assert.equal(scheduler.cache.size, cacheSize, 'no recomputation for revisited states');
});

test('a new command clears the redo stack', () => {
  const scheduler = new Scheduler(chainInput());
  scheduler.initialReport();
  scheduler.applyCommand({ op: 'setBudget', budget: 7 });
  scheduler.applyCommand({ op: 'undo' });
  scheduler.applyCommand({ op: 'setBudget', budget: 9 });
  const step = scheduler.applyCommand({ op: 'redo' });
  assert.equal(step.status, 'noop');
});

test('removeTask strips dependency edges and undo restores them', () => {
  const scheduler = new Scheduler(chainInput());
  scheduler.initialReport();
  const removed = scheduler.applyCommand({ op: 'removeTask', id: 'B' });
  assert.equal(removed.status, 'optimal');
  assert.ok(!removed.schedule.sequence.includes('B'));
  // C no longer waits for B: with no remaining deps it can start at time 0
  const cEntry = removed.schedule.intervals.find((i) => i.task === 'C');
  assert.equal(cEntry.start, 0);
  const back = scheduler.applyCommand({ op: 'undo' });
  assert.ok(back.schedule.sequence.includes('B'));
  const bEnd = back.schedule.intervals.find((i) => i.task === 'B').end;
  const cStart = back.schedule.intervals.find((i) => i.task === 'C').start;
  assert.ok(cStart >= bEnd, 'dependency B -> C restored');
});

test('failed commands are reported in-band and leave state untouched', () => {
  const scheduler = new Scheduler(chainInput());
  const initial = scheduler.initialReport();
  const bad = scheduler.applyCommand({ op: 'addTask', task: { id: 'Z', modes: [{ duration: 1, cost: 1, parts: { ghost: 1 } }] } });
  assert.equal(bad.status, 'error');
  assert.equal(bad.error.code, 'UNKNOWN_PART');
  assert.equal(bad.stateHash, initial.stateHash);
  const bad2 = scheduler.applyCommand({ op: 'removeTask', id: 'ZZ' });
  assert.equal(bad2.error.code, 'UNKNOWN_TASK');
  const bad3 = scheduler.applyCommand({ op: 'teleport' });
  assert.equal(bad3.error.code, 'UNKNOWN_COMMAND');
  // failed commands are not undoable
  const undo = scheduler.applyCommand({ op: 'undo' });
  assert.equal(undo.status, 'noop');
});

test('critical constraints report binding budget, parts and critical path', () => {
  const scheduler = new Scheduler({
    budget: 7,
    parts: { valve: 1 },
    tasks: [
      { id: 'A', modes: [{ duration: 3, cost: 4, parts: { valve: 1 } }] },
      { id: 'B', deps: ['A'], modes: [{ duration: 2, cost: 3 }] },
    ],
  });
  const step = scheduler.initialReport();
  const cc = step.criticalConstraints;
  assert.equal(cc.budget.binding, true);
  assert.deepEqual(cc.criticalPath, ['A', 'B']);
  assert.equal(cc.criticalPathDuration, 5);
  assert.ok(cc.parts.some((p) => p.part === 'valve' && p.binding));
});
