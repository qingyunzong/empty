import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, toJsonl } from '../support/helpers.mjs';

const CONFIG = { type: 'config', wave: 'W1', budget: 100, shuttles: [{ id: 'S1', home: 'A1:0' }] };
const TASK1 = { type: 'task', id: 'T1', moves: [{ id: 'M1', from: 'A1:0', to: 'A1:2', energy: 2, duration: 2 }] };
const TASK2 = { type: 'task', id: 'T2', moves: [{ id: 'M2', from: 'A1:2', to: 'A1:4', energy: 2, duration: 2 }] };

function planWaveInput(extraTasks = []) {
  return runCli(['wave'], toJsonl([CONFIG, TASK1, TASK2, ...extraTasks]));
}

test('rollback wave cascades: executed moves compensated, unstarted moves reusable', () => {
  const plan = planWaveInput();
  assert.equal(plan.code, 0);
  const journal = [
    ...plan.lines,
    { type: 'execute', move: 'M1', start: 0, end: 2 },
    { type: 'rollback', level: 'wave', id: 'W1' },
  ];
  const r = runCli(['rollback'], toJsonl(journal));
  assert.equal(r.code, 0);

  // Append-only: the original execute record is preserved, not erased.
  assert.ok(r.lines.some((l) => l.type === 'execute' && l.move === 'M1'));

  const compensation = r.lines.find((l) => l.type === 'move' && l.kind === 'compensation');
  assert.ok(compensation, 'expected a compensation move');
  assert.equal(compensation.compensates, 'M1');
  assert.equal(compensation.from, 'A1:2');
  assert.equal(compensation.to, 'A1:0');
  assert.equal(compensation.energy, 2);

  const reusable = r.lines.filter((l) => l.type === 'reusable').map((l) => l.move.id);
  assert.deepEqual(reusable, ['M2']);

  const result = r.lines.find((l) => l.type === 'rollback-result');
  assert.deepEqual(result.compensated, ['M1']);
  assert.deepEqual(result.reusable, ['M2']);
  assert.equal(result.compensationEnergy, 2);

  // Cascade reaches every layer.
  for (const [entity, id] of [['wave', 'W1'], ['task', 'T1'], ['task', 'T2']]) {
    assert.ok(
      r.lines.some((l) => l.type === 'status' && l.entity === entity && l.id === id && l.status === 'rolled-back'),
      `expected ${entity} ${id} to be rolled back`,
    );
  }
});

test('acceptance 2: replay after wave rollback does not increase energy', () => {
  const plan = planWaveInput();
  const journal = [
    ...plan.lines,
    { type: 'execute', move: 'M1', start: 0, end: 2 },
    { type: 'rollback', level: 'wave', id: 'W1' },
  ];
  const rolled = runCli(['rollback'], toJsonl(journal));
  assert.equal(rolled.code, 0);
  const reusableMoves = rolled.lines.filter((l) => l.type === 'reusable').map((l) => ({ type: 'reusable', move: l.move }));
  assert.ok(reusableMoves.length > 0);

  const replay = runCli(['wave', '--wave', 'W2'], toJsonl([
    { ...CONFIG, wave: 'W2' }, TASK1, TASK2, ...reusableMoves,
  ]));
  assert.equal(replay.code, 0);
  const before = plan.lines.find((l) => l.type === 'wave').energy;
  const after = replay.lines.find((l) => l.type === 'wave').energy;
  assert.ok(after <= before, `replay energy ${after} must not exceed ${before}`);
  // The reused move keeps its pool identity in the new plan.
  assert.ok(replay.lines.some((l) => l.type === 'move' && l.reusedFrom === 'M2'));
});

test('rollback level violations exit 18', () => {
  const plan = planWaveInput();
  const journal = plan.lines;

  // Task T1 has sibling task T2 committed after it: rolling back T1 would
  // skip a level.
  const r1 = runCli(['rollback'], toJsonl([...journal, { type: 'rollback', level: 'task', id: 'T1' }]));
  assert.equal(r1.code, 18);
  assert.equal(r1.lines.find((l) => l.type === 'error').code, 'ROLLBACK_LEVEL_VIOLATION');

  // Move M1 has move M2 committed after it.
  const r2 = runCli(['rollback'], toJsonl([...journal, { type: 'rollback', level: 'move', id: 'M1' }]));
  assert.equal(r2.code, 18);

  // Wave W1 is no longer the top of the stack once W2 is committed.
  const plan2 = runCli(['wave', '--wave', 'W2'], toJsonl([
    { type: 'config', wave: 'W2', budget: 100, shuttles: [{ id: 'S1', home: 'A1:0' }] },
    { type: 'task', id: 'T9', moves: [{ id: 'M9', from: 'A1:0', to: 'A1:1', energy: 1, duration: 1 }] },
  ]));
  const r3 = runCli(['rollback'], toJsonl([...journal, ...plan2.lines, { type: 'rollback', level: 'wave', id: 'W1' }]));
  assert.equal(r3.code, 18);
});

test('innermost rollback is legal and cascades only its own subtree', () => {
  const plan = planWaveInput();
  // T2 is the latest committed task: rolling it back is contiguous.
  const r = runCli(['rollback'], toJsonl([...plan.lines, { type: 'rollback', level: 'task', id: 'T2' }]));
  assert.equal(r.code, 0);
  const result = r.lines.find((l) => l.type === 'rollback-result');
  assert.deepEqual(result.reusable, ['M2']);
  assert.deepEqual(result.compensated, []);
  // T1 and W1 stay active.
  assert.ok(!r.lines.some((l) => l.type === 'status' && l.entity === 'task' && l.id === 'T1'));
  assert.ok(!r.lines.some((l) => l.type === 'status' && l.entity === 'wave'));
});

test('rollback of an unknown entity exits 2', () => {
  const plan = planWaveInput();
  const r = runCli(['rollback'], toJsonl([...plan.lines, { type: 'rollback', level: 'wave', id: 'W9' }]));
  assert.equal(r.code, 2);
  assert.equal(r.lines.find((l) => l.type === 'error').code, 'ENTITY_NOT_FOUND');
});
