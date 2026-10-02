'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dag = require('../src/dag.js');

// Deterministic PRNG (LCG) so the randomized suites are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Build a random DAG with n nodes: ids n0..n(n-1) in topological order,
// each node draws 0..3 inputs from earlier ids.
function randomDag(n, rand) {
  const state = dag.createState();
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const id = `n${i}`;
    const k = Math.floor(rand() * 4);
    const inputs = [];
    for (let j = 0; j < k && ids.length; j += 1) {
      const pick = ids[Math.floor(rand() * ids.length)];
      if (!inputs.includes(pick)) inputs.push(pick);
    }
    dag.addNode(state, { id, codeVersion: `v${Math.floor(rand() * 3)}`, inputs, params: { seed: i } });
    ids.push(id);
  }
  return { state, ids };
}

// Reference: descendants via plain topological enumeration over the edge list.
function referenceDescendants(state, id) {
  const result = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.values(state.nodes)) {
      if (!result.has(node.id) && node.inputs.some((i) => result.has(i))) {
        result.add(node.id);
        changed = true;
      }
    }
  }
  result.delete(id);
  return [...result].sort();
}

function validIds(state) {
  return Object.entries(state.cache).filter(([, e]) => e.valid).map(([k]) => k).sort();
}

test('random DAGs (<=20 nodes): invalidation set matches topological reference', () => {
  for (let trial = 0; trial < 50; trial += 1) {
    const rand = lcg(1000 + trial);
    const n = 1 + Math.floor(rand() * 20);
    const { state, ids } = randomDag(n, rand);
    dag.runAll(state);
    for (const id of ids) {
      const got = dag.invalidate(state, id);
      const want = [id, ...referenceDescendants(state, id)].sort();
      assert.deepEqual(got, want, `trial ${trial} node ${id}`);
      dag.runAll(state); // restore for the next node
    }
  }
});

test('correcting a leaf never touches its siblings', () => {
  const state = dag.createState();
  dag.addNode(state, { id: 'root', codeVersion: '1' });
  dag.addNode(state, { id: 'left', codeVersion: '1', inputs: ['root'] });
  dag.addNode(state, { id: 'right', codeVersion: '1', inputs: ['root'] });
  dag.addNode(state, { id: 'leaf', codeVersion: '1', inputs: ['left'] });
  dag.runAll(state);
  const before = Object.fromEntries(Object.entries(state.cache).map(([k, v]) => [k, v.key]));

  // Correct the leaf: only the leaf is invalidated.
  const res = dag.addNode(state, { id: 'leaf', codeVersion: '2', inputs: ['left'] });
  assert.deepEqual(res.invalidated, ['leaf']);
  assert.equal(state.cache.left.valid, true);
  assert.equal(state.cache.right.valid, true);
  assert.equal(state.cache.root.valid, true);
  assert.equal(state.cache.leaf.valid, false);
  assert.equal(state.cache.leaf.tombstone, true);
  // Sibling keys are byte-identical after the correction.
  assert.equal(state.cache.left.key, before.left);
  assert.equal(state.cache.right.key, before.right);

  // Correcting 'left' invalidates left+leaf but never sibling 'right'.
  dag.runAll(state);
  const res2 = dag.addNode(state, { id: 'left', codeVersion: '2', inputs: ['root'] });
  assert.deepEqual(res2.invalidated, ['leaf', 'left']);
  assert.equal(state.cache.right.valid, true);
  assert.equal(state.cache.right.key, before.right);
});

test('cycle and missing input raise fixed error codes', () => {
  const state = dag.createState();
  assert.throws(() => dag.addNode(state, { id: 'a', inputs: ['ghost'] }), { code: 'MISSING_INPUT' });
  dag.addNode(state, { id: 'a' });
  dag.addNode(state, { id: 'b', inputs: ['a'] });
  assert.throws(() => dag.addNode(state, { id: 'a', inputs: ['b'] }), { code: 'CYCLE' });
  assert.throws(() => dag.addNode(state, { id: 'a', inputs: ['a'] }), { code: 'CYCLE' });
  assert.throws(() => dag.runNode(state, 'ghost'), { code: 'MISSING_INPUT' });
});

test('tampered evidence chain fails audit with BAD_CERT', () => {
  const state = dag.createState();
  dag.addNode(state, { id: 'a' });
  dag.addNode(state, { id: 'b', inputs: ['a'] });
  dag.runAll(state);
  assert.equal(dag.audit(state).ok, true);
  state.chain[0].outputHash = 'f'.repeat(64); // tamper
  assert.throws(() => dag.audit(state), { code: 'BAD_CERT' });
});

test('forged certificate reference fails audit with BAD_CERT', () => {
  const state = dag.createState();
  dag.addNode(state, { id: 'a' });
  dag.runAll(state);
  state.cache.a.certHash = '0'.repeat(64);
  assert.throws(() => dag.audit(state), { code: 'BAD_CERT' });
});

test('audit result is identical before and after gc', () => {
  for (let trial = 0; trial < 20; trial += 1) {
    const rand = lcg(7000 + trial);
    const n = 2 + Math.floor(rand() * 19);
    const { state, ids } = randomDag(n, rand);
    dag.runAll(state);
    // Tombstone a random interior cone, then re-run so live entries remain.
    dag.invalidate(state, ids[Math.floor(rand() * ids.length)]);
    dag.runAll(state);
    const before = dag.audit(state);
    const gcReport = dag.gc(state);
    const after = dag.audit(state);
    assert.deepEqual(after, before, `trial ${trial}`);
    // gc may only remove tombstoned entries unreachable from every runner.
    for (const nid of gcReport.removed) {
      assert.equal(state.cache[nid], undefined);
    }
    // Every still-valid entry survives gc.
    for (const nid of validIds(state)) {
      assert.ok(gcReport.reachable.includes(nid) || !gcReport.removed.includes(nid));
    }
  }
});

test('cache key binds code version, input hash and ancestor vector', () => {
  const state = dag.createState();
  dag.addNode(state, { id: 'a', codeVersion: '1', params: { x: 1 } });
  dag.addNode(state, { id: 'b', codeVersion: '1', inputs: ['a'] });
  dag.runAll(state);
  const keyA = state.cache.a.key;
  const keyB = state.cache.b.key;

  // Same definitions re-run: keys are stable (cache hit, nothing re-run).
  assert.deepEqual(dag.runAll(state), []);
  assert.equal(state.cache.a.key, keyA);

  // Bumping ancestor code version changes the descendant key too.
  dag.addNode(state, { id: 'a', codeVersion: '2', params: { x: 1 } });
  dag.runAll(state);
  assert.notEqual(state.cache.a.key, keyA);
  assert.notEqual(state.cache.b.key, keyB);

  // Changing only params (input hash) also re-keys.
  const keyA2 = state.cache.a.key;
  dag.addNode(state, { id: 'a', codeVersion: '2', params: { x: 2 } });
  dag.runAll(state);
  assert.notEqual(state.cache.a.key, keyA2);
});
