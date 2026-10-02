'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StateError,
  computeNewHash,
  validateState,
  planRollback,
  applyRollback,
  verifyCertificate,
} = require('../src/rollback');

function node(path, cost, children = [], status = 'active') {
  return { path, children, cost, status, hash: `hash-${path}` };
}

// proj(100)
// ├── exp1(12): step1(4), step2(6)
// └── exp2(7):  step3(2)
function sampleState() {
  return {
    root: 'proj',
    nodes: {
      proj: node('proj', 100, ['exp1', 'exp2']),
      exp1: node('proj/exp1', 12, ['step1', 'step2']),
      exp2: node('proj/exp2', 7, ['step3']),
      step1: node('proj/exp1/step1', 4),
      step2: node('proj/exp1/step2', 6),
      step3: node('proj/exp2/step3', 2),
    },
  };
}

test('exact budget succeeds and yields old/new hash certificate', () => {
  const state = sampleState();
  const plan = planRollback(state, 'exp1', 10);

  assert.equal(plan.feasible, true);
  assert.equal(plan.totalCost, 10); // 4 + 6 beats billing exp1 for 12
  assert.deepEqual(plan.selected, ['step1', 'step2']);
  assert.deepEqual(plan.affected, ['step1', 'step2', 'exp1']); // descendants first

  const { state: next, certificate } = applyRollback(state, plan);
  assert.equal(next.nodes.step1.status, 'rolled_back');
  assert.equal(next.nodes.step2.status, 'rolled_back');
  assert.equal(next.nodes.exp1.status, 'rolled_back');
  assert.equal(next.nodes.proj.status, 'active');
  assert.equal(next.nodes.exp2.status, 'active');

  assert.equal(certificate.entries.length, 3);
  for (const entry of certificate.entries) {
    assert.equal(entry.oldHash, `hash-${entry.path}`);
    assert.equal(entry.newHash, computeNewHash(entry.id, entry.oldHash));
    assert.equal(next.nodes[entry.id].hash, entry.newHash);
  }
  assert.deepEqual(verifyCertificate(next, certificate), { ok: true, errors: [] });

  // Original state object is not mutated by applyRollback.
  assert.equal(state.nodes.exp1.status, 'active');
});

test('budget below minimum cost is infeasible and changes nothing', () => {
  const state = sampleState();
  const before = JSON.stringify(state);
  const plan = planRollback(state, 'exp1', 9);
  assert.equal(plan.feasible, false);
  assert.equal(plan.totalCost, 10);
  assert.equal(JSON.stringify(state), before);
});

test('tied minimal-cost sets resolve to smallest path concatenation', () => {
  const state = sampleState();
  state.nodes.exp1.cost = 10; // bill exp1 (10) ties with billing step1+step2 (4+6)
  const plan = planRollback(state, 'exp1', 10);
  assert.equal(plan.totalCost, 10);
  // 'proj/exp1' < 'proj/exp1/step1proj/exp1/step2', so the single-node set wins.
  assert.deepEqual(plan.selected, ['exp1']);
  assert.equal(plan.concat, 'proj/exp1');
  assert.deepEqual(plan.affected, ['step1', 'step2', 'exp1']); // cascade still rolls back descendants first
});

test('strictly cheaper decomposition wins over billing the parent', () => {
  const state = sampleState();
  state.nodes.exp1.cost = 11;
  const plan = planRollback(state, 'exp1', 11);
  assert.equal(plan.totalCost, 10);
  assert.deepEqual(plan.selected, ['step1', 'step2']);
  assert.equal(plan.concat, 'proj/exp1/step1proj/exp1/step2');
});

test('shared nodes are billed only once', () => {
  const state = {
    root: 'proj',
    nodes: {
      proj: node('proj', 100, ['expA', 'expB']),
      expA: node('proj/expA', 5, ['shared']),
      expB: node('proj/expB', 5, ['shared']),
      shared: node('proj/shared', 1),
    },
  };
  const plan = planRollback(state, 'proj', 100);
  assert.equal(plan.totalCost, 1); // not 2: the shared step is charged a single time
  assert.deepEqual(plan.selected, ['shared']);
  assert.deepEqual(plan.affected, ['shared', 'expA', 'expB', 'proj']);
});

test('already rolled-back nodes are never billed again', () => {
  const state = {
    root: 'proj',
    nodes: {
      proj: node('proj', 100, ['exp1']),
      exp1: node('proj/exp1', 10, ['step1', 'step2']),
      step1: node('proj/exp1/step1', 4, [], 'rolled_back'),
      step2: node('proj/exp1/step2', 3),
    },
  };
  const plan = planRollback(state, 'exp1', 10);
  assert.equal(plan.totalCost, 3); // only step2 is billable
  assert.deepEqual(plan.selected, ['step2']);
  assert.deepEqual(plan.affected, ['step2', 'exp1']);

  const { state: next, certificate } = applyRollback(state, plan);
  assert.equal(next.nodes.step1.hash, 'hash-proj/exp1/step1'); // untouched
  assert.ok(!certificate.entries.some((e) => e.id === 'step1'));
});

test('rolling back an already rolled-back node is rejected', () => {
  const state = sampleState();
  state.nodes.exp1.status = 'rolled_back';
  state.nodes.step1.status = 'rolled_back';
  state.nodes.step2.status = 'rolled_back';
  assert.throws(() => planRollback(state, 'exp1', 100), StateError);
});

test('state violating the ancestor/descendant status constraint is rejected', () => {
  const state = sampleState();
  state.nodes.exp1.status = 'rolled_back'; // but step1/step2 remain active
  assert.throws(() => validateState(state), /descendant/);
});

test('brute-force enumeration of all valid subsets matches the planner', () => {
  // Deterministic PRNG for reproducible random trees.
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

  function randomState(rng) {
    const nodes = {};
    let counter = 0;
    function build(path, depth) {
      const id = `n${counter++}`;
      const children = [];
      if (depth < 3 && rng() < 0.7) {
        const count = 1 + Math.floor(rng() * 2);
        for (let i = 0; i < count; i++) children.push(build(`${path}/c${i}`, depth + 1));
      }
      nodes[id] = node(path, Math.floor(rng() * 10), children);
      return id;
    }
    const root = build('r', 0);
    // Roll back whole random subtrees so the status invariant holds.
    for (const id of Object.keys(nodes)) {
      if (id !== root && rng() < 0.2) {
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop();
          nodes[cur].status = 'rolled_back';
          stack.push(...nodes[cur].children);
        }
      }
    }
    return { root, nodes };
  }

  // Reference semantics: enumerate every subset of active nodes in the
  // target's subtree, keep those whose rollback covers the target and that
  // never bill a node already rolled back by another billed node's cascade,
  // then find the minimum cost with the path-concatenation tie-break.
  function bruteForce(state, targetId) {
    const inSubtree = [];
    const collect = (id) => {
      if (state.nodes[id].status !== 'active') return;
      inSubtree.push(id);
      for (const c of state.nodes[id].children) collect(c);
    };
    collect(targetId);
    const activeIds = [...new Set(inSubtree)];
    const activeChildrenOf = (id) =>
      state.nodes[id].children.filter((c) => state.nodes[c].status === 'active');

    function cascadeDisjoint(billed) {
      const set = new Set(billed);
      for (const id of billed) {
        const stack = [...state.nodes[id].children];
        const seen = new Set();
        while (stack.length) {
          const cur = stack.pop();
          if (seen.has(cur) || state.nodes[cur].status !== 'active') continue;
          seen.add(cur);
          if (set.has(cur)) return false; // billed twice: already covered by a cascade
          stack.push(...state.nodes[cur].children);
        }
      }
      return true;
    }

    function coversTarget(billed) {
      const cascade = new Set();
      const mark = (id) => {
        if (state.nodes[id].status !== 'active' || cascade.has(id)) return;
        cascade.add(id);
        for (const c of state.nodes[id].children) mark(c);
      };
      for (const id of billed) mark(id);
      const memo = new Map();
      const covered = (id) => {
        if (state.nodes[id].status !== 'active') return true;
        if (cascade.has(id)) return true;
        if (memo.has(id)) return memo.get(id);
        memo.set(id, false); // guard; inputs are acyclic
        const kids = activeChildrenOf(id);
        const result = kids.length > 0 && kids.every(covered);
        memo.set(id, result);
        return result;
      };
      return covered(targetId);
    }

    let best = null;
    const total = 1 << activeIds.length;
    for (let mask = 0; mask < total; mask++) {
      const billed = [];
      for (let i = 0; i < activeIds.length; i++) {
        if (mask & (1 << i)) billed.push(activeIds[i]);
      }
      if (!cascadeDisjoint(billed)) continue;
      if (!coversTarget(billed)) continue;
      const cost = billed.reduce((sum, id) => sum + state.nodes[id].cost, 0);
      const concat = billed.map((id) => state.nodes[id].path).sort().join('');
      if (
        !best ||
        cost < best.cost ||
        (cost === best.cost && concat < best.concat)
      ) {
        best = { cost, concat };
      }
    }
    return best;
  }

  for (let seed = 1; seed <= 40; seed++) {
    const rng = mulberry32(seed);
    const state = randomState(rng);
    validateState(state);
    const activeIds = Object.keys(state.nodes).filter(
      (id) => state.nodes[id].status === 'active',
    );
    assert.ok(activeIds.length <= 12, 'enumeration stays small');
    const targetId = activeIds[Math.floor(rng() * activeIds.length)];
    const expected = bruteForce(state, targetId);
    assert.ok(expected, 'billing the target itself is always valid');

    const plan = planRollback(state, targetId, expected.cost);
    assert.equal(plan.totalCost, expected.cost, `seed ${seed} cost`);
    assert.equal(plan.concat, expected.concat, `seed ${seed} tie-break`);
    assert.equal(plan.feasible, true);
    if (expected.cost > 0) {
      assert.equal(planRollback(state, targetId, expected.cost - 1).feasible, false);
    }
  }
});
