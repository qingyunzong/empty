'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../sync');
const { mulberry32 } = require('../gen');

// Build a random causally consistent event DAG of size n.
function randomDag(n, seed) {
  const rng = mulberry32(seed);
  const events = [];
  const posts = [];
  const voids = [];
  for (let i = 0; i < n; i++) {
    const u = rng();
    let e;
    if (u < 0.5 || posts.length === 0) {
      e = { id: `tx${i}`, kind: 'post', causes: [], lamport: i, node: 'T', amount: 10 + i };
      posts.push(e);
    } else if (u < 0.8 || voids.length === 0) {
      const t = posts[Math.floor(rng() * posts.length)];
      e = { id: `v${i}`, kind: 'void', causes: [t.id], lamport: i, node: 'T', target: t.id };
      voids.push(e);
    } else {
      const t = voids[Math.floor(rng() * voids.length)];
      e = { id: `r${i}`, kind: 'revive', causes: [t.id], lamport: i, node: 'T', target: t.id };
    }
    // extra random causal edges to earlier events keep the DAG constrained
    // enough that full enumeration of topological orders stays feasible.
    for (const prev of events) {
      if (rng() < 0.35 && !e.causes.includes(prev.id)) e.causes.push(prev.id);
    }
    events.push(e);
  }
  return events;
}

function buildPreds(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const preds = new Map(events.map((e) => [e, new Set()]));
  for (const e of events) {
    for (const c of e.causes) {
      const p = byId.get(c);
      if (p && p !== e) preds.get(e).add(p);
    }
  }
  return preds;
}

function* topoOrders(events, preds) {
  const indeg = new Map(events.map((e) => [e, preds.get(e).size]));
  const succs = new Map(events.map((e) => [e, []]));
  for (const [e, ps] of preds) for (const p of ps) succs.get(p).push(e);
  const order = [];
  function* rec() {
    if (order.length === events.length) {
      yield [...order];
      return;
    }
    for (const e of events) {
      if (indeg.get(e) !== 0) continue;
      indeg.set(e, -1);
      order.push(e);
      for (const s of succs.get(e)) indeg.set(s, indeg.get(s) - 1);
      yield* rec();
      for (const s of succs.get(e)) indeg.set(s, indeg.get(s) + 1);
      order.pop();
      indeg.set(e, 0);
    }
  }
  yield* rec();
}

// Independent reference: replay one explicit linear order, deciding voids and
// revives purely from causal visibility (ancestor relation), never from
// position in the order.
function referenceEffective(events, order, preds) {
  const anc = new Map();
  const ancestorsOf = (e) => {
    if (anc.has(e)) return anc.get(e);
    const acc = new Set();
    anc.set(e, acc);
    for (const p of preds.get(e)) {
      acc.add(p);
      for (const a of ancestorsOf(p)) acc.add(a);
    }
    return acc;
  };
  const postsById = new Map();
  for (const e of events) {
    if (e.kind !== 'post') continue;
    if (!postsById.has(e.id)) postsById.set(e.id, []);
    postsById.get(e.id).push(e);
  }
  const conflicted = new Set();
  for (const [id, ps] of postsById) {
    if (new Set(ps.map((p) => p.amount)).size > 1) conflicted.add(id);
  }
  const revived = new Set();
  const voids = [];
  for (const e of order) {
    if (e.kind === 'void') voids.push(e);
    if (e.kind === 'revive') {
      for (const v of events) {
        if (v.kind === 'void' && v.id === e.target && ancestorsOf(e).has(v)) revived.add(v);
      }
    }
  }
  const voided = new Set();
  for (const v of voids) {
    if (revived.has(v)) continue;
    const ps = postsById.get(v.target) || [];
    if (ps.some((p) => ancestorsOf(v).has(p))) voided.add(v.target);
  }
  const eff = [];
  for (const id of postsById.keys()) {
    if (!conflicted.has(id) && !voided.has(id)) eff.push(id);
  }
  return eff.sort();
}

// Acceptance 3: for n <= 10, enumerate ALL legal topological orders and
// confirm every one of them yields the same effective set as the library.
for (let n = 2; n <= 10; n++) {
  test(`all topological orders agree on the effective set (n=${n})`, () => {
    const events = randomDag(n, 1000 + n);
    const preds = buildPreds(events);
    const expected = evaluate(events).effective;
    let count = 0;
    for (const order of topoOrders(events, preds)) {
      count++;
      assert.ok(count <= 500000, 'enumeration cap exceeded; DAG too unconstrained');
      assert.deepEqual(
        referenceEffective(events, order, preds),
        expected,
        `order ${order.map((e) => e.id).join(',')} produced a different effective set`
      );
    }
    assert.ok(count > 0);
  });
}
