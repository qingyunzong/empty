import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NetworkError, PaymentNetwork } from '../src/network.js';

const buildDiamond = () => {
  // Two parallel paths A -> C: A-B-C and A-D-C.
  const net = new PaymentNetwork();
  net.addEdge('A', 'B', 100);
  net.addEdge('B', 'C', 100);
  net.addEdge('A', 'D', 50);
  net.addEdge('D', 'C', 50);
  return net;
};

describe('acceptance 1: two-path network stays routable after closing one edge', () => {
  it('routes the batch over the surviving path', () => {
    const net = buildDiamond();
    const closed = net.closeEdge('A', 'B');
    assert.equal(closed.open, false);
    assert.equal(closed.bridgeCertificate, null);

    const result = net.cancelBatch([{ id: 'p1', from: 'A', to: 'C' }]);
    assert.deepEqual(result.cancelled, [{ id: 'p1', from: 'A', to: 'C', path: ['A', 'D', 'C'] }]);
    assert.deepEqual(result.bridges, [['A', 'D'], ['B', 'C'], ['C', 'D']]);
    assert.deepEqual(result.affectedComponents, [['A', 'B', 'C', 'D']]);
  });
});

describe('acceptance 2: closing the only bridge fails the whole batch atomically', () => {
  it('returns a bridge certificate and rejects the batch with no state change', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B', 10);

    const closed = net.closeEdge('A', 'B');
    assert.deepEqual(closed.bridgeCertificate.edge, ['A', 'B']);
    assert.deepEqual(closed.bridgeCertificate.splitsInto, [['A'], ['B']]);

    const before = net.snapshot();
    assert.throws(
      () => net.cancelBatch([
        { id: 'p1', from: 'A', to: 'B' },
        { id: 'p2', from: 'A', to: 'A' },
      ]),
      (error) => {
        assert.ok(error instanceof NetworkError);
        assert.equal(error.code, 'BATCH_NOT_ROUTABLE');
        assert.equal(error.details.length, 1);
        assert.equal(error.details[0].id, 'p1');
        return true;
      },
    );
    // Atomicity: nothing cancelled, graph state untouched.
    assert.deepEqual(net.snapshot(), before);
    assert.deepEqual(net.components(), [['A'], ['B']]);
  });
});

describe('acceptance 3: reopening restores routing, parallel paths are lexicographic', () => {
  it('picks the lexicographically smallest of the parallel shortest paths', () => {
    const net = buildDiamond();
    net.closeEdge('A', 'B');
    assert.deepEqual(net.cancelBatch([{ id: 'p1', from: 'A', to: 'C' }]).cancelled[0].path, ['A', 'D', 'C']);

    net.openEdge('A', 'B');
    const result = net.cancelBatch([{ id: 'p2', from: 'A', to: 'C' }]);
    // Parallel shortest paths A-B-C and A-D-C: lexicographic order wins.
    assert.deepEqual(result.cancelled[0].path, ['A', 'B', 'C']);
    assert.deepEqual(result.bridges, []);
    assert.deepEqual(result.affectedComponents, [['A', 'B', 'C', 'D']]);
  });

  it('orders longer parallel paths lexicographically as well', () => {
    const net = new PaymentNetwork();
    // Paths S to T: S-b-x-T, S-a-z-T (length 3) -> S-a-z-T wins.
    net.addEdge('S', 'b');
    net.addEdge('b', 'x');
    net.addEdge('x', 'T');
    net.addEdge('S', 'a');
    net.addEdge('a', 'z');
    net.addEdge('z', 'T');
    const result = net.cancelBatch([{ id: 'p', from: 'S', to: 'T' }]);
    assert.deepEqual(result.cancelled[0].path, ['S', 'a', 'z', 'T']);
  });
});

describe('validation errors', () => {
  it('rejects self-loops', () => {
    const net = new PaymentNetwork();
    assert.throws(() => net.addEdge('A', 'A'), (e) => e.code === 'SELF_LOOP');
  });

  it('rejects duplicate edges', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B');
    assert.throws(() => net.addEdge('B', 'A'), (e) => e.code === 'DUPLICATE_EDGE');
  });

  it('rejects unknown nodes', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B');
    assert.throws(() => net.closeEdge('A', 'Z'), (e) => e.code === 'UNKNOWN_NODE');
    assert.throws(
      () => net.cancelBatch([{ id: 'p', from: 'A', to: 'Z' }]),
      (e) => e.code === 'BATCH_NOT_ROUTABLE' && e.details[0].code === 'UNKNOWN_NODE',
    );
  });

  it('rejects closing an already closed edge', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B');
    net.closeEdge('A', 'B');
    assert.throws(() => net.closeEdge('A', 'B'), (e) => e.code === 'EDGE_ALREADY_CLOSED');
  });

  it('rejects opening an edge that is not closed', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B');
    assert.throws(() => net.openEdge('A', 'B'), (e) => e.code === 'EDGE_NOT_CLOSED');
  });

  it('rejects empty batches', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B');
    assert.throws(() => net.cancelBatch([]), (e) => e.code === 'EMPTY_BATCH');
    assert.throws(() => net.cancelBatch(undefined), (e) => e.code === 'EMPTY_BATCH');
  });

  it('rejects unknown edges', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B');
    net.addEdge('B', 'C');
    assert.throws(() => net.closeEdge('A', 'C'), (e) => e.code === 'UNKNOWN_EDGE');
  });
});

describe('batch atomicity', () => {
  it('rejects the whole batch when any payment is unroutable', () => {
    const net = buildDiamond();
    net.closeEdge('A', 'B');
    net.closeEdge('A', 'D'); // A is now isolated
    const before = net.snapshot();
    assert.throws(
      () => net.cancelBatch([
        { id: 'ok', from: 'B', to: 'C' },
        { id: 'bad', from: 'A', to: 'C' },
      ]),
      (e) => e.code === 'BATCH_NOT_ROUTABLE',
    );
    assert.deepEqual(net.snapshot(), before);
  });
});

describe('query surface', () => {
  it('reports all bridges and only the affected components', () => {
    const net = new PaymentNetwork();
    net.addEdge('A', 'B');
    net.addEdge('B', 'C');
    net.addEdge('X', 'Y'); // separate component
    const result = net.cancelBatch([{ id: 'p', from: 'A', to: 'C' }]);
    assert.deepEqual(result.cancelled[0].path, ['A', 'B', 'C']);
    assert.deepEqual(result.bridges, [['A', 'B'], ['B', 'C'], ['X', 'Y']]);
    assert.deepEqual(result.affectedComponents, [['A', 'B', 'C']]);
  });
});
