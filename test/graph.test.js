import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../src/graph.js';
import { EvidenceError } from '../src/errors.js';

function graphWith(events) {
  const g = new EvidenceGraph();
  for (const [type, payload] of events) {
    const ev = { type, payload };
    g.check(ev);
    g.apply(ev);
  }
  return g;
}

test('count aggregation: valid only when enough premises valid', () => {
  const g = graphWith([
    ['add_fact', { id: 'f1', source: 's1' }],
    ['add_fact', { id: 'f2', source: 's2' }],
    ['add_rule', { id: 'r', op: 'count', premises: ['f1', 'f2'], threshold: 2 }],
  ]);
  assert.equal(g.status('r').state, 'valid');
  g.apply({ type: 'revoke_source', payload: { source: 's1' } });
  const st = g.status('r');
  assert.equal(st.state, 'degraded');
  assert.equal(st.support, 1);
});

test('sum aggregation: sums values of valid premises', () => {
  const g = graphWith([
    ['add_fact', { id: 'f1', source: 's1', value: 2 }],
    ['add_fact', { id: 'f2', source: 's1', value: 3 }],
    ['add_rule', { id: 'r', op: 'sum', premises: ['f1', 'f2'], threshold: 5 }],
  ]);
  assert.equal(g.status('r').state, 'valid');
  assert.equal(g.status('r').support, 5);
  g.apply({ type: 'revoke_source', payload: { source: 's1' } });
  assert.equal(g.status('r').support, 0);
  assert.equal(g.status('r').state, 'degraded');
});

test('unknown: missing premise yields unknown, not degraded', () => {
  const g = graphWith([
    ['add_fact', { id: 'f1', source: 's1' }],
    ['add_rule', { id: 'r', op: 'count', premises: ['f1', 'ghost'], threshold: 2 }],
  ]);
  const st = g.status('r');
  assert.equal(st.state, 'unknown'); // undecided, never unsatisfiable
  // the unknown premise later appears and is revoked -> now decided negative
  g.check({ type: 'add_fact', payload: { id: 'ghost', source: 's2' } });
  g.apply({ type: 'add_fact', payload: { id: 'ghost', source: 's2' } });
  g.apply({ type: 'revoke_source', payload: { source: 's2' } });
  assert.equal(g.status('r').state, 'degraded');
});

test('unknown premise can still become valid and flip the node', () => {
  const g = graphWith([
    ['add_rule', { id: 'r', op: 'count', premises: ['a', 'b'], threshold: 2 }],
  ]);
  assert.equal(g.status('r').state, 'unknown');
  for (const id of ['a', 'b']) {
    g.check({ type: 'add_fact', payload: { id, source: 's' } });
    g.apply({ type: 'add_fact', payload: { id, source: 's' } });
  }
  assert.equal(g.status('r').state, 'valid');
});

test('cycle detection: mutual and self references rejected with E_CYCLE', () => {
  const g = graphWith([
    ['add_rule', { id: 'a', op: 'count', premises: ['b'], threshold: 1 }], // forward ref ok
  ]);
  assert.throws(
    () => g.check({ type: 'add_rule', payload: { id: 'b', op: 'count', premises: ['a'], threshold: 1 } }),
    (e) => e instanceof EvidenceError && e.code === 'E_CYCLE',
  );
  assert.throws(
    () => g.check({ type: 'add_rule', payload: { id: 'c', op: 'count', premises: ['c'], threshold: 1 } }),
    (e) => e.code === 'E_CYCLE',
  );
});

test('three-level derivation degrades on revoke and recovers on restore', () => {
  const g = graphWith([
    ['add_fact', { id: 'f', source: 's' }],
    ['add_rule', { id: 'r1', op: 'count', premises: ['f'], threshold: 1 }],
    ['add_rule', { id: 'r2', op: 'count', premises: ['r1'], threshold: 1 }],
    ['add_rule', { id: 'r3', op: 'count', premises: ['r2'], threshold: 1 }],
  ]);
  assert.equal(g.status('r3').state, 'valid');
  g.apply({ type: 'revoke_source', payload: { source: 's' } });
  for (const id of ['f', 'r1', 'r2', 'r3']) assert.equal(g.status(id).state, 'degraded', id);
  g.apply({ type: 'restore_source', payload: { source: 's' } });
  for (const id of ['f', 'r1', 'r2', 'r3']) assert.equal(g.status(id).state, 'valid', id);
});

test('restore does not resurrect a fact removed after revoke', () => {
  const g = graphWith([
    ['add_fact', { id: 'f', source: 's' }],
    ['add_rule', { id: 'r', op: 'count', premises: ['f'], threshold: 1 }],
  ]);
  g.apply({ type: 'revoke_source', payload: { source: 's' } });
  g.check({ type: 'remove_fact', payload: { id: 'f' } });
  g.apply({ type: 'remove_fact', payload: { id: 'f' } });
  g.apply({ type: 'restore_source', payload: { source: 's' } });
  assert.equal(g.status('f').state, 'removed');
  assert.equal(g.status('r').state, 'degraded'); // removed is decided-negative
});

test('E_SOURCE_GONE for unknown source/fact/node operations', () => {
  const g = new EvidenceGraph();
  assert.throws(() => g.check({ type: 'revoke_source', payload: { source: 'nope' } }), (e) => e.code === 'E_SOURCE_GONE');
  assert.throws(() => g.check({ type: 'restore_source', payload: { source: 'nope' } }), (e) => e.code === 'E_SOURCE_GONE');
  assert.throws(() => g.check({ type: 'remove_fact', payload: { id: 'nope' } }), (e) => e.code === 'E_SOURCE_GONE');
  assert.throws(() => g.status('nope'), (e) => e.code === 'E_SOURCE_GONE');
});

test('duplicate node ids rejected with E_DUP', () => {
  const g = graphWith([['add_fact', { id: 'f', source: 's' }]]);
  assert.throws(() => g.check({ type: 'add_fact', payload: { id: 'f', source: 's' } }), (e) => e.code === 'E_DUP');
  assert.throws(() => g.check({ type: 'add_rule', payload: { id: 'f', op: 'count', premises: [] } }), (e) => e.code === 'E_DUP');
});

test('state round-trips through toState/fromState', () => {
  const g = graphWith([
    ['add_fact', { id: 'f1', source: 's1', value: 7 }],
    ['add_rule', { id: 'r1', op: 'sum', premises: ['f1'], threshold: 5 }],
    ['revoke_source', { source: 's1' }],
  ]);
  const g2 = EvidenceGraph.fromState(g.toState());
  assert.deepEqual(g2.materialize(), g.materialize());
});
