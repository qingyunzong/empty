import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, EXIT_OK, EXIT_INFEASIBLE, EXIT_ERROR } from '../src/commands.js';
import { normalizeState, closureOf } from '../src/state.js';
import { planCost, selectPlan, isMinimalCovering, concatKey, executionOrder } from '../src/planner.js';
import { transitionHash, verifyCertificate, buildCertificate, applyCertificate } from '../src/certificate.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'rollback-test-'));
}

function writeState(dir, nodes, name = 'state.json') {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify({ nodes }, null, 2) + '\n');
  return filePath;
}

// Drives the real CLI code path in-process (the sandbox forbids spawning
// child processes) and captures exit code plus stdout/stderr lines.
function runCli(args, cwd) {
  const out = [];
  const err = [];
  const status = run(args, {
    cwd,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

// Tree A:
//   proj(4, active)
//   ├── exp1(3, active)
//   │   ├── step1(2, active)
//   │   └── step2(5, rolled-back)
//   └── exp2(1, rolled-back)
function treeA() {
  return [
    { id: 'proj', parent: null, cost: 4, status: 'active', hash: 'h-proj' },
    { id: 'exp1', parent: 'proj', cost: 3, status: 'active', hash: 'h-exp1' },
    { id: 'step1', parent: 'exp1', cost: 2, status: 'active', hash: 'h-step1' },
    { id: 'step2', parent: 'exp1', cost: 5, status: 'rolled-back', hash: 'h-step2' },
    { id: 'exp2', parent: 'proj', cost: 1, status: 'rolled-back', hash: 'h-exp2' },
  ];
}

test('exact budget: plan feasible, commit rolls back descendants-first, certificate verifies', () => {
  const dir = tmp();
  const statePath = writeState(dir, treeA());

  const planResult = runCli(['plan', statePath, '--node', 'exp1', '--budget', '5'], dir);
  assert.equal(planResult.status, EXIT_OK, planResult.stderr);
  const plan = JSON.parse(planResult.stdout);
  assert.equal(plan.status, 'feasible');
  assert.equal(plan.cost, 5); // exp1(3) + step1(2); step2 already rolled back, not charged
  assert.deepEqual(plan.nodes, ['exp1']);
  assert.deepEqual(plan.affected, ['step1', 'exp1']); // active descendants first

  const commitResult = runCli(['commit', statePath, '--node', 'exp1', '--budget', '5'], dir);
  assert.equal(commitResult.status, EXIT_OK, commitResult.stderr);

  const cert = JSON.parse(readFileSync(join(dir, 'certificate.json'), 'utf8'));
  assert.equal(cert.target, 'exp1');
  assert.equal(cert.cost, 5);
  assert.deepEqual(cert.entries.map((e) => e.id), ['step1', 'exp1']);
  assert.equal(cert.entries[0].oldHash, 'h-step1');
  assert.equal(cert.entries[0].newHash, transitionHash('step1', 'h-step1'));
  assert.equal(cert.entries[1].oldHash, 'h-exp1');
  assert.equal(cert.entries[1].newHash, transitionHash('exp1', 'h-exp1'));

  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  const byId = Object.fromEntries(after.nodes.map((n) => [n.id, n]));
  assert.equal(byId.step1.status, 'rolled-back');
  assert.equal(byId.exp1.status, 'rolled-back');
  assert.equal(byId.step1.hash, cert.entries[0].newHash);
  assert.equal(byId.exp1.hash, cert.entries[1].newHash);
  assert.equal(byId.step2.hash, 'h-step2'); // untouched nodes keep their hash
  assert.equal(byId.proj.hash, 'h-proj');
  assert.equal(byId.proj.status, 'active');

  const verifyResult = runCli(['verify', statePath], dir);
  assert.equal(verifyResult.status, EXIT_OK, verifyResult.stderr);
  assert.match(verifyResult.stdout, /certificate valid/);
});

test('insufficient budget: exit code 2, infeasible.json written, state untouched', () => {
  const dir = tmp();
  const statePath = writeState(dir, treeA());
  const before = readFileSync(statePath, 'utf8');

  const planResult = runCli(['plan', statePath, '--node', 'exp1', '--budget', '4'], dir);
  assert.equal(planResult.status, EXIT_INFEASIBLE);
  const report = JSON.parse(planResult.stdout);
  assert.equal(report.status, 'infeasible');
  assert.equal(report.requiredCost, 5);
  const infeasibleFile = JSON.parse(readFileSync(join(dir, 'infeasible.json'), 'utf8'));
  assert.equal(infeasibleFile.status, 'infeasible');
  assert.equal(infeasibleFile.requiredCost, 5);

  const commitResult = runCli(['commit', statePath, '--node', 'exp1', '--budget', '4'], dir);
  assert.equal(commitResult.status, EXIT_INFEASIBLE);
  assert.equal(readFileSync(statePath, 'utf8'), before, 'state file must be byte-identical');
  assert.equal(existsSync(join(dir, 'certificate.json')), false, 'no certificate may be written');
});

test('tie between minimum-cost sets: lexicographically smallest concatenated paths win', () => {
  // proj(0) -> exp1(0) -> step1(3, target); exp2(7, rolled-back) hangs off proj.
  // cost({step1}) = cost({exp1}) = cost({proj}) = 3, all within budget 3.
  const nodes = [
    { id: 'proj', parent: null, cost: 0, status: 'active' },
    { id: 'exp1', parent: 'proj', cost: 0, status: 'active' },
    { id: 'step1', parent: 'exp1', cost: 3, status: 'active' },
    { id: 'exp2', parent: 'proj', cost: 7, status: 'rolled-back' },
  ];
  const state = normalizeState({ nodes });
  const plan = selectPlan(state, 'step1', 3);
  assert.equal(plan.feasible, true);
  assert.equal(plan.cost, 3);
  assert.equal(plan.tiedSets.length, 3);
  // "/proj" < "/proj/exp1" < "/proj/exp1/step1" -> the root singleton wins.
  assert.deepEqual(plan.nodes, ['proj']);

  // Make proj expensive: tie only between {step1} and {exp1}; "/proj/exp1" wins.
  const nodes2 = nodes.map((n) => (n.id === 'proj' ? { ...n, cost: 2 } : n));
  const plan2 = selectPlan(normalizeState({ nodes: nodes2 }), 'step1', 3);
  assert.equal(plan2.cost, 3);
  assert.equal(plan2.tiedSets.length, 2);
  assert.deepEqual(plan2.nodes, ['exp1']);

  // No tie: only the target singleton is cheapest.
  const nodes3 = nodes.map((n) => (n.id === 'exp1' ? { ...n, cost: 1 } : n));
  const plan3 = selectPlan(normalizeState({ nodes: nodes3 }), 'step1', 4);
  assert.equal(plan3.cost, 3);
  assert.deepEqual(plan3.nodes, ['step1']);
});

test('shared nodes are charged once; rolled-back nodes are never charged again', () => {
  const state = normalizeState({ nodes: treeA() });
  // exp1 and step1 share step1's subtree; union charged once: exp1(3) + step1(2).
  assert.equal(planCost(state, ['exp1', 'step1']), 5);
  assert.equal(closureOf(state, ['exp1', 'step1']).size, 3); // exp1, step1, step2
  // Whole tree: step2 and exp2 are rolled back and contribute nothing.
  assert.equal(planCost(state, ['proj']), 9);
  // A set containing only rolled-back nodes costs nothing.
  assert.equal(planCost(state, ['step2', 'exp2']), 0);
});

test('execution order rolls back active descendants before their ancestors', () => {
  const nodes = [
    { id: 'r', parent: null, cost: 1, status: 'active' },
    { id: 'a', parent: 'r', cost: 1, status: 'active' },
    { id: 'b', parent: 'r', cost: 1, status: 'active' },
    { id: 'a1', parent: 'a', cost: 1, status: 'active' },
    { id: 'a2', parent: 'a', cost: 1, status: 'rolled-back' },
  ];
  const state = normalizeState({ nodes });
  const order = executionOrder(state, ['r']);
  assert.deepEqual(order, ['a1', 'a', 'b', 'r']); // deepest first, path order among siblings
  const pos = Object.fromEntries(order.map((id, i) => [id, i]));
  assert.ok(pos.a1 < pos.a);
  assert.ok(pos.a < pos.r && pos.b < pos.r);
});

// Reference implementation for cross-checking: enumerate every node subset,
// keep the ones satisfying the tree constraints (covers the target and is
// inclusion-minimal), and pick the minimum-cost one within budget, breaking
// ties by the concatenated-paths key.
function bruteForceSelect(state, target, budget) {
  const ids = [...state.nodes.keys()];
  const feasible = [];
  for (let mask = 1; mask < (1 << ids.length); mask += 1) {
    const subset = ids.filter((_, i) => (mask & (1 << i)) !== 0);
    if (!isMinimalCovering(state, subset, target)) continue;
    feasible.push({ ids: subset, cost: planCost(state, subset), key: concatKey(state, subset) });
  }
  const requiredCost = Math.min(...feasible.map((f) => f.cost));
  const within = feasible.filter((f) => f.cost <= budget);
  if (within.length === 0) return { feasible: false, requiredCost };
  const bestCost = Math.min(...within.map((f) => f.cost));
  const winners = within.filter((f) => f.cost === bestCost).sort((a, b) => (a.key < b.key ? -1 : 1));
  return { feasible: true, cost: bestCost, nodes: winners[0].ids };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('library selection matches brute-force enumeration over all node subsets', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 60; trial += 1) {
    const count = 1 + Math.floor(rand() * 8); // 1..8 nodes -> up to 255 subsets
    const nodes = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push({
        id: `n${i}`,
        parent: i === 0 ? null : `n${Math.floor(rand() * i)}`,
        cost: Math.floor(rand() * 7),
        status: rand() < 0.3 ? 'rolled-back' : 'active',
      });
    }
    const state = normalizeState({ nodes });
    const target = `n${Math.floor(rand() * count)}`;
    const maxCost = planCost(state, [state.root]);
    for (let budget = 0; budget <= maxCost + 1; budget += 1) {
      const expected = bruteForceSelect(state, target, budget);
      const actual = selectPlan(state, target, budget);
      assert.equal(actual.feasible, expected.feasible, `trial ${trial} budget ${budget}`);
      if (!expected.feasible) {
        assert.equal(actual.requiredCost, expected.requiredCost);
      } else {
        assert.equal(actual.cost, expected.cost, `trial ${trial} budget ${budget}`);
        assert.deepEqual([...actual.nodes].sort(), [...expected.nodes].sort());
      }
    }
  }
});

test('verify rejects a tampered certificate and a mutated state', () => {
  const dir = tmp();
  const statePath = writeState(dir, treeA());
  assert.equal(runCli(['commit', statePath, '--node', 'exp1', '--budget', '5'], dir).status, EXIT_OK);

  // Tamper with the certificate: flip one character of a newHash.
  const certPath = join(dir, 'certificate.json');
  const cert = JSON.parse(readFileSync(certPath, 'utf8'));
  cert.entries[0].newHash = cert.entries[0].newHash.replace(/^./, '0');
  writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');
  const badCert = runCli(['verify', statePath], dir);
  assert.equal(badCert.status, EXIT_ERROR);

  // Mutate the state behind a valid certificate's back.
  const freshDir = tmp();
  const freshState = writeState(freshDir, treeA());
  assert.equal(runCli(['commit', freshState, '--node', 'exp1', '--budget', '5'], freshDir).status, EXIT_OK);
  const mutated = JSON.parse(readFileSync(freshState, 'utf8'));
  mutated.nodes.find((n) => n.id === 'proj').cost = 99;
  writeFileSync(freshState, JSON.stringify(mutated, null, 2) + '\n');
  const badState = runCli(['verify', freshState], freshDir);
  assert.equal(badState.status, EXIT_ERROR);
});

test('certificate verifies against the in-memory state after commit', () => {
  const state = normalizeState({ nodes: treeA() });
  const plan = selectPlan(state, 'exp1', 5);
  assert.equal(plan.feasible, true);
  const cert = buildCertificate(state, plan);
  applyCertificate(state, cert);
  const result = verifyCertificate(state, cert);
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('already rolled-back target with no active descendants yields an empty, free plan', () => {
  const nodes = [
    { id: 'r', parent: null, cost: 5, status: 'active' },
    { id: 'x', parent: 'r', cost: 3, status: 'rolled-back' },
    { id: 'y', parent: 'x', cost: 2, status: 'rolled-back' },
  ];
  const state = normalizeState({ nodes });
  const plan = selectPlan(state, 'x', 0);
  assert.equal(plan.feasible, true);
  assert.equal(plan.cost, 0);
  assert.deepEqual(plan.affected, []);
});

test('invalid state files are rejected', () => {
  assert.throws(() => normalizeState({ nodes: [{ id: 'a', parent: null, cost: 1, status: 'active' }, { id: 'b', parent: null, cost: 1, status: 'active' }] }), /exactly one root/);
  assert.throws(() => normalizeState({ nodes: [{ id: 'a', parent: 'missing', cost: 1, status: 'active' }, { id: 'r', parent: null, cost: 1, status: 'active' }] }), /unknown parent/);
  assert.throws(() => normalizeState({ nodes: [{ id: 'a', parent: null, cost: -1, status: 'active' }] }), /non-negative/);
  assert.throws(() => normalizeState({ nodes: [{ id: 'a', parent: null, cost: 1, status: 'weird' }] }), /status/);
});
