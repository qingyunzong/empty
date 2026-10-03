import test from 'node:test';
import assert from 'node:assert/strict';
import { LedgerNetwork, LedgerError } from '../src/ledger.js';

test('acceptance 1: closing-loop edge merges multiple partitions into one SCC', () => {
  const net = new LedgerNetwork();
  net.addEdge(0, 1);
  net.addEdge(1, 0);
  net.addEdge(2, 3);
  net.addEdge(3, 2);
  net.addEdge(1, 2);

  let result = net.query();
  assert.deepEqual(result.components, [[0, 1], [2, 3]]);
  assert.deepEqual(result.topoOrder, [[0, 1], [2, 3]]);

  net.addEdge(3, 0);
  result = net.query();
  assert.deepEqual(result.components, [[0, 1, 2, 3]]);
  assert.deepEqual(result.topoOrder, [[0, 1, 2, 3]]);
  assert.equal(result.certificates.length, 1);
  const cert = result.certificates[0];
  assert.equal(cert.representative, 0);
  for (const member of [0, 1, 2, 3]) {
    assert.ok(cert.proofs[member].fromRepresentative, `path from rep to ${member}`);
    assert.ok(cert.proofs[member].toRepresentative, `path from ${member} to rep`);
  }
});

test('acceptance 2: direction correction splits the partition and updates topo order', () => {
  const net = new LedgerNetwork();
  net.addEdge(0, 1);
  net.addEdge(1, 2);
  net.addEdge(2, 0);

  let result = net.query();
  assert.deepEqual(result.components, [[0, 1, 2]]);

  net.correctDirection(2, 0);
  result = net.query();
  assert.deepEqual(result.components, [[0], [1], [2]]);
  assert.deepEqual(result.topoOrder, [[0], [1], [2]]);
  assert.equal(result.certificates.length, 3);
  for (const cert of result.certificates) {
    assert.deepEqual(cert.proofs[cert.representative].fromRepresentative, [cert.representative]);
  }
});

test('acceptance 3: rollback restores state and hash exactly', () => {
  const net = new LedgerNetwork();
  net.addEdge(0, 1);
  net.addEdge(1, 2);
  const snap = net.snapshot();

  net.addEdge(2, 0);
  net.correctDirection(0, 1);
  net.removeEdge(1, 2);
  assert.notEqual(net.stateHash(), snap.hash);

  const restored = net.rollback(snap.snapshot);
  assert.equal(restored.hash, snap.hash);
  assert.equal(net.stateHash(), snap.hash);
  assert.deepEqual(net.state(), {
    nodes: [0, 1, 2],
    edges: [
      [0, 1],
      [1, 2],
    ],
  });
});

test('rollback does not resurrect edges deleted before the snapshot', () => {
  const net = new LedgerNetwork();
  net.addEdge(0, 1);
  net.addEdge(7, 8);
  net.removeEdge(7, 8);
  const snap = net.snapshot();

  net.addEdge(1, 2);
  net.addEdge(2, 0);
  net.rollback(snap.snapshot);

  assert.equal(net.stateHash(), snap.hash);
  assert.deepEqual(net.state(), { nodes: [0, 1], edges: [[0, 1]] });
});

test('duplicate edge is rejected', () => {
  const net = new LedgerNetwork();
  net.addEdge(1, 2);
  assert.throws(() => net.addEdge(1, 2), (error) => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.code, 'duplicate-edge');
    return true;
  });
});

test('negative node id is rejected on every mutating op', () => {
  const net = new LedgerNetwork();
  for (const op of [
    () => net.addEdge(-1, 2),
    () => net.removeEdge(1, -2),
    () => net.correctDirection(-3, -4),
  ]) {
    assert.throws(op, (error) => {
      assert.equal(error.code, 'negative-id');
      return true;
    });
  }
});

test('unknown snapshot and future snapshot rollback are rejected', () => {
  const net = new LedgerNetwork();
  net.addEdge(0, 1);
  net.snapshot();

  assert.throws(() => net.rollback(0), (error) => {
    assert.equal(error.code, 'unknown-snapshot');
    return true;
  });
  assert.throws(() => net.rollback(-5), (error) => {
    assert.equal(error.code, 'unknown-snapshot');
    return true;
  });
  assert.throws(() => net.rollback(2), (error) => {
    assert.equal(error.code, 'future-snapshot');
    return true;
  });
  assert.throws(() => net.rollback(99), (error) => {
    assert.equal(error.code, 'future-snapshot');
    return true;
  });
});

test('removing or correcting a missing edge is rejected', () => {
  const net = new LedgerNetwork();
  assert.throws(() => net.removeEdge(0, 1), { code: 'missing-edge' });
  assert.throws(() => net.correctDirection(0, 1), { code: 'missing-edge' });
});

test('snapshot ids are sequential and snapshots survive later changes', () => {
  const net = new LedgerNetwork();
  net.addEdge(0, 1);
  const first = net.snapshot();
  net.addEdge(1, 2);
  const second = net.snapshot();
  assert.equal(first.snapshot, 1);
  assert.equal(second.snapshot, 2);
  assert.notEqual(first.hash, second.hash);
  net.rollback(first.snapshot);
  assert.equal(net.stateHash(), first.hash);
  net.rollback(second.snapshot);
  assert.equal(net.stateHash(), second.hash);
});
