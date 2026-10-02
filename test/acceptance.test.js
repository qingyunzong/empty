import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, FAULTS } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-acc-'));
}

// Acceptance 1: hierarchical revoke degrades three derivation levels.
test('A1: revoking a source degrades a three-level derivation chain', () => {
  const store = Store.open(tmpdir());
  store.commit('add_fact', { id: 'f', source: 'srcA', value: 1 });
  store.commit('add_rule', { id: 'level1', op: 'count', premises: ['f'], threshold: 1 });
  store.commit('add_rule', { id: 'level2', op: 'count', premises: ['level1'], threshold: 1 });
  store.commit('add_rule', { id: 'level3', op: 'count', premises: ['level2'], threshold: 1 });
  assert.equal(store.graph.status('level3').state, 'valid');

  store.commit('revoke_source', { source: 'srcA' });
  assert.equal(store.graph.status('f').state, 'degraded');
  assert.equal(store.graph.status('level1').state, 'degraded');
  assert.equal(store.graph.status('level2').state, 'degraded');
  assert.equal(store.graph.status('level3').state, 'degraded');

  store.commit('restore_source', { source: 'srcA' });
  assert.equal(store.graph.status('level1').state, 'valid');
  assert.equal(store.graph.status('level2').state, 'valid');
  assert.equal(store.graph.status('level3').state, 'valid');
});

// Acceptance 2: restore must not resurrect a fact deleted after the revoke.
test('A2: restore does not resurrect a subsequently removed fact', () => {
  const store = Store.open(tmpdir());
  store.commit('add_fact', { id: 'f', source: 'srcB' });
  store.commit('add_rule', { id: 'r', op: 'count', premises: ['f'], threshold: 1 });
  store.commit('revoke_source', { source: 'srcB' });
  store.commit('remove_fact', { id: 'f' });
  store.commit('restore_source', { source: 'srcB' });
  assert.equal(store.graph.status('f').state, 'removed');
  assert.equal(store.graph.status('r').state, 'degraded');

  // and the tombstone survives a restart (it is a WAL event, not runtime state)
  const reopened = Store.open(store.dir);
  assert.equal(reopened.graph.status('f').state, 'removed');
  assert.equal(reopened.graph.status('r').state, 'degraded');
});

// Acceptance 3: random graphs up to 100 nodes, compared against an
// independently written reference closure enumeration.
test('A3: 100-node random graphs match reference closure enumeration', () => {
  for (const seed of [1, 7, 42, 1337, 20261003]) {
    const { events, nodeIds } = generateScenario(seed, 100);
    const store = Store.open(tmpdir());
    for (const [type, payload] of events) store.commit(type, payload);
    const reference = referenceMaterialize(events);
    const actual = store.graph.materialize();
    for (const id of nodeIds) {
      assert.deepEqual(actual[id], reference[id], `seed ${seed} node ${id}`);
    }
  }
});

// Acceptance 4: crash injection at the three defined fault points recovers
// to one deterministic state.
test('A4: fault injection at all three points recovers deterministically', () => {
  const results = [];
  for (const point of [null, FAULTS.AFTER_APPEND, FAULTS.BEFORE_INDEX, FAULTS.AFTER_SNAPSHOT]) {
    const dir = tmpdir();
    let store = Store.open(dir);
    store.commit('add_fact', { id: 'f1', source: 's1', value: 2 });
    store.commit('add_fact', { id: 'f2', source: 's2', value: 5 });
    if (point) store = Store.open(dir, { faultAt: point });
    try {
      store.commit('add_rule', { id: 'r1', op: 'sum', premises: ['f1', 'f2'], threshold: 6 });
      store.commit('revoke_source', { source: 's1' });
      store.snapshot();
      store.commit('restore_source', { source: 's1' });
    } catch (e) {
      assert.equal(e.code, 'E_CRASH');
      // restart and finish the identical logical workload
      store = Store.open(dir);
      // Redo only the logical steps that did not survive the crash.
      if (!store.graph.has('r1')) store.commit('add_rule', { id: 'r1', op: 'sum', premises: ['f1', 'f2'], threshold: 6 });
      if (!store.graph.sources.get('s1').revoked) store.commit('revoke_source', { source: 's1' });
      store.snapshot();
      store.commit('restore_source', { source: 's1' });
    }
    const final = Store.open(dir);
    results.push({
      nodes: final.graph.materialize(),
      status: final.graph.status('r1'),
      lastSeq: final.lastSeq,
      headHash: final.headHash,
      verify: Store.verify(dir).ok,
    });
  }
  for (let i = 1; i < results.length; i++) {
    assert.deepEqual(results[i], results[0], `fault point variant ${i} diverges`);
  }
  assert.equal(results[0].status.state, 'valid');
  assert.equal(results[0].verify, true);
});

// --- helpers ---

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateScenario(seed, nodeCount) {
  const rand = mulberry32(seed);
  const events = [];
  const nodeIds = [];
  const sources = ['s1', 's2', 's3', 's4'];
  let factCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (i < 4 || rand() < 0.45 || nodeIds.length === 0) {
      const id = `f${factCount++}`;
      events.push(['add_fact', { id, source: sources[Math.floor(rand() * sources.length)], value: 1 + Math.floor(rand() * 5) }]);
      nodeIds.push(id);
    } else {
      const id = `r${i}`;
      const arity = 1 + Math.floor(rand() * 3);
      const premises = [];
      for (let k = 0; k < arity; k++) premises.push(nodeIds[Math.floor(rand() * nodeIds.length)]);
      const op = rand() < 0.5 ? 'count' : 'sum';
      const threshold = op === 'count' ? 1 + Math.floor(rand() * arity) : 1 + Math.floor(rand() * 8);
      events.push(['add_rule', { id, op, premises, threshold }]);
      nodeIds.push(id);
    }
  }
  // random revoke/restore/remove traffic
  for (const source of sources) {
    if (rand() < 0.7) events.push(['revoke_source', { source }]);
    if (rand() < 0.5) events.push(['restore_source', { source }]);
  }
  const removable = nodeIds.filter((id) => id.startsWith('f'));
  for (let i = 0; i < 3 && removable.length > 0; i++) {
    events.push(['remove_fact', { id: removable[Math.floor(rand() * removable.length)] }]);
  }
  return { events, nodeIds };
}

// Reference implementation: independent closure enumeration.
// Computes fixpoint states with Kahn-style topological evaluation, written
// separately from src/graph.js on purpose.
function referenceMaterialize(events) {
  const facts = new Map();
  const rules = new Map();
  const revokedSources = new Set();
  for (const [type, p] of events) {
    if (type === 'add_fact') facts.set(p.id, { source: p.source, value: p.value ?? 1, removed: false });
    else if (type === 'add_rule') rules.set(p.id, { op: p.op, premises: [...new Set(p.premises)], threshold: p.threshold ?? (p.op === 'count' ? new Set(p.premises).size : 1) });
    else if (type === 'remove_fact') facts.get(p.id).removed = true;
    else if (type === 'revoke_source') revokedSources.add(p.source);
    else if (type === 'restore_source') revokedSources.delete(p.source);
  }
  // Kahn topological order over rules (premise -> dependent)
  const indegree = new Map();
  const dependents = new Map();
  for (const [id, rule] of rules) {
    indegree.set(id, 0);
    for (const pre of rule.premises) {
      if (rules.has(pre)) {
        indegree.set(id, indegree.get(id) + 1);
        if (!dependents.has(pre)) dependents.set(pre, []);
        dependents.get(pre).push(id);
      }
    }
  }
  const queue = [...rules.keys()].filter((id) => indegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const dep of dependents.get(id) || []) {
      indegree.set(dep, indegree.get(dep) - 1);
      if (indegree.get(dep) === 0) queue.push(dep);
    }
  }
  assert.equal(order.length, rules.size, 'reference: cycle slipped into scenario');

  const states = new Map(); // id -> { state, support }
  const factState = (id) => {
    const f = facts.get(id);
    if (!f) return { state: 'unknown', support: 0 };
    if (f.removed) return { state: 'removed', support: 0 };
    return revokedSources.has(f.source) ? { state: 'degraded', support: 0 } : { state: 'valid', support: f.value };
  };
  for (const id of facts.keys()) states.set(id, factState(id));
  for (const id of order) {
    const rule = rules.get(id);
    const pres = rule.premises.map((p) => states.get(p) ?? { state: 'unknown', support: 0 });
    const valid = pres.filter((p) => p.state === 'valid');
    const support = rule.op === 'count' ? valid.length : valid.reduce((a, p) => a + p.support, 0);
    let state;
    if (support >= rule.threshold) state = 'valid';
    else if (pres.some((p) => p.state === 'unknown')) state = 'unknown';
    else state = 'degraded';
    states.set(id, { state, support });
  }
  const out = {};
  for (const [id, s] of states) out[id] = { state: s.state, support: s.support };
  return out;
}
