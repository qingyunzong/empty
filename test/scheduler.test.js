import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, replay } from '../src/index.js';

function byId(output) {
  return new Map(output.schedule.map((s) => [s.id, s]));
}

test('capacity conflict fails with CAPACITY and deterministic winner', () => {
  const out = run({
    config: { slots: 1, capacityPerSlot: 1 },
    instructions: [
      { id: 'a', institution: 'X', amount: 10, priority: 1, deadlineSlot: 1 },
      { id: 'b', institution: 'Y', amount: 20, priority: 1, deadlineSlot: 1 },
    ],
  });
  const m = byId(out);
  assert.equal(m.get('b').status, 'confirmed'); // larger amount wins the tie
  assert.equal(m.get('b').slot, 1);
  assert.equal(m.get('a').status, 'unscheduled');
  assert.deepEqual(out.errors.map((e) => e.code), ['CAPACITY']);
  assert.equal(out.errors[0].instructionId, 'a');
});

test('quota fairness: usage-ratio tie-break prefers less-used institution', () => {
  const out = run({
    config: { slots: 2, capacityPerSlot: 1, quotas: { X: 2, Y: 2 } },
    instructions: [
      { id: 'x1', institution: 'X', amount: 100, priority: 1, deadlineSlot: 2 },
      { id: 'x2', institution: 'X', amount: 90, priority: 1, deadlineSlot: 2 },
      { id: 'y1', institution: 'Y', amount: 80, priority: 1, deadlineSlot: 2 },
    ],
  });
  const m = byId(out);
  assert.equal(m.get('x1').status, 'confirmed');
  // Y1 wins slot 2 over X2 despite the lower amount, because institution X
  // has already consumed quota (global fairness tie-break).
  assert.equal(m.get('y1').status, 'confirmed');
  assert.equal(m.get('y1').slot, 2);
  assert.equal(m.get('x2').status, 'unscheduled');
});

test('quota exhaustion is reported as QUOTA', () => {
  const out = run({
    config: { slots: 2, capacityPerSlot: 1, quotas: { X: 1, Y: 1 } },
    instructions: [
      { id: 'x1', institution: 'X', amount: 100, priority: 1, deadlineSlot: 2 },
      { id: 'x2', institution: 'X', amount: 90, priority: 1, deadlineSlot: 2 },
      { id: 'y1', institution: 'Y', amount: 80, priority: 1, deadlineSlot: 2 },
    ],
  });
  const m = byId(out);
  assert.equal(m.get('x1').status, 'confirmed');
  assert.equal(m.get('y1').status, 'confirmed');
  assert.equal(m.get('x2').status, 'unscheduled');
  assert.deepEqual(out.errors.map((e) => e.code), ['QUOTA']);
  assert.equal(out.errors[0].instructionId, 'x2');
});

test('starvation aging: long-waiting low-priority instruction beats fresh high-priority one', () => {
  const instructions = [
    { id: 'old-low', institution: 'I1', amount: 10, priority: 1, arrivalSlot: 0, deadlineSlot: 2 },
    { id: 'mid', institution: 'I2', amount: 20, priority: 2, arrivalSlot: 1, deadlineSlot: 2 },
    { id: 'new-high', institution: 'I3', amount: 30, priority: 2, arrivalSlot: 2, deadlineSlot: 2 },
  ];
  const withAging = run({ config: { slots: 2, capacityPerSlot: 1, agingRate: 1500000 }, instructions });
  const m1 = byId(withAging);
  assert.equal(m1.get('old-low').status, 'confirmed');
  assert.equal(m1.get('mid').status, 'confirmed');
  assert.equal(m1.get('new-high').status, 'unscheduled');

  const withoutAging = run({ config: { slots: 2, capacityPerSlot: 1, agingRate: 0 }, instructions });
  const m2 = byId(withoutAging);
  assert.equal(m2.get('old-low').status, 'unscheduled'); // starves without aging
  assert.equal(m2.get('new-high').status, 'confirmed');
  assert.equal(m2.get('mid').status, 'confirmed');
});

const PREEMPT_INPUT = () => ({
  config: { slots: 2, capacityPerSlot: 1 },
  instructions: [
    { id: 'L', institution: 'I2', amount: 100, priority: 1, arrivalSlot: 2, deadlineSlot: 2 },
    { id: 'D', institution: 'I0', amount: 90, priority: 1, deadlineSlot: 1 },
    { id: 'H', institution: 'I1', amount: 10, priority: 5, deadlineSlot: 2, dependencies: ['D'] },
  ],
});

test('preemption: high priority atomically rolls back low priority with certificates', () => {
  const out = run(PREEMPT_INPUT());
  const m = byId(out);
  assert.equal(m.get('D').status, 'confirmed');
  assert.equal(m.get('H').status, 'confirmed');
  assert.equal(m.get('H').slot, 2);
  assert.equal(m.get('L').status, 'unscheduled');
  assert.deepEqual(out.errors.map((e) => e.code), ['CAPACITY']);

  const ops = out.certificates.map((c) => `${c.op}:${c.instructionId}`);
  assert.deepEqual(ops, ['assign:L', 'assign:D', 'preempt:L', 'assign:H']);
  const preempt = out.certificates[2];
  assert.equal(preempt.reason, 'preempted');
  assert.equal(preempt.by, 'H');
  assert.equal(out.certificates[3].reason, 'preempt');

  // The certificate log replays to the exact same final state.
  const r = replay(out.certificates);
  assert.equal(r.valid, true);
  assert.deepEqual([...r.confirmed.entries()].sort(), [['D', 1], ['H', 2]]);
});

test('undo after preemption recovers the preempted instruction incrementally', () => {
  const input = PREEMPT_INPUT();
  input.undo = ['H'];
  const out = run(input);
  const m = byId(out);
  assert.equal(m.get('H').status, 'revoked');
  assert.equal(m.get('D').status, 'confirmed');
  assert.equal(m.get('D').slot, 1); // untouched by the repair
  assert.equal(m.get('L').status, 'confirmed'); // recovered into the freed slot
  assert.equal(m.get('L').slot, 2);
  assert.deepEqual(out.errors, []);
  const last = out.certificates.at(-1);
  assert.deepEqual([last.op, last.instructionId, last.reason], ['assign', 'L', 'repair']);
  const r = replay(out.certificates);
  assert.equal(r.valid, true);
  assert.deepEqual([...r.confirmed.entries()].sort(), [['D', 1], ['L', 2]]);
});

test('undo cascades orphans, releases quota, and leaves unrelated results untouched', () => {
  const out = run({
    config: { slots: 3, capacityPerSlot: 1, quotas: { I1: 1 } },
    instructions: [
      { id: 'D', institution: 'I0', amount: 100, priority: 1, deadlineSlot: 1 },
      { id: 'L', institution: 'I2', amount: 90, priority: 1, arrivalSlot: 2, deadlineSlot: 3 },
      { id: 'W', institution: 'I1', amount: 50, priority: 1, deadlineSlot: 3 },
      { id: 'H', institution: 'I1', amount: 10, priority: 5, deadlineSlot: 3, dependencies: ['D'] },
    ],
    undo: ['D'],
  });
  const m = byId(out);
  assert.equal(m.get('D').status, 'revoked');
  assert.equal(m.get('H').status, 'orphan'); // dependency chain broken
  assert.equal(m.get('L').status, 'confirmed');
  assert.equal(m.get('L').slot, 3); // unrelated result not recomputed
  assert.equal(m.get('W').status, 'confirmed'); // quota released by the orphan cascade
  assert.equal(m.get('W').slot, 1);
  assert.deepEqual(out.errors, []);
  const ops = out.certificates.map((c) => `${c.op}:${c.instructionId}`);
  assert.ok(ops.includes('undo:D'));
  assert.ok(ops.includes('orphan:H'));
  assert.equal(out.certificates.at(-1).op, 'assign');
  assert.equal(out.certificates.at(-1).instructionId, 'W');
  assert.equal(replay(out.certificates).valid, true);
});

test('stale undo is reported as STALE_UNDO', () => {
  const input = PREEMPT_INPUT();
  input.undo = ['H', 'H', 'ZZZ'];
  const out = run(input);
  const stale = out.errors.filter((e) => e.code === 'STALE_UNDO');
  assert.equal(stale.length, 2);
  assert.deepEqual(stale.map((e) => e.instructionId), ['H', 'ZZZ']);
});

test('dependency cycles are reported as CYCLE and taint dependents', () => {
  const out = run({
    config: { slots: 2, capacityPerSlot: 1 },
    instructions: [
      { id: 'a', institution: 'X', amount: 1, priority: 1, deadlineSlot: 2, dependencies: ['b'] },
      { id: 'b', institution: 'X', amount: 1, priority: 1, deadlineSlot: 2, dependencies: ['a'] },
      { id: 'c', institution: 'X', amount: 1, priority: 1, deadlineSlot: 2, dependencies: ['b'] },
      { id: 'd', institution: 'Y', amount: 1, priority: 1, deadlineSlot: 2 },
    ],
  });
  const cycleErrors = out.errors.filter((e) => e.code === 'CYCLE');
  assert.deepEqual(cycleErrors.map((e) => e.instructionId).sort(), ['a', 'b', 'c']);
  const m = byId(out);
  assert.equal(m.get('d').status, 'confirmed'); // unaffected instruction still scheduled
});

test('missing dependency is reported as MISSING_DEP', () => {
  const out = run({
    config: { slots: 1, capacityPerSlot: 1 },
    instructions: [
      { id: 'a', institution: 'X', amount: 1, priority: 1, deadlineSlot: 1, dependencies: ['ghost'] },
    ],
  });
  assert.deepEqual(out.errors.map((e) => e.code), ['MISSING_DEP']);
});

test('determinism: identical and shuffled inputs produce identical output', () => {
  const instructions = [
    { id: 'i1', institution: 'A', amount: 5, priority: 2, deadlineSlot: 3 },
    { id: 'i2', institution: 'B', amount: 7, priority: 1, deadlineSlot: 2, dependencies: ['i1'] },
    { id: 'i3', institution: 'A', amount: 9, priority: 3, deadlineSlot: 3 },
    { id: 'i4', institution: 'C', amount: 3, priority: 1, deadlineSlot: 1 },
    { id: 'i5', institution: 'B', amount: 8, priority: 2, deadlineSlot: 3, dependencies: ['i4'] },
  ];
  const input = { config: { slots: 3, capacityPerSlot: 1, quotas: { A: 1 } }, instructions, undo: ['i3'] };
  const first = JSON.stringify(run(input));
  const second = JSON.stringify(run(input));
  assert.equal(first, second);
  const shuffled = { ...input, instructions: [...instructions].reverse() };
  assert.equal(JSON.stringify(run(shuffled)), first);
});
