import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/graph.js';

test('cycle returns E_CYCLE, rolls back, transaction has no partial effect', () => {
  const e = new Engine({
    nodes: [
      { id: 's', kind: 'source', value: 1 },
      { id: 'a', kind: 'derived', op: 'sum', inputs: ['s'] },
      { id: 'b', kind: 'derived', op: 'sum', inputs: ['a'] },
    ],
  });
  const before = e.getState();
  const res = e.applyTransaction({
    id: 'bad',
    ops: [
      { type: 'setSource', node: 's', value: 42 }, // would be a partial effect
      { type: 'addEdge', from: 'b', to: 'a' }, // closes a cycle a -> b -> a
    ],
  });
  assert.equal(res.status, 'error');
  assert.equal(res.error.code, 'E_CYCLE');
  assert.deepEqual(res.error.edge, { from: 'b', to: 'a' });
  assert.deepEqual(res.state, before, 'rolled-back state returned');
  assert.deepEqual(e.getState(), before, 'no partial effects committed');
  assert.equal(e.certificate().version, 0, 'failed tx does not bump version');
  // Self-loop is also a cycle.
  const self = e.applyTransaction({ id: 'self', ops: [{ type: 'addEdge', from: 'a', to: 'a' }] });
  assert.equal(self.error.code, 'E_CYCLE');
});

test('cycle in initial state is rejected', () => {
  assert.throws(
    () =>
      new Engine({
        nodes: [
          { id: 'a', kind: 'derived', op: 'sum', inputs: ['b'] },
          { id: 'b', kind: 'derived', op: 'sum', inputs: ['a'] },
        ],
      }),
    (err) => err.code === 'E_CYCLE',
  );
});

test('empty input: min/max/avg -> E_DERIVE blocked; sum -> 0; concat -> ""', () => {
  const e = new Engine({
    nodes: [
      { id: 's', kind: 'source', value: 5 },
      { id: 'mn', kind: 'derived', op: 'min' }, // isolated derived, empty input
      { id: 'mx', kind: 'derived', op: 'max' },
      { id: 'av', kind: 'derived', op: 'avg' },
      { id: 'sm', kind: 'derived', op: 'sum' },
      { id: 'cc', kind: 'derived', op: 'concat' },
      { id: 'down', kind: 'derived', op: 'sum', inputs: ['mn'] }, // descendant of blocked
      { id: 'other', kind: 'derived', op: 'sum', inputs: ['s'] }, // unaffected branch
    ],
  });
  const state = e.getState();
  const byId = Object.fromEntries(state.nodes.map((n) => [n.id, n]));
  assert.equal(byId.mn.blocked, true);
  assert.equal(byId.mx.blocked, true);
  assert.equal(byId.av.blocked, true);
  assert.equal(byId.down.blocked, true, 'descendant of blocked node is blocked');
  assert.equal(byId.sm.value, 0);
  assert.equal(byId.cc.value, '');
  assert.equal(byId.other.value, 5);
  assert.equal(byId.other.blocked, false, 'other branches unaffected');
});

test('E_DERIVE reported per transaction; blocked node and descendants marked, others fine', () => {
  const e = new Engine({
    nodes: [
      { id: 's1', kind: 'source', value: 1 },
      { id: 's2', kind: 'source', value: 'text' },
      { id: 'good', kind: 'derived', op: 'sum', inputs: ['s1'] },
      { id: 'bad', kind: 'derived', op: 'sum', inputs: ['s2'] },
      { id: 'child', kind: 'derived', op: 'sum', inputs: ['bad'] },
    ],
  });
  const res = e.applyTransaction({ id: 't', ops: [{ type: 'setSource', node: 's1', value: 3 }] });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.blocked, ['bad', 'child']);
  assert.ok(res.deriveErrors.every((d) => d.code === 'E_DERIVE'));
  assert.deepEqual(
    res.diffs.map((d) => [d.node, d.after.value]),
    [['s1', 3], ['good', 3]],
    'only the healthy branch recomputed',
  );
  // Fixing the source unblocks the branch.
  const fix = e.applyTransaction({ id: 't2', ops: [{ type: 'setSource', node: 's2', value: 10 }] });
  assert.deepEqual(fix.blocked, []);
  assert.deepEqual(
    fix.diffs.map((d) => [d.node, d.after.value]),
    [['s2', 10], ['bad', 10], ['child', 10]],
  );
});

test('concat joins strings (input ids ascending) and flattens arrays', () => {
  const e = new Engine({
    nodes: [
      { id: 'b', kind: 'source', value: 'B' },
      { id: 'a', kind: 'source', value: 'A' },
      { id: 'c', kind: 'derived', op: 'concat', inputs: ['b', 'a'] },
      { id: 'arr', kind: 'derived', op: 'concat', inputs: ['l1', 'l2'] },
      { id: 'l1', kind: 'source', value: [1, 2] },
      { id: 'l2', kind: 'source', value: [3] },
    ],
  });
  const byId = Object.fromEntries(e.getState().nodes.map((n) => [n.id, n]));
  assert.equal(byId.c.value, 'AB');
  assert.deepEqual(byId.arr.value, [1, 2, 3]);
});

test('avg computes the mean', () => {
  const e = new Engine({
    nodes: [
      { id: 'a', kind: 'source', value: 1 },
      { id: 'b', kind: 'source', value: 4 },
      { id: 'av', kind: 'derived', op: 'avg', inputs: ['a', 'b'] },
    ],
  });
  const byId = Object.fromEntries(e.getState().nodes.map((n) => [n.id, n]));
  assert.equal(byId.av.value, 2.5);
});

test('undo restores graph and values in reverse order by undoTag', () => {
  const e = new Engine({
    nodes: [
      { id: 's', kind: 'source', value: 1 },
      { id: 'd', kind: 'derived', op: 'sum', inputs: ['s'] },
    ],
  });
  const initial = e.getState();
  e.applyTransaction({ id: 't1', undoTag: 'u1', ops: [{ type: 'setSource', node: 's', value: 2 }] });
  e.applyTransaction({
    id: 't2',
    undoTag: 'u2',
    ops: [
      { type: 'addNode', node: { id: 'd2', kind: 'derived', op: 'sum', inputs: ['d'] } },
      { type: 'setSource', node: 's', value: 3 },
    ],
  });
  assert.equal(e.getState().nodes.find((n) => n.id === 'd2').value, 3);
  // Undo most recent tag first: graph and values restored.
  const u2 = e.applyTransaction({ id: 'u', ops: [{ type: 'undo', tag: 'u2' }] });
  assert.equal(u2.status, 'ok');
  assert.equal(e.getState().nodes.some((n) => n.id === 'd2'), false, 'graph restored');
  assert.equal(e.getState().nodes.find((n) => n.id === 's').value, 2, 'values restored');
  const u1 = e.applyTransaction({ id: 'u', ops: [{ type: 'undo', tag: 'u1' }] });
  assert.equal(u1.status, 'ok');
  assert.deepEqual(
    { ...e.getState(), version: initial.version },
    initial,
    'fully restored to initial state',
  );
});

test('undo of nonexistent or out-of-order tag returns E_UNDO with no effect', () => {
  const e = new Engine({
    nodes: [
      { id: 's', kind: 'source', value: 1 },
      { id: 'd', kind: 'derived', op: 'sum', inputs: ['s'] },
    ],
  });
  const missing = e.applyTransaction({ id: 'x', ops: [{ type: 'undo', tag: 'nope' }] });
  assert.equal(missing.status, 'error');
  assert.equal(missing.error.code, 'E_UNDO');
  e.applyTransaction({ id: 't1', undoTag: 'u1', ops: [{ type: 'setSource', node: 's', value: 2 }] });
  e.applyTransaction({ id: 't2', undoTag: 'u2', ops: [{ type: 'setSource', node: 's', value: 3 }] });
  const before = e.getState();
  const outOfOrder = e.applyTransaction({ id: 'y', ops: [{ type: 'undo', tag: 'u1' }] });
  assert.equal(outOfOrder.status, 'error');
  assert.equal(outOfOrder.error.code, 'E_UNDO');
  assert.deepEqual(e.getState(), before, 'failed undo has no effect');
});

test('dynamic node add/remove recompute correctly', () => {
  const e = new Engine({
    nodes: [
      { id: 's', kind: 'source', value: 4 },
      { id: 'd', kind: 'derived', op: 'sum', inputs: ['s'] },
    ],
  });
  const add = e.applyTransaction({
    id: 't1',
    ops: [{ type: 'addNode', node: { id: 'd2', kind: 'derived', op: 'max', inputs: ['s', 'd'] } }],
  });
  assert.deepEqual(add.affected, ['d2']);
  assert.equal(e.getState().nodes.find((n) => n.id === 'd2').value, 4);
  const rm = e.applyTransaction({ id: 't2', ops: [{ type: 'removeNode', node: 'd' }] });
  assert.deepEqual(rm.affected, ['d2']);
  assert.equal(e.getState().nodes.find((n) => n.id === 'd2').value, 4);
  assert.equal(e.getState().nodes.some((n) => n.id === 'd'), false);
});
