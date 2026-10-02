import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstance } from '../src/model.js';
import { solve } from '../src/solver.js';
import { bruteForce } from './brute.js';

function makeInstance(raw) {
  return parseInstance(raw);
}

// Acceptance 1: cross-check against full enumeration of machine/tool/slot combos.
test('solver matches brute-force enumeration on small instances', () => {
  // Seeded LCG for reproducible pseudo-random instances.
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };

  for (let caseNo = 0; caseNo < 30; caseNo += 1) {
    const nMachines = 1 + rand(2);
    const nTools = 1 + rand(2);
    const nFixtures = 1 + rand(2);
    const horizon = 4 + rand(4);
    const nOps = 2 + rand(3);
    const raw = {
      machines: Array.from({ length: nMachines }, (_, i) => `M${i}`),
      tools: Array.from({ length: nTools }, (_, i) => ({ id: `T${i}`, life: 20 + rand(60) })),
      fixtures: Array.from({ length: nFixtures }, (_, i) => `F${i}`),
      horizon,
      slotMinutes: 10,
      dueSlot: 2 + rand(horizon - 2),
      operations: [],
    };
    raw.operations = Array.from({ length: nOps }, (_, i) => {
      const machines = raw.machines.filter(() => rand(2) === 0);
      const tools = raw.tools.map((t) => t.id).filter(() => rand(2) === 0);
      return {
        id: `op${i}`,
        machines: machines.length ? machines : [raw.machines[0]],
        minutes: 10 + rand(4) * 10,
        fixture: rand(3) === 0 ? null : raw.fixtures[rand(nFixtures)],
        tools: tools.length ? tools : [raw.tools[0].id],
      };
    });
    const instance = makeInstance(raw);
    const expected = bruteForce(instance);
    const got = solve(instance, { budget: 500000 });
    if (!expected.feasible) {
      assert.equal(got.status, 'infeasible', `case ${caseNo}: expected infeasible`);
      assert.ok(got.proof, 'infeasible result carries a proof');
    } else {
      assert.equal(got.status, 'optimal', `case ${caseNo}: expected optimal`);
      assert.equal(
        got.tardiness,
        expected.bestTardiness,
        `case ${caseNo}: tardiness mismatch vs brute force`
      );
    }
  }
});

// Acceptance 2: tool-life boundary triggers infeasibility and names the tool.
test('tool life boundary: exact fit feasible, one minute over infeasible with proof', () => {
  const base = {
    machines: ['M1'],
    tools: [{ id: 'T1', life: 60 }],
    fixtures: [],
    horizon: 70,
    slotMinutes: 1,
    operations: [
      { id: 'a', machines: ['M1'], minutes: 30, tools: ['T1'] },
      { id: 'b', machines: ['M1'], minutes: 30, tools: ['T1'] },
    ],
  };
  const feasible = solve(makeInstance(base));
  assert.equal(feasible.status, 'optimal');

  const over = makeInstance({
    ...base,
    operations: [base.operations[0], { ...base.operations[1], minutes: 31 }],
  });
  const result = solve(over);
  assert.equal(result.status, 'infeasible');
  assert.equal(result.proof.type, 'tool-life');
  assert.equal(result.proof.tool, 'T1');
  assert.equal(result.proof.requiredMinutes, 61);
  assert.equal(result.proof.life, 60);
  assert.deepEqual(result.proof.operations.sort(), ['a', 'b']);
});

test('fixture capacity conflict produces fixture proof', () => {
  const instance = makeInstance({
    machines: ['M1', 'M2'],
    tools: [],
    fixtures: ['F1'],
    horizon: 5,
    slotMinutes: 1,
    operations: [
      { id: 'a', machines: ['M1'], minutes: 3, fixture: 'F1' },
      { id: 'b', machines: ['M2'], minutes: 3, fixture: 'F1' },
    ],
  });
  const result = solve(instance);
  assert.equal(result.status, 'infeasible');
  assert.equal(result.proof.type, 'fixture-capacity');
  assert.equal(result.proof.fixture, 'F1');
});

test('budget exhaustion returns unknown with pending quantities', () => {
  const instance = makeInstance({
    machines: ['M1', 'M2'],
    tools: [{ id: 'T1', life: 1000 }],
    fixtures: [],
    horizon: 30,
    slotMinutes: 1,
    operations: Array.from({ length: 8 }, (_, i) => ({
      id: `op${i}`,
      machines: ['M1', 'M2'],
      minutes: 5,
      tools: ['T1'],
    })),
  });
  const result = solve(instance, { budget: 1 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.pending.budget, 1);
  assert.ok(result.pending.nodesExplored >= 1);
  assert.ok(result.pending.unresolvedOps > 0);
  assert.equal(result.pending.totalOps, 8);
});
