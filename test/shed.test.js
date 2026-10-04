import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeModel } from '../src/model.js';
import { solve, checkPlan, assignmentShed } from '../src/solver.js';
import { minimalConflict } from '../src/conflict.js';
import { run } from '../src/cli.js';



// ---------- independent brute-force oracle (acceptance 1) ----------

function* product(domains, prefix = []) {
  if (prefix.length === domains.length) {
    yield prefix;
    return;
  }
  for (const value of domains[prefix.length]) {
    yield* product(domains, [...prefix, value]);
  }
}

function bruteFeasible(model, assignment, gap) {
  const { loads, feeders, interlocks, stages: K } = model;
  let shed = 0;
  for (let i = 0; i < loads.length; i += 1) shed += loads[i].shed[assignment[i]];
  if (shed < gap) return false;
  for (const feeder of feeders) {
    for (let s = 0; s <= K; s += 1) {
      const cap = feeder.capacity[s];
      if (cap === Infinity) continue;
      let cumulative = 0;
      for (const i of feeder.loads) {
        if (assignment[i] <= s) cumulative += loads[i].shed[assignment[i]];
      }
      if (cumulative > cap) return false;
    }
  }
  for (const interlock of interlocks) {
    const [a, b] = interlock.loads;
    if (interlock.type === 'together') {
      if (interlock.loads.some((i) => assignment[i] !== assignment[a])) return false;
    } else if (interlock.type === 'sequence') {
      if (assignment[a] > assignment[b]) return false;
    } else if (interlock.type === 'unsheddable') {
      if (interlock.loads.some((i) => assignment[i] !== 0)) return false;
    }
  }
  return true;
}

function bruteCost(model, assignment) {
  const { loads } = model;
  const totalMax = loads.reduce((sum, l) => sum + l.shed[model.stages], 0);
  const M = BigInt(totalMax + 1);
  const tieSpan = BigInt(loads.length + 1);
  const sorted = [...loads.keys()].sort((a, b) => (loads[a].id < loads[b].id ? -1 : 1));
  const rank = new Array(loads.length);
  sorted.forEach((loadIndex, r) => { rank[loadIndex] = r; });
  let cost = 0n;
  for (let i = 0; i < loads.length; i += 1) {
    const amount = BigInt(loads[i].shed[assignment[i]]);
    cost += (M ** BigInt(loads[i].level)) * tieSpan * amount + BigInt(rank[i]) * amount;
  }
  return cost;
}

function bruteForce(model, gap) {
  const domains = model.loads.map(() => {
    const d = [];
    for (let s = 0; s <= model.stages; s += 1) d.push(s);
    return d;
  });
  let best = null;
  for (const assignment of product(domains)) {
    if (!bruteFeasible(model, assignment, gap)) continue;
    const cost = bruteCost(model, assignment);
    if (best === null || cost < best.cost) best = { cost, assignment };
  }
  return best;
}

function crossCheck(rawModel, gap) {
  const model = normalizeModel(rawModel);
  const expected = bruteForce(model, gap);
  const result = solve(model, { gap, budget: 10_000_000 });
  if (expected === null) {
    assert.equal(result.status, 'infeasible', 'solver must prove infeasible');
    return;
  }
  assert.equal(result.status, 'ok');
  assert.equal(result.cost, expected.cost, 'optimal cost must match brute force');
  const plan = model.loads.map((load) => result.plan[load.id]);
  assert.equal(checkPlan(model, plan, gap), null);
  assert.ok(assignmentShed(model, plan) >= gap);
}

// ---------- acceptance 1: enumerate 3-, 4-, 5-load instances ----------

test('3-load instance matches exhaustive enumeration', () => {
  crossCheck({
    stages: 2,
    feeders: [{
      id: 'F1',
      capacity: [0, 60, 200],
      loads: [
        { id: 'L1', power: 50, level: 1, shed: [0, 20, 50] },
        { id: 'L2', power: 40, level: 2, shed: [0, 15, 40] },
        { id: 'L3', power: 30, level: 1, shed: [0, 10, 30] },
      ],
    }],
  }, 55);
});

test('4-load instance with interlocks matches exhaustive enumeration', () => {
  crossCheck({
    stages: 3,
    feeders: [
      {
        id: 'F1',
        capacity: [0, 50, 90, 200],
        loads: [
          { id: 'L1', power: 60, level: 1, shed: [0, 20, 40, 60] },
          { id: 'L2', power: 50, level: 2, shed: [0, 10, 30, 50] },
        ],
      },
      {
        id: 'F2',
        capacity: [0, 40, 80, 200],
        loads: [
          { id: 'L3', power: 40, level: 1, shed: [0, 0, 20, 40] },
          { id: 'L4', power: 70, level: 3, shed: [0, 30, 50, 70] },
        ],
      },
    ],
    interlocks: [
      { type: 'sequence', loads: ['L1', 'L2'] },
      { type: 'together', loads: ['L3', 'L4'] },
    ],
  }, 90);
});

test('5-load instance with unsheddable load matches exhaustive enumeration', () => {
  crossCheck({
    stages: 2,
    feeders: [
      {
        id: 'F1',
        capacity: [0, 70, 300],
        loads: [
          { id: 'L1', power: 50, level: 1, shed: [0, 25, 50] },
          { id: 'L2', power: 60, level: 3, shed: [0, 20, 60] },
          { id: 'L3', power: 45, level: 2, shed: [0, 15, 45] },
        ],
      },
      {
        id: 'F2',
        capacity: [0, 40, 300],
        loads: [
          { id: 'L4', power: 35, level: 1, shed: [0, 10, 35] },
          { id: 'L5', power: 55, level: 2, shed: [0, 25, 55] },
        ],
      },
    ],
    interlocks: [{ type: 'unsheddable', loads: ['L2'] }],
  }, 80);
});

test('infeasible 4-load instance matches exhaustive enumeration', () => {
  crossCheck({
    stages: 2,
    feeders: [{
      id: 'F1',
      capacity: [0, 10, 25],
      loads: [
        { id: 'L1', power: 50, level: 1, shed: [0, 20, 50] },
        { id: 'L2', power: 40, level: 1, shed: [0, 15, 40] },
        { id: 'L3', power: 30, level: 2, shed: [0, 10, 30] },
        { id: 'L4', power: 20, level: 3, shed: [0, 5, 20] },
      ],
    }],
  }, 60);
});

// ---------- acceptance 2: interlock chains that block every stage ----------

test('interlock chain makes gap unreachable and reports minimal conflict', () => {
  const model = normalizeModel({
    stages: 1,
    feeders: [{
      id: 'F1',
      capacity: [0, 500],
      loads: [
        { id: 'L1', power: 60, level: 1, shed: [0, 60] },
        { id: 'L2', power: 60, level: 1, shed: [0, 60] },
        { id: 'L3', power: 60, level: 1, shed: [0, 60] },
      ],
    }],
    interlocks: [
      { type: 'together', loads: ['L1', 'L2'] },
      { type: 'sequence', loads: ['L2', 'L3'] },
      { type: 'unsheddable', loads: ['L3'] },
    ],
  });
  const gap = 50;
  assert.equal(bruteForce(model, gap), null, 'oracle confirms infeasible');
  const result = solve(model, { gap, budget: 10_000 });
  assert.equal(result.status, 'infeasible');
  const conflict = minimalConflict(model, gap);
  assert.deepEqual(conflict.feeders, []);
  assert.deepEqual(conflict.interlocks, [
    { type: 'together', loads: ['L1', 'L2'] },
    { type: 'sequence', loads: ['L2', 'L3'] },
    { type: 'unsheddable', loads: ['L3'] },
  ]);
});

test('feeder capacity conflict is reported as minimal core', () => {
  const model = normalizeModel({
    stages: 2,
    feeders: [{
      id: 'F1',
      capacity: [0, 10, 30],
      loads: [
        { id: 'L1', power: 80, level: 1, shed: [0, 40, 80] },
        { id: 'L2', power: 70, level: 1, shed: [0, 30, 70] },
      ],
    }],
  });
  const result = solve(model, { gap: 50, budget: 10_000 });
  assert.equal(result.status, 'infeasible');
  const conflict = minimalConflict(model, 50);
  assert.deepEqual(conflict.feeders, ['F1']);
  assert.deepEqual(conflict.interlocks, []);
  assert.equal(conflict.maxShed, 150);
});

// ---------- acceptance 3: budget exhaustion -> unknown, never infeasible ----------

const BUDGET_MODEL = {
  stages: 3,
  feeders: [
    {
      id: 'F1',
      capacity: [0, 90, 180, 400],
      loads: [
        { id: 'L1', power: 60, level: 1, shed: [0, 20, 40, 60] },
        { id: 'L2', power: 50, level: 2, shed: [0, 10, 30, 50] },
        { id: 'L3', power: 40, level: 1, shed: [0, 0, 20, 40] },
      ],
    },
    {
      id: 'F2',
      capacity: [0, 60, 120, 400],
      loads: [
        { id: 'L4', power: 70, level: 3, shed: [0, 30, 50, 70] },
        { id: 'L5', power: 30, level: 2, shed: [0, 10, 20, 30] },
      ],
    },
  ],
  interlocks: [{ type: 'sequence', loads: ['L1', 'L2'] }],
};

test('tiny budget returns unknown with pending loads, never infeasible', () => {
  const model = normalizeModel(BUDGET_MODEL);
  const result = solve(model, { gap: 120, budget: 1 });
  assert.equal(result.status, 'unknown');
  assert.ok(result.pending.length > 0, 'pending loads must be listed');
  assert.notEqual(result.status, 'infeasible');
});

test('larger budget finds a verifiable optimal plan', () => {
  const model = normalizeModel(BUDGET_MODEL);
  const result = solve(model, { gap: 120, budget: 1_000_000 });
  assert.equal(result.status, 'ok');
  const plan = model.loads.map((load) => result.plan[load.id]);
  assert.equal(checkPlan(model, plan, 120), null);
  assert.ok(assignmentShed(model, plan) >= 120);
  const expected = bruteForce(model, 120);
  assert.equal(result.cost, expected.cost);
});

// ---------- CLI: exit codes and validation ----------

function runCli(args) {
  const stdout = [];
  const stderr = [];
  const code = run(args, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { status: code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function withModel(model, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'shed-'));
  const path = join(dir, 'model.json');
  writeFileSync(path, JSON.stringify(model));
  return fn(path);
}

test('CLI: negative power exits 2', () => {
  withModel({
    stages: 1,
    feeders: [{ id: 'F1', capacity: [0, 100], loads: [{ id: 'L1', power: -5, level: 1, shed: [0, 10] }] }],
  }, (path) => {
    const run = runCli([path, '--gap', '10']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /negative power/);
  });
});

test('CLI: unknown load in interlock exits 2', () => {
  withModel({
    stages: 1,
    feeders: [{ id: 'F1', capacity: [0, 100], loads: [{ id: 'L1', power: 50, level: 1, shed: [0, 10] }] }],
    interlocks: [{ type: 'unsheddable', loads: ['GHOST'] }],
  }, (path) => {
    const run = runCli([path, '--gap', '10']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown load \\"GHOST\\"/);
  });
});

test('CLI: non-integer stage exits 2', () => {
  withModel({
    stages: 2,
    feeders: [{
      id: 'F1',
      capacity: [0, 50, 100],
      loads: [{ id: 'L1', power: 50, level: 1, shed: { 0: 0, 1.5: 20, 2: 40 } }],
    }],
  }, (path) => {
    const run = runCli([path, '--gap', '10']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /non-integer stage/);
  });
});

test('CLI: feasible model exits 0 with plan', () => {
  withModel(BUDGET_MODEL, (path) => {
    const run = runCli([path, '--gap', '120', '--budget', '300']);
    assert.equal(run.status, 0);
    const out = JSON.parse(run.stdout);
    assert.equal(out.status, 'ok');
    assert.ok(out.shed >= 120);
  });
});

test('CLI: infeasible model exits 1 with conflict', () => {
  withModel({
    stages: 1,
    feeders: [{
      id: 'F1',
      capacity: [0, 500],
      loads: [
        { id: 'L1', power: 60, level: 1, shed: [0, 60] },
        { id: 'L2', power: 60, level: 1, shed: [0, 60] },
        { id: 'L3', power: 60, level: 1, shed: [0, 60] },
      ],
    }],
    interlocks: [
      { type: 'together', loads: ['L1', 'L2'] },
      { type: 'sequence', loads: ['L2', 'L3'] },
      { type: 'unsheddable', loads: ['L3'] },
    ],
  }, (path) => {
    const run = runCli([path, '--gap', '50']);
    assert.equal(run.status, 1);
    const out = JSON.parse(run.stdout);
    assert.equal(out.status, 'infeasible');
    assert.equal(out.conflict.interlocks.length, 3);
  });
});

test('CLI: exhausted budget exits 3 with pending loads', () => {
  withModel(BUDGET_MODEL, (path) => {
    const run = runCli([path, '--gap', '120', '--budget', '1']);
    assert.equal(run.status, 3);
    const out = JSON.parse(run.stdout);
    assert.equal(out.status, 'unknown');
    assert.ok(out.pending.length > 0);
  });
});
