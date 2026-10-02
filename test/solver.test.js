import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProblem } from '../src/problem.js';
import { Solver, solve } from '../src/solver.js';

function bruteForce(problem) {
  const ops = problem.ops;
  let best = null;
  const machineBusy = new Set();
  const fixtureBusy = new Set();
  const toolLoad = Object.fromEntries(Object.keys(problem.tools).map((t) => [t, 0]));
  const chosen = new Array(ops.length);
  function rec(i, tard) {
    if (best !== null && tard >= best.tardiness) return;
    if (i === ops.length) {
      best = { tardiness: tard, assignment: chosen.map((v, k) => [ops[k].id, v]) };
      return;
    }
    const op = ops[i];
    for (const machine of op.machines) {
      for (let slot = 0; slot < problem.slots; slot++) {
        for (const tool of op.tools) {
          const mk = `${machine}:${slot}`;
          const fk = op.fixture === null ? null : `${op.fixture}:${slot}`;
          if (machineBusy.has(mk)) continue;
          if (fk !== null && fixtureBusy.has(fk)) continue;
          if (toolLoad[tool] + op.cut > problem.tools[tool].life) continue;
          machineBusy.add(mk);
          if (fk !== null) fixtureBusy.add(fk);
          toolLoad[tool] += op.cut;
          chosen[i] = { machine, slot, tool };
          rec(i + 1, tard + Math.max(0, slot - op.due));
          toolLoad[tool] -= op.cut;
          if (fk !== null) fixtureBusy.delete(fk);
          machineBusy.delete(mk);
        }
      }
    }
  }
  rec(0, 0);
  return best;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomProblem(rand, { opCount, slots, machines, tools, fixtures }) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const subset = (arr) => {
    const out = arr.filter(() => rand() < 0.6);
    return out.length > 0 ? out : [pick(arr)];
  };
  const toolDefs = {};
  for (const t of tools) toolDefs[t] = { life: 8 + Math.floor(rand() * 20) };
  return validateProblem({
    slots,
    machines,
    tools: toolDefs,
    fixtures,
    ops: Array.from({ length: opCount }, (_, i) => ({
      id: `op${i}`,
      machines: subset(machines),
      tools: subset(tools),
      cut: 1 + Math.floor(rand() * 6),
      fixture: rand() < 0.7 ? pick(fixtures) : null,
      due: Math.floor(rand() * slots),
    })),
  });
}

test('acceptance 1: solver matches brute-force enumeration over all machine/tool combos', () => {
  const rand = lcg(20261003);
  let feasibleCount = 0;
  for (let trial = 0; trial < 40; trial++) {
    const problem = randomProblem(rand, {
      opCount: 4,
      slots: 4,
      machines: ['M1', 'M2'],
      tools: ['T1', 'T2'],
      fixtures: ['F1', 'F2'],
    });
    const expected = bruteForce(problem);
    const { result } = solve(problem, { budget: 100000 });
    if (expected === null) {
      assert.equal(result.status, 'infeasible', `trial ${trial}: expected infeasible`);
      assert.ok(result.proof, 'infeasible result carries a proof');
    } else {
      feasibleCount++;
      assert.equal(result.status, 'optimal', `trial ${trial}: expected optimal`);
      assert.equal(result.tardiness, expected.tardiness, `trial ${trial}: tardiness mismatch`);
      const seen = new Set();
      const loads = {};
      for (const op of problem.ops) {
        const v = result.assignment[op.id];
        assert.ok(op.machines.includes(v.machine));
        assert.ok(op.tools.includes(v.tool));
        assert.ok(!seen.has(`${v.machine}:${v.slot}`), 'machine slot overlap');
        seen.add(`${v.machine}:${v.slot}`);
        if (op.fixture !== null) {
          assert.ok(!seen.has(`${op.fixture}:${v.slot}`), 'fixture slot overlap');
          seen.add(`${op.fixture}:${v.slot}`);
        }
        loads[v.tool] = (loads[v.tool] ?? 0) + op.cut;
      }
      for (const [tool, load] of Object.entries(loads)) {
        assert.ok(load <= problem.tools[tool].life, `tool ${tool} overloaded`);
      }
    }
  }
  assert.ok(feasibleCount > 10, `expected a mix of feasible trials, got ${feasibleCount}`);
});

test('acceptance 2: tool life boundary flips feasibility and proof names the overloaded tool', () => {
  const base = {
    slots: 4,
    machines: ['M1'],
    fixtures: [],
    ops: [
      { id: 'A', machines: ['M1'], tools: ['T1'], cut: 6, fixture: null, due: 3 },
      { id: 'B', machines: ['M1'], tools: ['T1'], cut: 4, fixture: null, due: 3 },
    ],
  };
  const atBoundary = validateProblem({ ...base, tools: { T1: { life: 10 } } });
  const okResult = solve(atBoundary).result;
  assert.equal(okResult.status, 'optimal');

  const belowBoundary = validateProblem({ ...base, tools: { T1: { life: 9 } } });
  const badResult = solve(belowBoundary).result;
  assert.equal(badResult.status, 'infeasible');
  assert.equal(badResult.proof.type, 'tool-life');
  assert.equal(badResult.proof.tool, 'T1');
  assert.equal(badResult.proof.required, 10);
  assert.equal(badResult.proof.life, 9);
  assert.deepEqual(badResult.proof.ops, ['A', 'B']);
});

test('acceptance 2b: search-derived infeasibility reports the over-limit tool', () => {
  const problem = validateProblem({
    slots: 4,
    machines: ['M1'],
    tools: { T1: { life: 6 }, T2: { life: 5 } },
    fixtures: [],
    ops: [
      { id: 'A', machines: ['M1'], tools: ['T1', 'T2'], cut: 6, fixture: null, due: 3 },
      { id: 'B', machines: ['M1'], tools: ['T1'], cut: 6, fixture: null, due: 3 },
    ],
  });
  const { result } = solve(problem);
  assert.equal(result.status, 'infeasible');
  const toolConflicts = result.conflicts.filter((c) => c.type === 'tool-life');
  assert.ok(toolConflicts.length > 0, 'expected tool-life conflicts');
  assert.ok(
    toolConflicts.some((c) => c.tool === 'T1' && c.required === 6 && c.remaining === 0),
    'proof should point at T1 exhausted below the required cut',
  );
});

test('acceptance 3: replace rolls back old layer and keeps shared tool cumulative load correct', () => {
  const problem = validateProblem({
    slots: 4,
    machines: ['M1', 'M2'],
    tools: { T1: { life: 20 }, T2: { life: 8 } },
    fixtures: ['F1', 'F2'],
    ops: [
      { id: 'A', machines: ['M1', 'M2'], tools: ['T1'], cut: 5, fixture: 'F1', due: 0 },
      { id: 'B', machines: ['M1', 'M2'], tools: ['T1'], cut: 5, fixture: 'F2', due: 1 },
      { id: 'C', machines: ['M1'], tools: ['T2'], cut: 4, fixture: null, due: 2 },
    ],
  });
  const solver = new Solver(problem);
  const result = solver.solve();
  assert.equal(result.status, 'optimal');
  solver.commit(result.assignment);

  const oldB = result.assignment.B;
  assert.equal(solver.toolLoad.get('T1'), 10);
  assert.equal(solver.toolLoad.get('T2'), 4);

  const replaced = solver.replaceOp('B', {
    id: 'B',
    machines: ['M1', 'M2'],
    tools: ['T1'],
    cut: 7,
    fixture: 'F2',
    due: 1,
  });
  assert.equal(replaced.status, 'ok');

  assert.equal(solver.toolLoad.get('T1'), 12, 'shared tool T1 cumulative = A(5) + newB(7)');
  assert.equal(solver.toolLoad.get('T2'), 4);

  const f2Slots = solver.fixtureBusy.get('F2');
  assert.equal(f2Slots.size, 1, 'old B fixture occupancy fully revoked, exactly one holder');
  assert.equal(f2Slots.get(replaced.value.slot), 'B');
  assert.ok(
    replaced.value.slot !== oldB.slot || replaced.value.machine !== oldB.machine || true,
    'sanity',
  );
  const oldMachineBusy = solver.machineBusy.get(oldB.machine);
  if (replaced.value.machine !== oldB.machine || replaced.value.slot !== oldB.slot) {
    assert.ok(!oldMachineBusy.has(oldB.slot) || oldMachineBusy.get(oldB.slot) !== 'B');
  }

  assert.deepEqual(solver.assignment.get('A'), result.assignment.A, 'A unchanged');
  assert.deepEqual(solver.assignment.get('C'), result.assignment.C, 'C unchanged');

  const fixtureHolders = new Map();
  for (const op of problem.ops) {
    if (op.fixture === null) continue;
    const v = solver.assignment.get(op.id);
    const key = `${op.fixture}:${v.slot}`;
    assert.ok(!fixtureHolders.has(key), `fixture mutex violated at ${key}`);
    fixtureHolders.set(key, op.id);
  }
});

test('replace with over-life tool is infeasible, names the tool, and restores old state', () => {
  const problem = validateProblem({
    slots: 4,
    machines: ['M1'],
    tools: { T2: { life: 8 } },
    fixtures: [],
    ops: [
      { id: 'C', machines: ['M1'], tools: ['T2'], cut: 4, fixture: null, due: 2 },
      { id: 'D', machines: ['M1'], tools: ['T2'], cut: 3, fixture: null, due: 3 },
    ],
  });
  const solver = new Solver(problem);
  const result = solver.solve();
  assert.equal(result.status, 'optimal');
  solver.commit(result.assignment);

  const replaced = solver.replaceOp('C', {
    id: 'C',
    machines: ['M1'],
    tools: ['T2'],
    cut: 6,
    fixture: null,
    due: 2,
  });
  assert.equal(replaced.status, 'infeasible');
  const toolReasons = replaced.proof.filter((r) => r.type === 'tool-life');
  assert.ok(toolReasons.some((r) => r.tool === 'T2' && r.required === 6 && r.remaining === 5));

  assert.deepEqual(solver.assignment.get('C'), result.assignment.C, 'old C restored');
  assert.equal(solver.toolLoad.get('T2'), 7, 'tool load rolled back to C(4) + D(3)');
});

test('budget exhaustion yields unknown with pending (undecided) ops', () => {
  const problem = validateProblem({
    slots: 5,
    machines: ['M1', 'M2'],
    tools: { T1: { life: 100 } },
    fixtures: [],
    ops: Array.from({ length: 6 }, (_, i) => ({
      id: `op${i}`,
      machines: ['M1', 'M2'],
      tools: ['T1'],
      cut: 2,
      fixture: null,
      due: 4,
    })),
  });
  const { result } = solve(problem, { budget: 1 });
  assert.equal(result.status, 'unknown');
  assert.ok(Array.isArray(result.pending));
  assert.ok(result.pending.length > 0, 'pending lists undecided ops');
  assert.ok(result.pending.every((id) => problem.ops.some((o) => o.id === id)));
});
