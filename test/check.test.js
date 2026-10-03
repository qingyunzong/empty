'use strict';
// 验收4：check 输出覆盖证明，且证明可被独立命令验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'g17-check-'));
}

function buildStore(dir) {
  store.writeSnapshot(dir, { a: 100 }, { seq: 1, baseSeq: 0 });
  for (let s = 1; s <= 10; s++) {
    store.appendDelta(dir, { seq: s, type: 'txn', ops: [{ account: 'a', delta: s }] });
  }
  store.writeSnapshot(dir, { a: 155 }, { seq: 2, baseSeq: 10 });
  for (let s = 11; s <= 15; s++) {
    store.appendDelta(dir, { seq: s, type: 'txn', ops: [{ account: 'b', delta: 1 }] });
  }
}

test('check proof covers snapshots + deltas and is verifiable', () => {
  const dir = tmpdir();
  buildStore(dir);
  const proof = store.check(dir);
  assert.equal(proof.trusted.snapshotSeq, 2);
  assert.equal(proof.trusted.baseSeq, 10);
  assert.equal(proof.delta.count, 15);
  assert.equal(proof.delta.contiguous, true);
  assert.deepEqual(proof.delta.gaps, []);
  assert.equal(proof.coverage.coveredThrough, 15);
  assert.equal(proof.coverage.complete, true);
  assert.equal(proof.snapshots.length, 2);
  assert.ok(proof.snapshots.every((s) => s.committed && s.ok));
  assert.ok(proof.snapshots.every((s) => s.manifestHash && s.chunkHashes.length > 0));
  assert.match(proof.proofHash, /^[0-9a-f]{64}$/);
  assert.match(proof.delta.headHash, /^[0-9a-f]{64}$/);

  const v = store.verifyProof(dir, proof);
  assert.deepEqual(v, { valid: true, mismatches: [] });
});

test('proof survives JSON round-trip (independent command path)', () => {
  const dir = tmpdir();
  buildStore(dir);
  const proofFile = path.join(dir, 'proof.json');
  fs.writeFileSync(proofFile, JSON.stringify(store.check(dir), null, 2));
  const loaded = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  assert.equal(store.verifyProof(dir, loaded).valid, true);
});

test('tampered proof is rejected', () => {
  const dir = tmpdir();
  buildStore(dir);
  const proof = store.check(dir);
  const t1 = JSON.parse(JSON.stringify(proof));
  t1.trusted.baseSeq = 99;
  const v1 = store.verifyProof(dir, t1);
  assert.equal(v1.valid, false);
  assert.ok(v1.mismatches.includes('trusted'));
  const t2 = JSON.parse(JSON.stringify(proof));
  t2.proofHash = '0'.repeat(64);
  assert.equal(store.verifyProof(dir, t2).valid, false);
});

test('data changed after proof issuance -> proof no longer verifies', () => {
  const dir = tmpdir();
  buildStore(dir);
  const proof = store.check(dir);
  store.appendDelta(dir, { seq: 16, type: 'txn', ops: [{ account: 'c', delta: 1 }] });
  const v = store.verifyProof(dir, proof);
  assert.equal(v.valid, false);
  assert.ok(v.mismatches.includes('delta'));
});

test('check reports gaps and incomplete coverage', () => {
  const dir = tmpdir();
  store.appendDelta(dir, { seq: 1, type: 'txn', ops: [{ account: 'a', delta: 1 }] });
  fs.appendFileSync(path.join(dir, 'deltas.log'),
    store.canonical({ seq: 3, type: 'txn', ops: [{ account: 'a', delta: 1 }] }) + '\n');
  const proof = store.check(dir);
  assert.equal(proof.delta.contiguous, false);
  assert.deepEqual(proof.delta.gaps, [2]);
  assert.equal(proof.coverage.complete, false);
  assert.equal(proof.coverage.coveredThrough, 1);
});

test('check flags corrupt snapshot in proof', () => {
  const dir = tmpdir();
  buildStore(dir);
  fs.appendFileSync(path.join(dir, 'snapshots', 'seq-00000002', 'chunk-0000.json'), 'BAD');
  const proof = store.check(dir);
  const s2 = proof.snapshots.find((s) => s.seq === 2);
  assert.equal(s2.ok, false);
  assert.equal(s2.reason, 'chunk-corrupt');
  assert.equal(proof.trusted.snapshotSeq, 1, '可信点回退到快照1');
});
