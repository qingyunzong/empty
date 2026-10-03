'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentNetwork, NetError } = require('../index');

function diamond() {
  // A --e1-- B        two disjoint A->D paths: A-B-D and A-C-D
  // |        |
  // e3       e2
  // |        |
  // C --e4-- D
  const net = new PaymentNetwork();
  net.addEdge({ id: 'e1', a: 'A', b: 'B', bandwidth: 100 });
  net.addEdge({ id: 'e2', a: 'B', b: 'D', bandwidth: 100 });
  net.addEdge({ id: 'e3', a: 'A', b: 'C', bandwidth: 100 });
  net.addEdge({ id: 'e4', a: 'C', b: 'D', bandwidth: 100 });
  return net;
}

test('acceptance 1: dual-path network, batch succeeds after closing one edge', () => {
  const net = diamond();
  const close = net.closeEdge({ id: 'e1' });
  assert.equal(close.open, false);

  const result = net.cancelBatch({
    batchId: 'b1',
    payments: [
      { id: 'p1', from: 'A', to: 'D', amount: 10 },
      { id: 'p2', from: 'B', to: 'C', amount: 5 },
    ],
  });
  assert.equal(result.batchId, 'b1');
  assert.equal(result.cancelled, 2);
  assert.deepEqual(result.payments[0].path, ['A', 'C', 'D']);
  assert.deepEqual(result.payments[1].path, ['B', 'D', 'C']);
  // remaining graph is the path B-D-C-A: every open edge is a bridge
  assert.deepEqual(result.bridges.map((b) => b.id).sort(), ['e2', 'e3', 'e4']);
  assert.deepEqual(result.components, [['A', 'B', 'C', 'D']]);
});

test('acceptance 2: closing the unique bridge fails the whole batch atomically', () => {
  const net = new PaymentNetwork();
  net.addEdge({ id: 'e1', a: 'A', b: 'B', bandwidth: 50 });
  net.addEdge({ id: 'e2', a: 'B', b: 'C', bandwidth: 50 });

  const close = net.closeEdge({ id: 'e2' });
  assert.equal(close.splitsGraph, true);

  const before = net.snapshot();
  assert.throws(
    () => net.cancelBatch({
      batchId: 'b2',
      payments: [
        { id: 'p1', from: 'A', to: 'B', amount: 1 }, // routable on its own
        { id: 'p2', from: 'A', to: 'C', amount: 1 }, // disconnected
      ],
    }),
    (err) => {
      assert.ok(err instanceof NetError);
      assert.equal(err.code, 'DISCONNECTED');
      assert.equal(err.details.payment, 'p2');
      const cert = err.bridgeCertificate;
      assert.ok(cert, 'bridge certificate must be present');
      assert.deepEqual(cert.components, [['A', 'B'], ['C']]);
      assert.deepEqual(cert.bridges, [{ id: 'e1', a: 'A', b: 'B' }]);
      const maint = cert.maintenanceEdges.find((e) => e.id === 'e2');
      assert.equal(maint.splitsGraph, true);
      return true;
    },
  );
  // atomicity: failed batch leaves the network untouched
  assert.deepEqual(net.snapshot(), before);
});

test('acceptance 3: reopening restores routing, parallel paths resolve lexicographically', () => {
  const net = diamond();
  net.closeEdge({ id: 'e1' });
  net.closeEdge({ id: 'e4' }); // now D is unreachable from A
  assert.throws(
    () => net.cancelBatch({ batchId: 'b3', payments: [{ id: 'p1', from: 'A', to: 'D' }] }),
    (err) => err.code === 'DISCONNECTED',
  );

  net.openEdge({ id: 'e1' });
  net.openEdge({ id: 'e4' });
  const result = net.cancelBatch({ batchId: 'b4', payments: [{ id: 'p1', from: 'A', to: 'D' }] });
  // both A-B-D and A-C-D have length 2; lexicographically smallest wins
  assert.deepEqual(result.payments[0].path, ['A', 'B', 'D']);
  assert.deepEqual(result.bridges, []);
  assert.deepEqual(result.components, [['A', 'B', 'C', 'D']]);
});

test('lexicographic path selection among equal-length parallel paths', () => {
  const net = new PaymentNetwork();
  net.addEdge({ id: 'e1', a: 'S', b: 'M2', bandwidth: 1 });
  net.addEdge({ id: 'e2', a: 'M2', b: 'T', bandwidth: 1 });
  net.addEdge({ id: 'e3', a: 'S', b: 'M1', bandwidth: 1 });
  net.addEdge({ id: 'e4', a: 'M1', b: 'T', bandwidth: 1 });
  const result = net.cancelBatch({ batchId: 'b', payments: [{ id: 'p', from: 'S', to: 'T' }] });
  assert.deepEqual(result.payments[0].path, ['S', 'M1', 'T']);
});

test('error: unknown node in payment', () => {
  const net = diamond();
  assert.throws(
    () => net.cancelBatch({ batchId: 'b', payments: [{ id: 'p', from: 'A', to: 'ZZ' }] }),
    (err) => err.code === 'UNKNOWN_NODE' && err.details.node === 'ZZ',
  );
});

test('error: closing an already closed edge', () => {
  const net = diamond();
  net.closeEdge({ id: 'e1' });
  assert.throws(
    () => net.closeEdge({ id: 'e1' }),
    (err) => err.code === 'EDGE_ALREADY_CLOSED',
  );
});

test('error: self-loop edge', () => {
  const net = new PaymentNetwork();
  assert.throws(
    () => net.addEdge({ id: 'e1', a: 'A', b: 'A', bandwidth: 10 }),
    (err) => err.code === 'SELF_LOOP',
  );
});

test('error: empty batch', () => {
  const net = diamond();
  assert.throws(
    () => net.cancelBatch({ batchId: 'b', payments: [] }),
    (err) => err.code === 'EMPTY_BATCH',
  );
});

test('error: unknown edge, duplicate edge, reopening open edge, invalid bandwidth', () => {
  const net = diamond();
  assert.throws(() => net.closeEdge({ id: 'nope' }), (err) => err.code === 'UNKNOWN_EDGE');
  assert.throws(() => net.openEdge({ id: 'e1' }), (err) => err.code === 'EDGE_ALREADY_OPEN');
  assert.throws(
    () => net.addEdge({ id: 'e1', a: 'X', b: 'Y', bandwidth: 1 }),
    (err) => err.code === 'DUPLICATE_EDGE',
  );
  assert.throws(
    () => net.addEdge({ id: 'e9', a: 'X', b: 'Y', bandwidth: 0 }),
    (err) => err.code === 'INVALID_BANDWIDTH',
  );
});

test('trivial payment from a node to itself succeeds', () => {
  const net = diamond();
  const result = net.cancelBatch({ batchId: 'b', payments: [{ id: 'p', from: 'A', to: 'A' }] });
  assert.deepEqual(result.payments[0].path, ['A']);
});
