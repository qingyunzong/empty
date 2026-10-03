import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError } from '../src/ledger.js';

test('cyclic guarantee network: whole SCC is reversed as a group', () => {
  const ledger = new Ledger();
  // a, b, c form a guarantee cycle; d depends on the cycle; the cycle depends on e.
  ledger.addDep('a', 'b');
  ledger.addDep('b', 'c');
  ledger.addDep('c', 'a');
  ledger.addDep('d', 'a');
  ledger.addDep('a', 'e');

  const res = ledger.cancel('b', 'evt-1');

  assert.equal(res.ok, true);
  assert.equal(res.op, 'cancel');
  assert.equal(res.event, 'evt-1');
  // Whole SCC {a,b,c} plus downstream dependency e; d is not reachable from b.
  assert.deepEqual(res.affected, ['a', 'b', 'c', 'e']);
  // All SCC members share one component id, distinct from e's.
  assert.equal(res.scc.a, res.scc.b);
  assert.equal(res.scc.b, res.scc.c);
  assert.notEqual(res.scc.a, res.scc.e);
  // Component of {a,b,c} precedes component of e in topological order.
  const order = res.componentTopoOrder;
  assert.ok(order.indexOf(res.scc.a) < order.indexOf(res.scc.e));
  // Certificate: DFS tree edges exist and the a -> e edge crosses components.
  assert.equal(res.certificate.root, 'b');
  assert.ok(res.certificate.dfsEdges.length >= 3);
  assert.deepEqual(res.certificate.crossComponentEdges, [['a', 'e']]);

  for (const tx of ['a', 'b', 'c', 'e']) {
    assert.equal(ledger.stateOf(tx), 'REVERSED');
  }
  assert.equal(ledger.stateOf('d'), 'ACTIVE');
});

test('DAG: only reachable successors are reversed', () => {
  const ledger = new Ledger();
  ledger.addDep('a', 'b');
  ledger.addDep('b', 'c');
  ledger.addDep('a', 'd');
  ledger.addDep('x', 'y'); // disconnected pair

  const res = ledger.cancel('a', 'evt-dag');

  assert.deepEqual(res.affected, ['a', 'b', 'c', 'd']);
  assert.equal(ledger.stateOf('x'), 'ACTIVE');
  assert.equal(ledger.stateOf('y'), 'ACTIVE');
  // Every component is a singleton in a DAG; topo order respects edges.
  const pos = new Map(res.componentTopoOrder.map((id, i) => [id, i]));
  assert.ok(pos.get(res.scc.a) < pos.get(res.scc.b));
  assert.ok(pos.get(res.scc.b) < pos.get(res.scc.c));
  // No cross-component edge inside one SCC; certificate lists only tree edges
  // that also happen to cross singleton components.
  assert.deepEqual(
    res.certificate.dfsEdges.slice().sort(),
    [['a', 'b'], ['a', 'd'], ['b', 'c']],
  );
});

test('remove-dep splits component, restore propagates over current graph', () => {
  const ledger = new Ledger();
  ledger.addDep('a', 'b');
  ledger.addDep('b', 'c');
  ledger.addDep('c', 'a');

  const cancelled = ledger.cancel('a', 'evt-c');
  assert.deepEqual(cancelled.affected, ['a', 'b', 'c']);
  assert.equal(cancelled.scc.a, cancelled.scc.c); // one SCC before the split

  // Removing c -> a breaks the cycle; the SCC splits into singletons.
  ledger.removeDep('c', 'a');
  const restored = ledger.restore('c', 'evt-r');
  // From c only c -> a is gone, so c reaches nothing else: only c is restored.
  assert.deepEqual(restored.affected, ['c']);
  assert.equal(ledger.stateOf('c'), 'ACTIVE');
  assert.equal(ledger.stateOf('a'), 'REVERSED');
  assert.equal(ledger.stateOf('b'), 'REVERSED');
  // After the split every component is a singleton.
  assert.ok(restored.components.every((comp) => comp.members.length === 1));

  // Restoring a now propagates a -> b -> c, but c is ACTIVE, so only a and b.
  const restored2 = ledger.restore('a', 'evt-r2');
  assert.deepEqual(restored2.affected, ['a', 'b']);
  assert.equal(ledger.stateOf('b'), 'ACTIVE');
});

test('error paths: unknown node, duplicate cancel, bad restore, duplicate event', () => {
  const ledger = new Ledger();
  ledger.addDep('a', 'b');

  assert.throws(() => ledger.cancel('ghost', 'e1'), (err) => {
    assert.ok(err instanceof LedgerError);
    assert.equal(err.code, 'UNKNOWN_TX');
    return true;
  });

  ledger.cancel('a', 'e2');
  assert.throws(() => ledger.cancel('a', 'e3'), { code: 'DUPLICATE_CANCEL' });
  // b was reversed by propagation; cancelling it again is a duplicate too.
  assert.throws(() => ledger.cancel('b', 'e4'), { code: 'DUPLICATE_CANCEL' });

  assert.throws(() => ledger.restore('ghost', 'e5'), { code: 'UNKNOWN_TX' });

  const fresh = new Ledger();
  fresh.addDep('p', 'q');
  assert.throws(() => fresh.restore('p', 'e6'), { code: 'NOT_REVERSED' });

  // Event ids are unique across cancel and restore.
  fresh.cancel('p', 'evt-x');
  assert.throws(() => fresh.restore('p', 'evt-x'), { code: 'DUPLICATE_EVENT' });
  fresh.restore('p', 'evt-y');
  // Second restore of an already ACTIVE transaction fails.
  assert.throws(() => fresh.restore('p', 'evt-z'), { code: 'NOT_REVERSED' });

  // remove-dep of a missing edge fails.
  assert.throws(() => fresh.removeDep('q', 'p'), { code: 'EDGE_NOT_FOUND' });
});
