'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRequest } = require('../src/engine');

function finalNodes(res) {
  const m = new Map();
  for (const n of res.final.state.nodes) m.set(n.id, n);
  return m;
}

test('source update invalidates only descendants along out-edges', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's1', kind: 'source', value: 1 },
        { id: 's2', kind: 'source', value: 10 },
        { id: 'd1', kind: 'derived', op: 'sum', inputs: ['s1'] },
        { id: 'd2', kind: 'derived', op: 'sum', inputs: ['s2'] },
        { id: 'd3', kind: 'derived', op: 'sum', inputs: ['d1'] },
      ],
    },
    transactions: [{ id: 't1', ops: [{ type: 'setSource', node: 's1', value: 5 }] }],
  });
  assert.equal(res.ok, true);
  const [r] = res.results;
  assert.deepEqual(r.recomputed, ['d1', 'd3']);
  assert.deepEqual(r.affected.map((a) => a.node), ['d1', 'd3', 's1']);
  const nodes = finalNodes(res);
  assert.equal(nodes.get('d1').value, 5);
  assert.equal(nodes.get('d3').value, 5);
  assert.equal(nodes.get('d2').value, 10); // untouched branch
});

test('after removeEdge the old descendant is no longer invalidated', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's1', kind: 'source', value: 1 },
        { id: 'd1', kind: 'derived', op: 'sum', inputs: ['s1'] },
      ],
    },
    transactions: [
      {
        id: 't1',
        ops: [
          { type: 'removeEdge', from: 's1', to: 'd1' },
          { type: 'setSource', node: 's1', value: 99 },
        ],
      },
      { id: 't2', ops: [{ type: 'setSource', node: 's1', value: 1000 }] },
    ],
  });
  const [r1, r2] = res.results;
  // d1 recomputed once (sum of empty input = 0), s1 no longer invalidates it.
  assert.deepEqual(r1.recomputed, ['d1']);
  assert.deepEqual(r1.affected.map((a) => a.node), ['d1', 's1']);
  assert.deepEqual(r2.recomputed, []);
  assert.deepEqual(r2.affected.map((a) => a.node), ['s1']);
  const nodes = finalNodes(res);
  assert.equal(nodes.get('d1').value, 0);
  assert.equal(nodes.get('s1').value, 1000);
});

test('diamond recompute order is deterministic with id-ascending ties', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's', kind: 'source', value: 1 },
        { id: 'b', kind: 'derived', op: 'sum', inputs: ['s'] },
        { id: 'a', kind: 'derived', op: 'sum', inputs: ['s'] },
        { id: 'c', kind: 'derived', op: 'sum', inputs: ['a', 'b'] },
      ],
    },
    transactions: [{ id: 't1', ops: [{ type: 'setSource', node: 's', value: 2 }] }],
  });
  assert.deepEqual(res.results[0].recomputed, ['a', 'b', 'c']);
  assert.equal(finalNodes(res).get('c').value, 4);
});

test('cycle edge returns E_CYCLE and rolls the whole transaction back', () => {
  const req = {
    state: {
      nodes: [
        { id: 's', kind: 'source', value: 1 },
        { id: 'd1', kind: 'derived', op: 'sum', inputs: ['s'] },
        { id: 'd2', kind: 'derived', op: 'sum', inputs: ['d1'] },
      ],
    },
    transactions: [
      {
        id: 'bad',
        ops: [
          { type: 'setSource', node: 's', value: 42 }, // must be rolled back too
          { type: 'addEdge', from: 'd2', to: 'd1' },   // d1 -> d2 -> d1
        ],
      },
      { id: 'after', ops: [{ type: 'setSource', node: 's', value: 7 }] },
    ],
  };
  const res = runRequest(req);
  const [bad, after] = res.results;
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_CYCLE');
  assert.deepEqual(bad.error.edge, { from: 'd2', to: 'd1' });
  assert.equal(bad.version, 0); // version not consumed by rolled-back tx
  // Rolled-back state: source value and graph unchanged.
  const rolled = new Map(bad.state.nodes.map((n) => [n.id, n]));
  assert.equal(rolled.get('s').value, 1);
  assert.equal(bad.state.edges.length, 2);
  // Engine still usable afterwards.
  assert.equal(after.ok, true);
  assert.equal(after.version, 1);
  assert.equal(finalNodes(res).get('d2').value, 7);
});

test('self-loop is a cycle', () => {
  const res = runRequest({
    state: { nodes: [{ id: 'd', kind: 'derived', op: 'sum' }] },
    transactions: [{ id: 't', ops: [{ type: 'addEdge', from: 'd', to: 'd' }] }],
  });
  assert.equal(res.results[0].ok, false);
  assert.equal(res.results[0].error.code, 'E_CYCLE');
});

test('cycle in initial state is rejected', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 'a', kind: 'derived', op: 'sum', inputs: ['b'] },
        { id: 'b', kind: 'derived', op: 'sum', inputs: ['a'] },
      ],
    },
    transactions: [],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_CYCLE');
});

test('E_DERIVE blocks the error node and descendants, other branches survive', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's', kind: 'source', value: 4 },
        { id: 'ok', kind: 'derived', op: 'sum', inputs: ['s'] },
        { id: 'bad', kind: 'derived', op: 'avg' },        // isolated: empty input
        { id: 'down', kind: 'derived', op: 'sum', inputs: ['bad'] },
      ],
    },
    transactions: [{ id: 't1', ops: [{ type: 'setSource', node: 's', value: 8 }] }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.initialErrors.length, 1);
  assert.equal(res.initialErrors[0].code, 'E_DERIVE');
  assert.equal(res.initialErrors[0].node, 'bad');
  const nodes = finalNodes(res);
  assert.equal(nodes.get('bad').blocked, true);
  assert.equal(nodes.get('bad').value, null);
  assert.equal(nodes.get('down').blocked, true); // blocked propagates downstream
  assert.equal(nodes.get('ok').blocked, false);
  assert.equal(nodes.get('ok').value, 8); // unaffected branch keeps computing
});

test('E_DERIVE triggered by a transaction via type mismatch', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's', kind: 'source', value: 1 },
        { id: 'n', kind: 'derived', op: 'sum', inputs: ['s'] },
        { id: 't', kind: 'derived', op: 'concat', inputs: ['s'] },
      ],
    },
    transactions: [{ id: 't1', ops: [{ type: 'setSource', node: 's', value: 'oops' }] }],
  });
  const [r] = res.results;
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors.map((e) => e.code), ['E_DERIVE']);
  assert.deepEqual(r.errors.map((e) => e.node), ['n']);
  const nodes = finalNodes(res);
  assert.equal(nodes.get('n').blocked, true);
  assert.equal(nodes.get('t').value, 'oops'); // string branch fine
});

test('isolated derived: sum -> 0, concat -> "", min/max/avg -> E_DERIVE', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's', kind: 'derived', op: 'sum' },
        { id: 'c', kind: 'derived', op: 'concat' },
        { id: 'mn', kind: 'derived', op: 'min' },
        { id: 'mx', kind: 'derived', op: 'max' },
        { id: 'av', kind: 'derived', op: 'avg' },
      ],
    },
    transactions: [],
  });
  const nodes = finalNodes(res);
  assert.equal(nodes.get('s').value, 0);
  assert.equal(nodes.get('s').blocked, false);
  assert.equal(nodes.get('c').value, '');
  assert.equal(nodes.get('mn').blocked, true);
  assert.equal(nodes.get('mx').blocked, true);
  assert.equal(nodes.get('av').blocked, true);
  assert.equal(res.initialErrors.length, 3);
});

test('concat input order is deterministic (sorted by input id)', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's1', kind: 'source', value: 'x' },
        { id: 's2', kind: 'source', value: 'y' },
        { id: 'd', kind: 'derived', op: 'concat', inputs: ['s2', 's1'] },
      ],
    },
    transactions: [],
  });
  assert.equal(finalNodes(res).get('d').value, 'xy');
});

test('undo restores graph and values by undoTag, reverse order', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's', kind: 'source', value: 1 },
        { id: 'd', kind: 'derived', op: 'sum', inputs: ['s'] },
      ],
    },
    transactions: [
      { id: 't1', undoTag: 'u1', ops: [{ type: 'setSource', node: 's', value: 2 }] },
      { id: 't2', undoTag: 'u2', ops: [{ type: 'addNode', node: { id: 'e', kind: 'derived', op: 'sum', inputs: ['d'] } }] },
      { id: 't3', ops: [{ type: 'undo', undoTag: 'u2' }] }, // removes node e
      { id: 't4', ops: [{ type: 'undo', undoTag: 'u1' }] }, // restores s = 1
    ],
  });
  assert.ok(res.results.every((r) => r.ok));
  const nodes = finalNodes(res);
  assert.equal(nodes.get('s').value, 1);
  assert.equal(nodes.get('d').value, 1);
  assert.equal(nodes.has('e'), false); // graph structure restored
  assert.equal(res.final.version, 4);
});

test('undo with a shared tag undoes all matching transactions in reverse', () => {
  const res = runRequest({
    state: { nodes: [{ id: 's', kind: 'source', value: 0 }] },
    transactions: [
      { id: 't1', undoTag: 'u', ops: [{ type: 'setSource', node: 's', value: 1 }] },
      { id: 't2', undoTag: 'u', ops: [{ type: 'setSource', node: 's', value: 2 }] },
      { id: 't3', ops: [{ type: 'undo', undoTag: 'u' }] },
    ],
  });
  assert.equal(finalNodes(res).get('s').value, 0);
});

test('undo of unknown tag returns E_UNDO_TAG and changes nothing', () => {
  const res = runRequest({
    state: { nodes: [{ id: 's', kind: 'source', value: 3 }] },
    transactions: [
      { id: 't1', undoTag: 'u1', ops: [{ type: 'setSource', node: 's', value: 4 }] },
      {
        id: 't2',
        ops: [
          { type: 'setSource', node: 's', value: 99 },
          { type: 'undo', undoTag: 'nope' },
        ],
      },
    ],
  });
  const [, r2] = res.results;
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'E_UNDO_TAG');
  assert.equal(r2.version, 1); // rolled back: version untouched
  assert.equal(finalNodes(res).get('s').value, 4); // partial op rolled back
});

test('empty transactions and empty ops yield empty results', () => {
  const res = runRequest({
    state: { nodes: [{ id: 's', kind: 'source', value: 1 }] },
    transactions: [],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, []);
  assert.equal(res.final.version, 0);

  const res2 = runRequest({
    state: { nodes: [{ id: 's', kind: 'source', value: 1 }] },
    transactions: [{ id: 'noop', ops: [] }],
  });
  const [r] = res2.results;
  assert.equal(r.ok, true);
  assert.deepEqual(r.affected, []);
  assert.deepEqual(r.recomputed, []);
  assert.equal(r.version, 1);
});

test('unknown node and bad op roll the transaction back', () => {
  const res = runRequest({
    state: {
      nodes: [
        { id: 's', kind: 'source', value: 1 },
        { id: 'd', kind: 'derived', op: 'sum', inputs: ['s'] },
      ],
    },
    transactions: [
      { id: 't1', ops: [{ type: 'setSource', node: 'ghost', value: 1 }] },
      { id: 't2', ops: [{ type: 'setSource', node: 'd', value: 1 }] },
      { id: 't3', ops: [{ type: 'addEdge', from: 's', to: 's' }] },
    ],
  });
  assert.equal(res.results[0].error.code, 'E_UNKNOWN_NODE');
  assert.equal(res.results[1].error.code, 'E_BAD_OP');
  assert.equal(res.results[2].error.code, 'E_BAD_OP'); // sources take no inputs
  assert.equal(res.final.version, 0);
  assert.equal(finalNodes(res).get('d').value, 1);
});

test('certificate is a pure function of state, not of the path', () => {
  // Two different transaction sequences reaching the same state at the same
  // version must yield the same certificate.
  const mk = (ops) => runRequest({
    state: {
      nodes: [
        { id: 's', kind: 'source', value: 0 },
        { id: 'd', kind: 'derived', op: 'sum', inputs: ['s'] },
      ],
    },
    transactions: [{ id: 't', ops }],
  });
  const a = mk([{ type: 'setSource', node: 's', value: 5 }]);
  const b = mk([
    { type: 'setSource', node: 's', value: 3 },
    { type: 'setSource', node: 's', value: 5 },
  ]);
  assert.equal(a.results[0].certificate, b.results[0].certificate);
});
