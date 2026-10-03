'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProblem, solve } = require('../src/index.js');
const { referenceSolve } = require('./reference.js');
const { mulberry32, randomProblem } = require('./helpers.js');

function assertMatchesReference(raw, label) {
  const problem = validateProblem(raw);
  const got = solve(problem);
  const want = referenceSolve(problem);
  assert.ok(want, `${label}: reference found no plan`);
  assert.equal(got.objective.downtime, want.downtime, `${label}: downtime`);
  assert.equal(got.objective.cost, want.cost, `${label}: cost`);
  assert.deepEqual(got.sequence, want.sequence, `${label}: task sequence`);
  return got;
}

// Re-checks that a reported schedule is feasible and achieves its objective.
function assertFeasible(raw, result, label) {
  const problem = validateProblem(raw);
  let cost = 0;
  let downtime = 0;
  const usage = {};
  for (const name of Object.keys(problem.parts)) usage[name] = 0;
  for (const task of problem.tasks) {
    const out = result.tasks[task.id];
    assert.ok(out, `${label}: task ${task.id} missing from output`);
    if (out.state === 'deferred') {
      downtime += task.downtime * task.deferPenalty;
      continue;
    }
    const mode = task.modes.find((m) => m.id === out.mode);
    assert.ok(mode, `${label}: task ${task.id} unknown mode ${out.mode}`);
    cost += mode.cost;
    assert.equal(out.end - out.start, mode.duration, `${label}: ${task.id} duration`);
    downtime += task.downtime * out.end;
    for (const dep of task.deps) {
      const depOut = result.tasks[dep];
      assert.equal(depOut.state, 'scheduled', `${label}: ${task.id} scheduled but ${dep} deferred`);
      assert.ok(depOut.end <= out.start, `${label}: precedence ${dep} -> ${task.id}`);
    }
    for (const [part, qty] of Object.entries(mode.parts || {})) usage[part] += qty;
  }
  assert.ok(cost <= problem.budget, `${label}: budget`);
  for (const [part, qty] of Object.entries(usage)) {
    assert.ok(qty <= problem.parts[part], `${label}: part ${part}`);
  }
  for (const crew of result.crews) {
    for (let i = 1; i < crew.length; i += 1) {
      assert.ok(crew[i - 1].end <= crew[i].start, `${label}: crew overlap`);
    }
  }
  assert.equal(result.objective.cost, cost, `${label}: reported cost`);
  assert.equal(result.objective.downtime, downtime, `${label}: reported downtime`);
}

test('hand-built chain instance matches reference enumeration', () => {
  const chain = {
    budget: 100,
    parts: { pump: 1 },
    tasks: [
      { id: 'A', downtime: 2, modes: [{ id: 'f', duration: 2, cost: 60, parts: { pump: 1 } }, { id: 's', duration: 5, cost: 10 }] },
      { id: 'B', deps: ['A'], downtime: 1, modes: [{ id: 'f', duration: 1, cost: 50 }, { id: 's', duration: 3, cost: 5 }] },
      { id: 'C', deps: ['B'], downtime: 4, deferPenalty: 30, modes: [{ id: 'x', duration: 2, cost: 40 }] },
    ],
  };
  const result = assertMatchesReference(chain, 'chain');
  assertFeasible(chain, result, 'chain');
});

test('diamond instance with tight budget matches reference', () => {
  const diamond = {
    budget: 55,
    parts: { seal: 1 },
    tasks: [
      { id: 'A', downtime: 3, modes: [{ id: 'm', duration: 2, cost: 10 }, { id: 'q', duration: 1, cost: 25 }] },
      { id: 'B', deps: ['A'], downtime: 1, deferPenalty: 12, modes: [{ id: 'm', duration: 3, cost: 15, parts: { seal: 1 } }, { id: 'c', duration: 5, cost: 4 }] },
      { id: 'C', deps: ['A'], downtime: 2, deferPenalty: 9, modes: [{ id: 'm', duration: 2, cost: 20 }, { id: 'c', duration: 4, cost: 6 }] },
      { id: 'D', deps: ['B', 'C'], downtime: 5, deferPenalty: 20, modes: [{ id: 'm', duration: 1, cost: 12 }] },
    ],
  };
  const result = assertMatchesReference(diamond, 'diamond');
  assertFeasible(diamond, result, 'diamond');
});

test('8-task instance matches reference enumeration', () => {
  const raw = {
    budget: 120,
    crews: 2,
    parts: { pump: 1, seal: 2 },
    tasks: [
      { id: 'T0', downtime: 4, modes: [{ id: 'a', duration: 2, cost: 15 }, { id: 'b', duration: 4, cost: 5 }] },
      { id: 'T1', deps: ['T0'], downtime: 3, deferPenalty: 20, modes: [{ id: 'a', duration: 3, cost: 25, parts: { pump: 1 } }, { id: 'b', duration: 6, cost: 8 }] },
      { id: 'T2', deps: ['T0'], downtime: 2, deferPenalty: 15, modes: [{ id: 'a', duration: 1, cost: 30 }, { id: 'b', duration: 3, cost: 9, parts: { seal: 1 } }] },
      { id: 'T3', deps: ['T1'], downtime: 5, deferPenalty: 25, modes: [{ id: 'a', duration: 2, cost: 20 }, { id: 'b', duration: 5, cost: 6 }] },
      { id: 'T4', deps: ['T1', 'T2'], downtime: 1, deferPenalty: 10, modes: [{ id: 'a', duration: 2, cost: 12, parts: { seal: 1 } }] },
      { id: 'T5', deps: ['T3'], downtime: 3, deferPenalty: 18, modes: [{ id: 'a', duration: 1, cost: 22 }, { id: 'b', duration: 4, cost: 7 }] },
      { id: 'T6', deps: ['T4'], downtime: 2, deferPenalty: 12, modes: [{ id: 'a', duration: 3, cost: 14 }, { id: 'b', duration: 2, cost: 26 }] },
      { id: 'T7', deps: ['T5', 'T6'], downtime: 6, deferPenalty: 30, modes: [{ id: 'a', duration: 2, cost: 18 }] },
    ],
  };
  const result = assertMatchesReference(raw, 'eight-task');
  assertFeasible(raw, result, 'eight-task');
  assert.ok(result.certificate.plansConsidered > 0);
  assert.ok(result.certificate.schedulesEvaluated > 0);
});

test('randomized instances (n<=6) match reference enumeration', () => {
  const rng = mulberry32(20261003);
  for (let k = 0; k < 40; k += 1) {
    const raw = randomProblem(rng, { n: 2 + Math.floor(rng() * 5), parts: k % 3 === 0 ? ['p1', 'p2'] : [] });
    const result = assertMatchesReference(raw, `random-${k}`);
    assertFeasible(raw, result, `random-${k}`);
  }
});

test('randomized 7-8 task instances match reference enumeration', () => {
  const rng = mulberry32(777);
  for (let k = 0; k < 6; k += 1) {
    const raw = randomProblem(rng, {
      n: 7 + Math.floor(rng() * 2),
      maxModes: 2,
      depProb: 0.35,
      parts: ['p1'],
    });
    assertMatchesReference(raw, `random-large-${k}`);
  }
});

test('empty problem is feasible with zero objective', () => {
  const result = solve(validateProblem({ budget: 0, tasks: [] }));
  assert.equal(result.objective.downtime, 0);
  assert.equal(result.objective.cost, 0);
  assert.deepEqual(result.sequence, []);
});

test('deferred successor invalidation propagates through the DAG', () => {
  const raw = {
    budget: 0,
    tasks: [
      { id: 'A', downtime: 1, deferPenalty: 5, modes: [{ id: 'm', duration: 1, cost: 10 }] },
      { id: 'B', deps: ['A'], downtime: 1, deferPenalty: 5, modes: [{ id: 'm', duration: 1, cost: 1 }] },
      { id: 'C', deps: ['B'], downtime: 1, deferPenalty: 5, modes: [{ id: 'm', duration: 1, cost: 1 }] },
    ],
  };
  const result = solve(validateProblem(raw));
  assert.equal(result.tasks.A.state, 'deferred');
  assert.equal(result.tasks.A.reason, 'insufficient-budget');
  assert.equal(result.tasks.B.state, 'deferred');
  assert.equal(result.tasks.B.reason, 'predecessor-deferred');
  assert.equal(result.tasks.C.state, 'deferred');
  assert.equal(result.tasks.C.reason, 'predecessor-deferred');
  assert.equal(result.objective.cost, 0);
});

test('certificate and critical constraints are reported', () => {
  const raw = {
    budget: 10,
    parts: { pump: 1 },
    tasks: [
      { id: 'A', downtime: 1, modes: [{ id: 'm', duration: 2, cost: 10, parts: { pump: 1 } }] },
      { id: 'B', deps: ['A'], downtime: 1, modes: [{ id: 'm', duration: 2, cost: 0 }] },
    ],
  };
  const result = solve(validateProblem(raw));
  assert.equal(result.criticalConstraints.budget.binding, true);
  assert.deepEqual(result.criticalConstraints.parts, [{ part: 'pump', used: 1, limit: 1, binding: true }]);
  assert.deepEqual(result.criticalConstraints.precedence, [{ from: 'A', to: 'B', slack: 0 }]);
  assert.equal(result.certificate.method, 'exhaustive-enumeration');
  assert.match(result.certificate.problemHash, /^[0-9a-f]{64}$/);
});
