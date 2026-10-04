import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commit } from '../src/commit.js';
import { lincheck } from '../src/lincheck.js';
import { HbGraph } from '../src/hb.js';
import { applyOps } from '../src/model.js';
import { tmpRepo, batch, assertOp } from './helpers.js';
import { canonical } from '../src/util.js';

// Enumerate every topological order of the constraint graph (HB + real-time).
function* allTopoOrders(ids, edges) {
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const tos of edges.values()) for (const t of tos) indeg.set(t, indeg.get(t) + 1);
  const avail = ids.filter((id) => indeg.get(id) === 0);
  function* rec(prefix, avail) {
    if (prefix.length === ids.length) { yield prefix; return; }
    for (let i = 0; i < avail.length; i++) {
      const x = avail[i];
      const next = avail.slice(0, i).concat(avail.slice(i + 1));
      for (const t of edges.get(x) ?? []) {
        indeg.set(t, indeg.get(t) - 1);
        if (indeg.get(t) === 0) next.push(t);
      }
      yield* rec([...prefix, x], next);
      for (const t of edges.get(x) ?? []) indeg.set(t, indeg.get(t) + 1);
    }
  }
  yield* rec([], avail);
}

function constraintEdges(repo, ids, log) {
  const hb = new HbGraph(ids.map((id) => repo.getBatch(id)));
  const edges = new Map(ids.map((id) => [id, new Set()]));
  for (const [a, b] of hb.edges()) edges.get(a).add(b);
  const at = new Map(log.map((e) => [e.batch, e]));
  for (const a of ids) for (const b of ids) {
    if (a !== b && at.get(a).end <= at.get(b).start) edges.get(a).add(b);
  }
  return edges;
}

// Real-time log consistent with HB: interval [2*depth, 2*depth+1], so
// concurrent batches (same HB depth) overlap and stay unordered.
function depthLog(repo, ids) {
  const hb = new HbGraph(ids.map((id) => repo.getBatch(id)));
  const memo = new Map();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    const anc = hb.ancestors(id);
    let d = 0;
    for (const a of anc) d = Math.max(d, depth(a) + 1);
    memo.set(id, d);
    return d;
  };
  return ids.map((id) => ({ batch: id, start: depth(id) * 2, end: depth(id) * 2 + 1 }));
}

const replay = (repo, order) => {
  let s = {};
  for (const id of order) s = applyOps(s, repo.getBatch(id).ops);
  return s;
};

// Acceptance 2: acyclic histories, cross-checked against serial enumeration
// of all topological orders.
test('lincheck witness is one of the enumerated serial orders (random DAGs)', () => {
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 5; trial++) {
    const { repo } = tmpRepo();
    const n = 8;
    // genesis commit; every scenario batch forks from the version(s) it
    // logically depends on, so the version DAG mirrors the intended HB DAG
    const root = commit(repo, batch('root', 'p0', 0, [assertOp('root', 0)]));
    const ids = [];
    const versionOf = new Map();
    for (let i = 0; i < n; i++) {
      const id = `b${i}`;
      const deps = ids.filter(() => rand() < 0.3);
      const parents = deps.length ? deps.map((d) => versionOf.get(d)) : [root.version];
      const r = commit(repo, batch(id, `p${i % 3}`, 1 + Math.floor(i / 3), [assertOp(`k${i}`, i)], { deps, parents }));
      versionOf.set(id, r.version);
      ids.push(id);
    }
    const log = depthLog(repo, ids);
    const res = lincheck(repo, log);
    assert.equal(res.ok, true);

    const edges = constraintEdges(repo, ids, log);
    const orders = [...allTopoOrders(ids, edges)];
    assert.ok(orders.length > 0);
    // witness must be a member of the enumerated serial orders
    assert.ok(
      orders.some((o) => o.join() === res.order.join()),
      `witness not a valid topo order (trial ${trial})`,
    );
    // and its serial replay must be a member of the enumerated outcomes
    const outcomes = new Set(orders.map((o) => canonical(replay(repo, o))));
    assert.ok(outcomes.has(canonical(replay(repo, res.order))));
  }
});

test('100 events, acyclic: full enumeration cross-check', () => {
  const { repo } = tmpRepo();
  // 7 diamonds (2 topo orders each) + 72 chain events = 100 events, 128 orders
  const ids = [];
  const versionOf = new Map();
  let prev = null;
  const add = (id, deps) => {
    const parents = deps.map((d) => versionOf.get(d));
    const r = commit(
      repo,
      batch(id, 'p' + (ids.length % 4), ids.length + 1, [assertOp(`k${ids.length}`, ids.length)], { deps, parents }),
    );
    versionOf.set(id, r.version);
    ids.push(id);
  };
  for (let d = 0; d < 7; d++) {
    const a = `d${d}a`, b = `d${d}b`, c = `d${d}c`, e = `d${d}e`;
    add(a, prev ? [prev] : []);
    add(b, [a]);
    add(c, [a]);
    add(e, [b, c]);
    prev = e;
  }
  for (let i = 0; i < 72; i++) {
    add(`t${i}`, [prev]);
    prev = `t${i}`;
  }
  assert.equal(ids.length, 100);

  const log = depthLog(repo, ids);
  const res = lincheck(repo, log);
  assert.equal(res.ok, true);
  assert.equal(res.order.length, 100);

  const edges = constraintEdges(repo, ids, log);
  const orders = [...allTopoOrders(ids, edges)];
  assert.equal(orders.length, 128); // 2^7 diamond orders
  assert.ok(orders.some((o) => o.join() === res.order.join()));
  // disjoint keys => every serial order yields the same materialized state,
  // which must also equal the repository's head state
  const outcomes = new Set(orders.map((o) => canonical(replay(repo, o))));
  assert.equal(outcomes.size, 1);
  assert.ok(outcomes.has(canonical(replay(repo, res.order))));
  // the materialized state at the final chain version equals the serial outcome
  const last = repo.getVersion('main', versionOf.get('t71'));
  assert.ok(outcomes.has(canonical(last.state)));
});

test('real-time inversion of a dependency is E_NONLINEAR', () => {
  const { repo } = tmpRepo();
  commit(repo, batch('b1', 'p1', 1, [assertOp('k', 1)]));
  commit(repo, batch('b2', 'p2', 1, [assertOp('k', 2)], { deps: ['b1'] }));
  // log claims b2 finished before b1 started, but HB says b1 -> b2
  const log = [
    { batch: 'b1', start: 10, end: 20 },
    { batch: 'b2', start: 0, end: 5 },
  ];
  assert.throws(() => lincheck(repo, log), (e) => e.code === 'E_NONLINEAR');
  // brute force agrees: no topological order exists for the combined graph
  const edges = constraintEdges(repo, ['b1', 'b2'], log);
  assert.equal([...allTopoOrders(['b1', 'b2'], edges)].length, 0);
});

test('certificate tampering is detected as E_NONLINEAR', () => {
  const { repo } = tmpRepo();
  const r = commit(repo, batch('b1', 'p1', 1, [assertOp('k', 1)]));
  const v = repo.getVersion('main', r.version);
  v.state.k.value = 999; // corrupt the certificate
  repo.saveVersion(v);
  assert.throws(
    () => lincheck(repo, [{ batch: 'b1', start: 0, end: 1 }]),
    (e) => e.code === 'E_NONLINEAR',
  );
});
