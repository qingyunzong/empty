import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJournal, rollback, RollbackError } from '../src/journal.js';
import { planWave } from '../src/planner.js';

function sampleJournal() {
  return [
    { type: 'wave', id: 'w1', budget: 100 },
    { type: 'task', id: 't1', wave: 'w1' },
    { type: 'task', id: 't2', wave: 'w1' },
    { type: 'move', id: 'w1/t1/0', task: 't1', wave: 'w1', lane: 'L1', from: 'A', to: 'B', energy: 10, duration: 5, status: 'planned' },
    { type: 'move', id: 'w1/t1/1', task: 't1', wave: 'w1', lane: 'L2', from: 'B', to: 'C', energy: 8, duration: 4, status: 'planned' },
    { type: 'move', id: 'w1/t2/0', task: 't2', wave: 'w1', lane: 'L3', from: 'D', to: 'E', energy: 20, duration: 7, status: 'planned' },
    { type: 'status', id: 'w1/t1/0', status: 'done' },
    { type: 'status', id: 'w1/t2/0', status: 'executing' },
  ];
}

test('wave rollback cascades: executed moves compensated, unstarted moves reusable', () => {
  const entries = rollback(loadJournal(sampleJournal()), 'w1');
  assert.deepEqual(entries[0], { type: 'rollback', id: 'w1', level: 'wave' });

  const comp = entries.filter((e) => e.type === 'compensation');
  const cancel = entries.filter((e) => e.type === 'cancel');
  assert.deepEqual(comp.map((c) => c.of).sort(), ['w1/t1/0', 'w1/t2/0']);
  assert.deepEqual(cancel.map((c) => c.id), ['w1/t1/1']);

  // compensation is the inverse move, original record is preserved (append-only)
  const c0 = comp.find((c) => c.of === 'w1/t1/0');
  assert.equal(c0.from, 'B');
  assert.equal(c0.to, 'A');
  assert.equal(c0.lane, 'L1');
  assert.equal(c0.energy, 10);
  assert.ok(cancel.every((c) => c.reusable === true));
});

test('task rollback cascades only its own moves', () => {
  const entries = rollback(loadJournal(sampleJournal()), 't1');
  assert.deepEqual(entries[0], { type: 'rollback', id: 't1', level: 'task' });
  const ids = entries.slice(1).map((e) => e.of ?? e.id).sort();
  assert.deepEqual(ids, ['w1/t1/0', 'w1/t1/1']);
});

test('move rollback of an unstarted move cancels it as reusable', () => {
  const entries = rollback(loadJournal(sampleJournal()), 'w1/t1/1');
  assert.deepEqual(entries, [
    { type: 'rollback', id: 'w1/t1/1', level: 'move' },
    { type: 'cancel', id: 'w1/t1/1', reusable: true },
  ]);
});

test('level-skipping rollback after ancestor cascade fails with LEVEL_SKIP', () => {
  const records = [...sampleJournal(), ...rollback(loadJournal(sampleJournal()), 'w1')];
  const journal = loadJournal(records);
  assert.throws(() => rollback(journal, 't1'), (err) => err instanceof RollbackError && err.code === 'LEVEL_SKIP');
  assert.throws(() => rollback(journal, 'w1/t1/1'), (err) => err.code === 'LEVEL_SKIP');
  assert.throws(() => rollback(journal, 'w1'), (err) => err.code === 'LEVEL_SKIP');
});

test('rollback of unknown target fails with UNKNOWN_TARGET', () => {
  assert.throws(() => rollback(loadJournal(sampleJournal()), 'nope'), (err) => err.code === 'UNKNOWN_TARGET');
});

test('sibling task remains rollbackable after another task rollback', () => {
  const records = [...sampleJournal(), ...rollback(loadJournal(sampleJournal()), 't1')];
  const entries = rollback(loadJournal(records), 't2');
  assert.deepEqual(entries[0], { type: 'rollback', id: 't2', level: 'task' });
});

test('acceptance 2: replay after wave rollback never increases energy', () => {
  const tasks = [
    {
      id: 't1',
      routes: [
        { moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 6, duration: 4 }] },
        { moves: [{ from: 'A', to: 'B', lane: 'L2', energy: 7, duration: 3 }] },
      ],
    },
    {
      id: 't2',
      routes: [
        { moves: [{ from: 'C', to: 'D', lane: 'L3', energy: 5, duration: 5 }] },
        { moves: [{ from: 'C', to: 'D', lane: 'L1', energy: 4, duration: 6 }] },
      ],
    },
    { id: 't3', routes: [{ moves: [{ from: 'E', to: 'F', lane: 'L2', energy: 3, duration: 2 }] }] },
  ];
  const shuttles = [
    { id: 's1', battery: 12 },
    { id: 's2', battery: 12 },
  ];
  const budget = 18;

  const first = planWave({ tasks, shuttles, budget });
  assert.ok(first);

  // build a journal from the plan, execute some moves, then roll back the wave
  const records = [{ type: 'wave', id: 'w1', budget }];
  for (const a of first.assignments) {
    records.push({ type: 'task', id: a.task, wave: 'w1' });
    const route = tasks.find((t) => t.id === a.task).routes[a.route];
    route.moves.forEach((m, i) => {
      records.push({
        type: 'move', id: `w1/${a.task}/${i}`, task: a.task, wave: 'w1',
        lane: m.lane, from: m.from, to: m.to, energy: m.energy, duration: m.duration, status: 'planned',
      });
    });
  }
  records.push({ type: 'status', id: 'w1/t1/0', status: 'done' });
  records.push({ type: 'status', id: 'w1/t3/0', status: 'executing' });

  const entries = rollback(loadJournal(records), 'w1');
  const compensated = entries.filter((e) => e.type === 'compensation').map((e) => e.of).sort();
  assert.deepEqual(compensated, ['w1/t1/0', 'w1/t3/0']);
  const reusable = entries.filter((e) => e.type === 'cancel' && e.reusable).map((e) => e.id);
  assert.deepEqual(reusable, ['w1/t2/0']);

  // replay: same tasks, reusable moves offered back as route hints
  const reuseHints = new Set();
  for (const a of first.assignments) {
    if (reusable.some((id) => id.startsWith(`w1/${a.task}/`))) reuseHints.add(`${a.task}:${a.route}`);
  }
  const replay = planWave({ tasks, shuttles, budget, reuseHints });
  assert.ok(replay);
  assert.ok(replay.energy <= first.energy, `replay energy ${replay.energy} <= ${first.energy}`);
  assert.ok(replay.makespan <= first.makespan, `replay makespan ${replay.makespan} <= ${first.makespan}`);
});
