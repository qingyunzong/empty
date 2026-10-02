'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { BudgetTree } = require('../src/tree');
const { interleavings, explore, applyOp } = require('../src/enumerator');

function multisetPermutations(items) {
  const arr = items.slice().sort();
  const result = [];
  for (;;) {
    result.push(arr.slice());
    let i = arr.length - 2;
    while (i >= 0 && arr[i] >= arr[i + 1]) i -= 1;
    if (i < 0) return result;
    let j = arr.length - 1;
    while (arr[j] <= arr[i]) j -= 1;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    let lo = i + 1;
    let hi = arr.length - 1;
    while (lo < hi) {
      [arr[lo], arr[hi]] = [arr[hi], arr[lo]];
      lo += 1;
      hi -= 1;
    }
  }
}

function replayModel(nodesSpec, trace) {
  const parent = new Map();
  const limit = new Map();
  for (const node of nodesSpec) {
    parent.set(node.id, node.parent ?? null);
    limit.set(node.id, node.limit);
  }
  const held = new Map([...limit.keys()].map((id) => [id, 0]));
  const used = new Map([...limit.keys()].map((id) => [id, 0]));
  const batches = new Map();
  const events = [];
  const ancestorsOf = (id) => {
    const path = [];
    let cursor = id;
    while (cursor !== null) {
      path.push(cursor);
      cursor = parent.get(cursor);
    }
    return path;
  };
  const subtreeSum = (id, map) => {
    let sum = 0;
    for (const [nodeId, value] of map) {
      if (ancestorsOf(nodeId).includes(id)) sum += value;
    }
    return sum;
  };
  for (const { op } of trace) {
    if (op.op === 'reserve') {
      if (batches.has(op.batch)) {
        events.push('INVALID_BATCH');
        continue;
      }
      if (op.holds.some((hold) => !limit.has(hold.node))) {
        events.push('INVALID_TREE');
        continue;
      }
      const delta = new Map();
      for (const hold of op.holds) {
        for (const ancestor of ancestorsOf(hold.node)) {
          delta.set(ancestor, (delta.get(ancestor) ?? 0) + hold.amount);
        }
      }
      let fits = true;
      for (const [ancestor, amount] of delta) {
        if (subtreeSum(ancestor, held) + subtreeSum(ancestor, used) + amount > limit.get(ancestor)) {
          fits = false;
          break;
        }
      }
      if (!fits) {
        events.push('INVALID_BATCH');
        continue;
      }
      for (const hold of op.holds) held.set(hold.node, held.get(hold.node) + hold.amount);
      batches.set(op.batch, { state: 'held', holds: op.holds });
      events.push('ok');
    } else if (op.op === 'cancel' || op.op === 'release') {
      const batch = batches.get(op.batch);
      if (!batch || batch.state !== 'held') {
        events.push('INVALID_BATCH');
        continue;
      }
      for (const hold of batch.holds) held.set(hold.node, held.get(hold.node) - hold.amount);
      batch.state = 'cancelled';
      events.push('ok');
    } else if (op.op === 'settle') {
      const batch = batches.get(op.batch);
      if (!batch || batch.state !== 'held') {
        events.push('INVALID_BATCH');
        continue;
      }
      for (const hold of batch.holds) {
        held.set(hold.node, held.get(hold.node) - hold.amount);
        used.set(hold.node, used.get(hold.node) + hold.amount);
      }
      batch.state = 'settled';
      events.push('ok');
    } else {
      throw new Error(`model does not support op ${op.op}`);
    }
  }
  return { held, used, events };
}

const depth2Spec = {
  nodes: [
    { id: 'root', parent: null, limit: 100 },
    { id: 'mid', parent: 'root', limit: 60 },
    { id: 'leaf1', parent: 'mid', limit: 30 },
    { id: 'leaf2', parent: 'mid', limit: 30 },
  ],
};

const actorSets = [
  [
    { id: 'A', ops: [{ op: 'reserve', batch: 'bA', holds: [{ node: 'leaf1', amount: 5 }] }] },
    { id: 'B', ops: [{ op: 'reserve', batch: 'bB', holds: [{ node: 'leaf2', amount: 7 }] }] },
  ],
  [
    {
      id: 'A',
      ops: [
        { op: 'reserve', batch: 'bA', holds: [{ node: 'leaf1', amount: 5 }] },
        { op: 'settle', batch: 'bA' },
      ],
    },
    { id: 'B', ops: [{ op: 'reserve', batch: 'bB', holds: [{ node: 'leaf2', amount: 7 }] }] },
  ],
  [
    {
      id: 'A',
      ops: [
        { op: 'reserve', batch: 'bA', holds: [{ node: 'leaf1', amount: 5 }] },
        { op: 'settle', batch: 'bA' },
      ],
    },
    {
      id: 'B',
      ops: [
        { op: 'reserve', batch: 'bB', holds: [{ node: 'leaf2', amount: 7 }] },
        { op: 'cancel', batch: 'bB' },
      ],
    },
  ],
  [
    { id: 'A', ops: [{ op: 'reserve', batch: 'bA', holds: [{ node: 'leaf1', amount: 25 }] }] },
    { id: 'B', ops: [{ op: 'reserve', batch: 'bB', holds: [{ node: 'leaf1', amount: 25 }] }] },
  ],
  [
    {
      id: 'A',
      ops: [
        { op: 'reserve', batch: 'bA', holds: [{ node: 'leaf1', amount: 25 }] },
        { op: 'cancel', batch: 'bA' },
      ],
    },
    { id: 'B', ops: [{ op: 'reserve', batch: 'bB', holds: [{ node: 'leaf1', amount: 25 }] }] },
  ],
  [
    { id: 'A', ops: [{ op: 'reserve', batch: 'bA', holds: [{ node: 'leaf1', amount: 25 }] }] },
    { id: 'B', ops: [{ op: 'reserve', batch: 'bB', holds: [{ node: 'leaf2', amount: 40 }] }] },
    { id: 'C', ops: [{ op: 'cancel', batch: 'bX' }] },
  ],
];

test('acceptance 4: depth-2 tree, <=4 steps, sequence-by-sequence cross-check with independent enumerator', () => {
  for (const [setIndex, actors] of actorSets.entries()) {
    const totalSteps = actors.reduce((sum, actor) => sum + actor.ops.length, 0);
    assert.ok(totalSteps <= 4, `set ${setIndex} must stay within 4 steps`);

    const librarySeqs = [...interleavings(actors)].map((trace) => trace.map((step) => step.actor));
    const items = actors.flatMap((actor) => actor.ops.map(() => actor.id));
    const independentSeqs = multisetPermutations(items);
    assert.deepEqual(librarySeqs, independentSeqs, `set ${setIndex}: enumerator mismatch`);

    for (const trace of interleavings(actors)) {
      const tree = new BudgetTree(depth2Spec);
      const outcomes = [];
      for (const { op } of trace) {
        try {
          applyOp(tree, op);
          outcomes.push('ok');
        } catch (err) {
          outcomes.push(err.code);
        }
        assert.equal(tree.verifyInvariants(), null, `set ${setIndex} invariant after ${op.op}`);
      }
      const model = replayModel(depth2Spec.nodes, trace);
      assert.deepEqual(outcomes, model.events, `set ${setIndex} outcomes for ${trace.map((s) => s.actor).join(',')}`);
      const snapshot = tree.snapshot();
      for (const id of Object.keys(snapshot.nodes)) {
        assert.equal(snapshot.nodes[id].held, model.held.get(id), `set ${setIndex} held of ${id}`);
        assert.equal(snapshot.nodes[id].used, model.used.get(id), `set ${setIndex} used of ${id}`);
      }
    }
  }
});
test('explore certifies the example workload as safe', () => {
  const treeSpec = require('../examples/tree.json');
  const { actors } = require('../examples/actors.json');
  const certificate = explore(treeSpec, actors);
  assert.equal(certificate.status, 'SAFE');
  assert.equal(certificate.interleavings, 30);
  assert.equal(certificate.stepsExecuted, 30 * 5);
  assert.deepEqual(certificate.rejectionsSeen, ['INVALID_BATCH']);
  assert.match(certificate.certificateHash, /^[0-9a-f]{64}$/);
  console.log(`certificate: ${JSON.stringify(certificate)}`);
});

test('explore returns the lexicographically smallest counterexample with ancestor chain and state hash', () => {
  const spec = {
    nodes: [
      { id: 'root', parent: null, limit: 100 },
      { id: 'mid', parent: 'root', limit: 60 },
      { id: 'leaf', parent: 'mid', limit: 30 },
    ],
  };
  const actors = [
    { id: 'A', ops: [{ op: 'reserve', batch: 'bA', holds: [{ node: 'leaf', amount: 10 }] }] },
    { id: 'B', ops: [{ op: 'reserve', batch: 'bB', holds: [{ node: 'leaf', amount: 10 }] }] },
  ];
  const check = (tree) => {
    const subtree = tree.read('mid').subtree;
    return subtree.held > 15 ? { kind: 'TEST_THRESHOLD', node: 'mid' } : null;
  };
  const result = explore(spec, actors, { check });
  assert.equal(result.status, 'VIOLATION');
  assert.deepEqual(
    result.counterexample.trace.map((step) => step.actor),
    ['A', 'B'],
  );
  assert.deepEqual(
    result.counterexample.ancestorChain.map((entry) => entry.node),
    ['mid', 'root'],
  );
  assert.deepEqual(result.counterexample.ancestorChain[0].subtree, { held: 20, used: 0 });

  const replayed = new BudgetTree(spec);
  replayed.reserve('bA', [{ node: 'leaf', amount: 10 }]);
  replayed.reserve('bB', [{ node: 'leaf', amount: 10 }]);
  assert.equal(result.counterexample.stateHash, replayed.stateHash());

  const allTraces = [...interleavings(actors)];
  const violating = allTraces.filter((trace) => {
    const tree = new BudgetTree(spec);
    for (const { op } of trace) applyOp(tree, op);
    return tree.read('mid').subtree.held > 15;
  });
  assert.ok(violating.length > 0);
  const lexMin = violating.map((trace) => trace.map((step) => step.actor).join(',')).sort()[0];
  assert.equal(result.counterexample.trace.map((step) => step.actor).join(','), lexMin);
});

function runCli(args) {
  const { main } = require('../src/cli');
  const io = {
    stdout: { buffer: '', write(chunk) { this.buffer += chunk; } },
    stderr: { buffer: '', write(chunk) { this.buffer += chunk; } },
  };
  const status = main(args, io);
  return { status, stdout: io.stdout.buffer, stderr: io.stderr.buffer };
}

test('CLI prints the safety certificate and exits 0', () => {
  const run = runCli(['examples/tree.json', 'examples/actors.json']);
  assert.equal(run.status, 0, run.stderr);
  const certificate = JSON.parse(run.stdout);
  assert.equal(certificate.status, 'SAFE');
  assert.equal(certificate.interleavings, 30);
  assert.match(certificate.certificateHash, /^[0-9a-f]{64}$/);
});

test('CLI rejects a cyclic tree with INVALID_TREE and exit code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'explree-'));
  const badTree = join(dir, 'tree.json');
  writeFileSync(
    badTree,
    JSON.stringify({
      nodes: [
        { id: 'root', parent: null, limit: 10 },
        { id: 'x', parent: 'y', limit: 5 },
        { id: 'y', parent: 'x', limit: 5 },
      ],
    }),
  );
  const run = runCli([badTree, 'examples/actors.json']);
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stderr).code, 'INVALID_TREE');
});

test('CLI without arguments prints usage and exits 2', () => {
  const run = runCli([]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: explree/);
});
