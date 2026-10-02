import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initState, applyTransaction, topoSort } from '../src/engine.js';
import { computeResultHash, canonicalize } from '../src/canonical.js';

// ---------- deterministic PRNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- independent reference: clear everything, recompute full graph ----------
function referenceFullRecompute(tasks, previousHashes) {
  const ids = Object.keys(tasks);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const d of new Set(tasks[id].deps)) {
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(d).push(id);
    }
  }
  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift();
    order.push(id);
    for (const dep of dependents.get(id)) {
      indegree.set(dep, indegree.get(dep) - 1);
      if (indegree.get(dep) === 0) ready.push(dep);
    }
  }
  assert.equal(order.length, ids.length, 'reference expects a DAG');
  const hashes = {};
  for (const id of order) {
    const deps = [...new Set(tasks[id].deps)].sort();
    hashes[id] = computeResultHash(tasks[id], deps.map((d) => [d, hashes[d]]));
  }
  const changed = new Set(
    ids.filter((id) => previousHashes[id] !== hashes[id]),
  );
  return { hashes, changed };
}

// ---------- independent invalidation-closure computation ----------
function referenceClosure(before, after) {
  const direct = new Set();
  for (const id of Object.keys(after)) {
    const spec = (t) => JSON.stringify([t.input, t.version, [...new Set(t.deps)].sort()]);
    if (spec(before[id]) !== spec(after[id])) direct.add(id);
  }
  const dependents = new Map();
  for (const [id, t] of Object.entries(after)) {
    for (const d of new Set(t.deps)) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(id);
    }
  }
  const closure = new Set(direct);
  const stack = [...direct];
  while (stack.length > 0) {
    const id = stack.pop();
    for (const dep of dependents.get(id) ?? []) {
      if (!closure.has(dep)) {
        closure.add(dep);
        stack.push(dep);
      }
    }
  }
  return closure;
}

function applyTxToDefs(tasks, tx) {
  const out = {};
  for (const [id, t] of Object.entries(tasks)) {
    out[id] = { input: t.input, version: t.version, deps: [...t.deps] };
  }
  for (const [id, v] of Object.entries(tx.setInput ?? {})) out[id].input = v;
  for (const [id, v] of Object.entries(tx.setVersion ?? {})) out[id].version = v;
  for (const [id, adds] of Object.entries(tx.addDeps ?? {})) {
    out[id].deps = [...new Set([...out[id].deps, ...adds])].sort();
  }
  for (const [id, removes] of Object.entries(tx.removeDeps ?? {})) {
    const drop = new Set(removes);
    out[id].deps = out[id].deps.filter((d) => !drop.has(d));
  }
  return out;
}

function randomGraph(rand, n) {
  const tasks = {};
  for (let i = 0; i < n; i++) {
    const id = 't' + i;
    const deps = [];
    for (let j = 0; j < i; j++) {
      if (rand() < 0.35) deps.push('t' + j);
    }
    tasks[id] = {
      input: 'in-' + Math.floor(rand() * 4),
      version: 'v' + Math.floor(rand() * 3),
      deps,
    };
  }
  return tasks;
}

function randomTransaction(rand, tasks) {
  const ids = Object.keys(tasks);
  const tx = {};
  const pick = () => ids[Math.floor(rand() * ids.length)];
  if (rand() < 0.7) {
    tx.setInput = { [pick()]: 'in-' + Math.floor(rand() * 5) };
  }
  if (rand() < 0.7) {
    tx.setVersion = { [pick()]: 'v' + Math.floor(rand() * 4) };
  }
  if (rand() < 0.5) {
    const id = pick();
    const idx = Number(id.slice(1));
    const candidates = ids.filter((x) => Number(x.slice(1)) < idx);
    if (candidates.length > 0) {
      tx.addDeps = { [id]: [candidates[Math.floor(rand() * candidates.length)]] };
    }
  }
  if (rand() < 0.5) {
    const id = pick();
    if (tasks[id].deps.length > 0) {
      tx.removeDeps = { [id]: [tasks[id].deps[Math.floor(rand() * tasks[id].deps.length)]] };
    }
  }
  return tx;
}

// ---------- acceptance 1: enumeration vs full-clear-recompute reference ----------
test('random graphs (<=9 tasks): incremental matches full recompute reference', () => {
  const rand = mulberry32(20261003);
  const CASES = 300;
  for (let c = 0; c < CASES; c++) {
    const n = 1 + Math.floor(rand() * 9); // 1..9 tasks
    const defs = randomGraph(rand, n);
    const init = initState(defs);
    assert.ok(init.ok, `init failed in case ${c}`);

    const tx = randomTransaction(rand, defs);
    const beforeHashes = { ...init.state.hashes };
    const beforeTasks = JSON.parse(JSON.stringify(init.state.tasks));

    const result = applyTransaction(init.state, tx, {});
    assert.ok(result.ok, `transaction failed in case ${c}: ${JSON.stringify(result)}`);

    // Reference: clear the whole graph and recompute from scratch.
    const newDefs = applyTxToDefs(beforeTasks, tx);
    const ref = referenceFullRecompute(newDefs, beforeHashes);

    // 1) final hashes identical
    assert.deepEqual(result.hashes, ref.hashes, `hash mismatch in case ${c}`);
    // 2) changed-hash set identical
    assert.deepEqual(
      new Set(Object.keys(result.diff)),
      ref.changed,
      `diff-set mismatch in case ${c}`,
    );
    // 3) recomputed set equals the invalidation closure
    const closure = referenceClosure(beforeTasks, newDefs);
    assert.deepEqual(
      new Set(result.recomputed),
      closure,
      `invalidation-set mismatch in case ${c}`,
    );
    // 4) recompute order is a valid topological order, id-ascending per layer
    const pos = new Map(result.recomputed.map((id, i) => [id, i]));
    for (const id of result.recomputed) {
      for (const d of newDefs[id].deps) {
        if (pos.has(d)) assert.ok(pos.get(d) < pos.get(id), `order violation in case ${c}`);
      }
    }
    // 5) diff entries carry real old/new hashes
    for (const [id, d] of Object.entries(result.diff)) {
      assert.equal(d.from, beforeHashes[id]);
      assert.equal(d.to, result.hashes[id]);
      assert.notEqual(d.from, d.to);
    }
  }
});

test('no-change transaction yields empty recompute and empty diff', () => {
  const init = initState({
    a: { input: 'x', version: 'v1', deps: [] },
    b: { input: 'y', version: 'v1', deps: ['a'] },
  });
  assert.ok(init.ok);
  const before = JSON.parse(JSON.stringify(init.state));
  const result = applyTransaction(init.state, {}, {});
  assert.deepEqual(result, {
    ok: true,
    recomputed: [],
    diff: {},
    stopPoints: [],
    hashes: before.hashes,
  });
  assert.deepEqual(init.state, before);
  // A transaction that re-sets identical values is also a no-change transaction.
  const again = applyTransaction(init.state, { setInput: { a: 'x' }, setVersion: { b: 'v1' } }, {});
  assert.equal(again.ok, true);
  assert.deepEqual(again.recomputed, []);
  assert.deepEqual(again.diff, {});
});

// ---------- acceptance 2: diamond merge recomputed once, fixed parallel order ----------
test('version bump on diamond root: merge task recomputed once, order fixed', () => {
  const init = initState({
    a: { input: 'i', version: 'v1', deps: [] },
    b: { input: 'i', version: 'v1', deps: ['a'] },
    c: { input: 'i', version: 'v1', deps: ['a'] },
    d: { input: 'i', version: 'v1', deps: ['b', 'c'] },
  });
  assert.ok(init.ok);
  const result = applyTransaction(init.state, { setVersion: { a: 'v2' } }, {});
  assert.ok(result.ok);
  // layered topo order, id ascending within a layer
  assert.deepEqual(result.recomputed, ['a', 'b', 'c', 'd']);
  // merge point d appears exactly once
  assert.equal(result.recomputed.filter((x) => x === 'd').length, 1);
  // every task hash changed exactly once, stop point is the merge task
  assert.deepEqual(Object.keys(result.diff).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.stopPoints, ['d']);
  // repeated run is deterministic
  const init2 = initState({
    a: { input: 'i', version: 'v1', deps: [] },
    b: { input: 'i', version: 'v1', deps: ['a'] },
    c: { input: 'i', version: 'v1', deps: ['a'] },
    d: { input: 'i', version: 'v1', deps: ['b', 'c'] },
  });
  const again = applyTransaction(init2.state, { setVersion: { a: 'v2' } }, {});
  assert.deepEqual(again, result);
});

test('multi-branch merge: single recompute at join, deterministic order', () => {
  const init = initState({
    root: { input: 'i', version: 'm1', deps: [] },
    b1: { input: 'i', version: 'm1', deps: ['root'] },
    b2: { input: 'i', version: 'm1', deps: ['root'] },
    b3: { input: 'i', version: 'm1', deps: ['root'] },
    join: { input: 'i', version: 'm1', deps: ['b1', 'b2', 'b3'] },
    sink: { input: 'i', version: 'm1', deps: ['join'] },
  });
  assert.ok(init.ok);
  const result = applyTransaction(init.state, { setVersion: { root: 'm2' } }, {});
  assert.ok(result.ok);
  assert.deepEqual(result.recomputed, ['root', 'b1', 'b2', 'b3', 'join', 'sink']);
  assert.equal(result.recomputed.filter((x) => x === 'join').length, 1);
  assert.deepEqual(result.stopPoints, ['sink']);
});

// ---------- acceptance 3: budget, cycle, self-loop, rollback ----------
test('over-budget transaction returns E_BUDGET and rolls back', () => {
  const init = initState({
    a: { input: 'i', version: 'v1', deps: [] },
    b: { input: 'i', version: 'v1', deps: ['a'] },
    c: { input: 'i', version: 'v1', deps: ['b'] },
  });
  assert.ok(init.ok);
  const before = JSON.parse(JSON.stringify(init.state));
  const result = applyTransaction(init.state, { setInput: { a: 'changed' } }, { maxRecompute: 2 });
  assert.deepEqual(result, { ok: false, error: 'E_BUDGET', needed: 3, budget: 2 });
  // full rollback: state untouched
  assert.deepEqual(init.state, before);
  // exact budget succeeds
  const ok = applyTransaction(init.state, { setInput: { a: 'changed' } }, { maxRecompute: 3 });
  assert.ok(ok.ok);
  assert.deepEqual(ok.recomputed, ['a', 'b', 'c']);
});

test('cycle introduced by addDeps returns E_CYCLE and rolls back', () => {
  const init = initState({
    a: { input: 'i', version: 'v1', deps: [] },
    b: { input: 'i', version: 'v1', deps: ['a'] },
    c: { input: 'i', version: 'v1', deps: ['b'] },
  });
  assert.ok(init.ok);
  const before = JSON.parse(JSON.stringify(init.state));
  const result = applyTransaction(init.state, { addDeps: { a: ['c'] } }, {});
  assert.deepEqual(result, { ok: false, error: 'E_CYCLE' });
  assert.deepEqual(init.state, before);
});

test('self-loop returns E_CYCLE and rolls back', () => {
  const init = initState({
    a: { input: 'i', version: 'v1', deps: [] },
  });
  assert.ok(init.ok);
  const before = JSON.parse(JSON.stringify(init.state));
  const result = applyTransaction(init.state, { addDeps: { a: ['a'] } }, {});
  assert.deepEqual(result, { ok: false, error: 'E_CYCLE' });
  assert.deepEqual(init.state, before);
  // self-loop already present at init
  const bad = initState({ a: { input: 'i', version: 'v1', deps: ['a'] } });
  assert.deepEqual(bad, { ok: false, error: 'E_CYCLE' });
});

test('unknown task and unknown dependency are rejected without mutation', () => {
  const init = initState({ a: { input: 'i', version: 'v1', deps: [] } });
  assert.ok(init.ok);
  const before = JSON.parse(JSON.stringify(init.state));
  const r1 = applyTransaction(init.state, { setInput: { ghost: 'x' } }, {});
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'E_UNKNOWN_TASK');
  const r2 = applyTransaction(init.state, { addDeps: { a: ['ghost'] } }, {});
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'E_UNKNOWN_TASK');
  assert.deepEqual(init.state, before);
});

test('combined transaction: version swap + dep add/remove + param fix in one shot', () => {
  const init = initState({
    a: { input: 'i', version: 'v1', deps: [] },
    b: { input: 'i', version: 'v1', deps: ['a'] },
    c: { input: 'i', version: 'v1', deps: ['b'] },
    d: { input: 'i', version: 'v1', deps: ['a'] },
  });
  assert.ok(init.ok);
  const result = applyTransaction(
    init.state,
    {
      setVersion: { a: 'v2' },
      setInput: { d: 'fixed' },
      addDeps: { c: ['d'] },
      removeDeps: { c: ['b'] },
    },
    {},
  );
  assert.ok(result.ok);
  assert.deepEqual(result.recomputed, ['a', 'b', 'd', 'c']);
  assert.deepEqual(result.stopPoints, ['b', 'c']);
  // c no longer depends on b, so a later change to b must not reach c
  const r2 = applyTransaction(init.state, { setInput: { b: 'again' } }, {});
  assert.ok(r2.ok);
  assert.deepEqual(r2.recomputed, ['b']);
});

test('canonical JSON serialization is stable', () => {
  assert.equal(
    canonicalize({ b: 1, a: [2, { d: null, c: 'x' }] }),
    '{"a":[2,{"c":"x","d":null}],"b":1}',
  );
  const h1 = computeResultHash({ input: 'i', version: 'v' }, [['b', 'hb'], ['a', 'ha']]);
  const h2 = computeResultHash({ input: 'i', version: 'v' }, [['a', 'ha'], ['b', 'hb']]);
  assert.equal(h1, h2, 'dep order must not affect the hash');
});

test('topoSort returns null on cycle and layered order otherwise', () => {
  assert.equal(topoSort({ a: { deps: ['b'] }, b: { deps: ['a'] } }), null);
  const order = topoSort({
    d: { deps: ['b', 'c'] },
    b: { deps: ['a'] },
    c: { deps: ['a'] },
    a: { deps: [] },
  });
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});
