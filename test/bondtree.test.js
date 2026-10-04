import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BondTree,
  InsufficientOccupancyError,
  HasLiveChildrenError,
} from '../src/bondtree.js';
import { brutePhraseAll, bruteNearAll } from '../testlib/helpers.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bondtree-'));
}

function snapshot(tree) {
  return {
    nodes: [...tree.nodes.values()].map((n) => ({ ...n })),
    certs: JSON.parse(JSON.stringify(tree.certs)),
    certTip: tree.certTip,
  };
}

function buildThreeLevelTree(dir) {
  const tree = new BondTree(dir);
  tree.addNode({ id: 'R', parentId: null, faceValue: 0, lineLimit: 10000, terms: 'issuer root' });
  tree.addNode({ id: 'A', parentId: 'R', faceValue: 100, lineLimit: 5000, terms: 'fixed rate bond alpha tranche' });
  tree.addNode({ id: 'B', parentId: 'A', faceValue: 40, lineLimit: 2000, terms: 'fixed coupon sub tranche beta' });
  tree.addNode({ id: 'C', parentId: 'B', faceValue: 10, lineLimit: 100, terms: 'fixed coupon retail gamma' });
  tree.addNode({ id: 'A2', parentId: 'A', faceValue: 5, lineLimit: 100, terms: 'floating rate note' });
  tree.addNode({ id: 'R2', parentId: 'R', faceValue: 7, lineLimit: 100, terms: 'green bond epsilon' });
  return tree;
}

test('acceptance 1: three-level compensation matches independent post-order traversal', () => {
  const tree = buildThreeLevelTree(tmpDir());
  const cert = tree.revokeNode('C');
  // C -> B -> A -> R: three ancestor levels, each releases exactly 10.
  assert.equal(cert.levels.length, 3);
  assert.deepEqual(cert.levels.map((l) => l.nodeId), ['B', 'A', 'R']);
  for (const level of cert.levels) {
    assert.equal(level.before - level.after, 10);
    // Per-level result equals an independent post-order recomputation.
    assert.equal(level.after, tree.postOrderOccupancy(level.nodeId), `level ${level.nodeId}`);
    assert.equal(tree.getNode(level.nodeId).occupied, tree.postOrderOccupancy(level.nodeId));
  }
  assert.equal(tree.getNode('C').state, 'revoked');
  // Certificate carries hit positions and chains into the root cert hash.
  assert.ok(cert.hits.length > 0);
  assert.ok(cert.hits.every((h) => h.nodeId && Array.isArray(h.positions)));
  assert.equal(tree.certTip, cert.hash);
  assert.equal(tree.verifyCertChain(), true);
});

test('acceptance 2: insufficient level quota leaves the whole tree unchanged', () => {
  const dir = tmpDir();
  const tree = buildThreeLevelTree(dir);
  // Corrupt the ledger so level A cannot cover the release of 10.
  tree.getNode('A').occupied = 4;
  tree.save();
  const before = snapshot(tree);
  assert.throws(() => tree.revokeNode('C'), (err) => {
    assert.ok(err instanceof InsufficientOccupancyError);
    assert.equal(err.nodeId, 'A');
    return true;
  });
  const after = snapshot(tree);
  assert.deepEqual(after, before);
  // Reload from disk: persisted state is also untouched.
  const reloaded = new BondTree(dir);
  assert.deepEqual(snapshot(reloaded), before);
});

test('acceptance 3: phrase/near match enumeration; delete rules; restart invisibility', () => {
  const dir = tmpDir();
  const tree = buildThreeLevelTree(dir);
  const docs = [...tree.nodes.values()].map((n) => [n.id, n.terms]);
  // Phrase and proximity results agree with enumerated windows.
  for (const phrase of ['fixed rate', 'fixed coupon', 'green bond', 'no such words']) {
    assert.deepEqual(tree.phrase(phrase), brutePhraseAll(docs, phrase));
  }
  for (const [q, k] of [['fixed coupon', 3], ['fixed beta', 4], ['rate tranche', 5]]) {
    assert.deepEqual(tree.near(q, k), bruteNearAll(docs, q, k));
  }
  // Node with live children cannot be physically deleted.
  assert.throws(() => tree.deleteNode('B'), (err) => {
    assert.ok(err instanceof HasLiveChildrenError);
    assert.deepEqual(err.children, ['C']);
    return true;
  });
  // Childless node deletes fine; positions are removed incrementally.
  tree.deleteNode('C');
  assert.equal(tree.index.hasNode('C'), false);
  const docsAfter = docs.filter(([id]) => id !== 'C');
  assert.deepEqual(tree.phrase('fixed coupon'), brutePhraseAll(docsAfter, 'fixed coupon'));
  // After a restart the deleted node stays invisible.
  const restarted = new BondTree(dir);
  assert.throws(() => restarted.getNode('C'), /unknown node/);
  assert.equal(restarted.index.hasNode('C'), false);
  assert.deepEqual(restarted.phrase('retail gamma'), []);
  assert.deepEqual(restarted.near('fixed gamma', 4), bruteNearAll(docsAfter, 'fixed gamma', 4));
});

test('delete of an active childless node releases occupancy atomically', () => {
  const tree = buildThreeLevelTree(tmpDir());
  const beforeA = tree.getNode('A').occupied;
  tree.deleteNode('A2');
  assert.equal(tree.getNode('A').occupied, beforeA - 5);
  assert.equal(tree.getNode('A').occupied, tree.postOrderOccupancy('A'));
});

test('addNode enforces ancestor line limits', () => {
  const tree = new BondTree(tmpDir());
  tree.addNode({ id: 'R', parentId: null, faceValue: 0, lineLimit: 10, terms: 'root' });
  tree.addNode({ id: 'X', parentId: 'R', faceValue: 8, lineLimit: 10, terms: 'x' });
  assert.throws(
    () => tree.addNode({ id: 'Y', parentId: 'R', faceValue: 3, lineLimit: 10, terms: 'y' }),
    InsufficientOccupancyError,
  );
  assert.equal(tree.nodes.has('Y'), false);
});

test('certificate hash chain survives restart', () => {
  const dir = tmpDir();
  const tree = buildThreeLevelTree(dir);
  const cert1 = tree.revokeNode('C');
  tree.revokeNode('A2');
  const reloaded = new BondTree(dir);
  assert.equal(reloaded.verifyCertChain(), true);
  assert.equal(reloaded.certTip, reloaded.certs[1].hash);
  assert.equal(reloaded.certs[0].hash, cert1.hash);
  assert.equal(reloaded.certs[1].prevHash, cert1.hash);
});
