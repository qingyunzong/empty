import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Replica,
  diffSnapshots,
  verifyCertificate,
  normalizeRemoteState,
  CONFLICT_RESOLVE_DELETE,
} from '../src/replica.js';

function syncedPair() {
  const a = new Replica('a');
  const b = new Replica('b');
  a.upsert('r1', 100, 100);
  a.upsert('r3', 30, 30);
  b.merge(a.state);
  a.merge(b.state);
  return { a, b };
}

test('acceptance 1: diff finds missing record and missing tombstone, repair converges', () => {
  const { a, b } = syncedPair();
  a.upsert('r2', 50, 45);
  a.delete('r3');

  const diff = diffSnapshots(b.snapshot(), a.snapshot());
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.missingRecords, ['r2']);
  assert.deepEqual(diff.missingTombstones, ['r3']);

  b.merge(a.state);
  assert.equal(a.digest(), b.digest());
  assert.equal(a.epoch(), b.epoch());
  assert.equal(diffSnapshots(a.snapshot(), b.snapshot()).equal, true);

  const certA = a.snapshot().certificate;
  const certB = b.snapshot().certificate;
  assert.equal(certA.valid, true);
  assert.equal(certB.valid, true);
  assert.ok(verifyCertificate(certA));
  assert.ok(verifyCertificate(certB));
  assert.equal(certA.digest, certB.digest);
  assert.equal(certA.epoch, certB.epoch);
});

test('acceptance 2: stale replay of a deleted record is rejected, never resurrected', () => {
  const { a, b } = syncedPair();
  a.delete('r1');
  // b has not observed the tombstone and re-adds r1.
  b.upsert('r1', 100, 100);

  const applied = a.merge(b.state);
  assert.deepEqual(applied.stale, ['r1']);
  // Stale record rejected: tombstone intact, no resurrection.
  assert.equal(a.state.records.r1, undefined);
  assert.ok(a.state.tombstones.r1);

  // Anti-entropy in the other direction heals b instead.
  b.merge(a.state);
  assert.equal(b.state.records.r1, undefined);
  assert.ok(b.state.tombstones.r1);
  assert.equal(a.digest(), b.digest());
});

test('acceptance 3: concurrent resolve and delete conflict, certificate invalid', () => {
  const { a, b } = syncedPair();
  a.resolve('r1');
  b.delete('r1');

  a.merge(b.state);
  b.merge(a.state);

  for (const replica of [a, b]) {
    assert.deepEqual(replica.conflictList(), [{ id: 'r1', reason: CONFLICT_RESOLVE_DELETE }]);
    // Delete wins the data, but the conflict is recorded.
    assert.equal(replica.state.records.r1, undefined);
    assert.ok(replica.state.tombstones.r1);
    const cert = replica.snapshot().certificate;
    assert.equal(cert.valid, false);
    // The certificate is still structurally verifiable (self-consistent).
    assert.ok(verifyCertificate(cert));
  }
  assert.equal(a.digest(), b.digest());
});

test('re-create after observing the tombstone is allowed and propagates', () => {
  const { a, b } = syncedPair();
  a.delete('r1');
  a.upsert('r1', 120, 120); // observes the tombstone: legitimate re-create
  b.merge(a.state);
  assert.equal(b.state.tombstones.r1, undefined);
  assert.equal(b.state.records.r1.amountA, 120);
  assert.equal(a.digest(), b.digest());
  assert.equal(b.snapshot().certificate.valid, true);
});

test('resolve/delete of unknown id raises not-found', () => {
  const a = new Replica('a');
  assert.throws(() => a.resolve('nope'), (err) => err.code === 'not-found');
  assert.throws(() => a.delete('nope'), (err) => err.code === 'not-found');
});

test('delete is idempotent and tombstones merge', () => {
  const { a, b } = syncedPair();
  a.delete('r3');
  b.delete('r3'); // concurrent deletes of the same record
  a.merge(b.state);
  b.merge(a.state);
  assert.equal(a.digest(), b.digest());
  assert.deepEqual(a.state.tombstones.r3.vv, b.state.tombstones.r3.vv);
  assert.equal(a.snapshot().certificate.valid, true);
});

test('epoch and digest are stable for identical snapshots', () => {
  const { a, b } = syncedPair();
  const s1 = a.snapshot();
  const s2 = a.snapshot();
  assert.deepEqual(s1, s2);
  assert.equal(a.digest(), b.digest());
});

test('verifyCertificate rejects tampered certificates', () => {
  const { a } = syncedPair();
  const cert = a.snapshot().certificate;
  assert.ok(verifyCertificate(cert));
  const tampered = structuredClone(cert);
  tampered.leaves[0].data.amountA += 1;
  assert.equal(verifyCertificate(tampered), false);
  const reordered = structuredClone(cert);
  reordered.leaves.reverse();
  assert.equal(verifyCertificate(reordered), false);
  const flagged = structuredClone(cert);
  flagged.valid = false;
  assert.equal(verifyCertificate(flagged), false);
});

test('normalizeRemoteState accepts snapshot files as merge input', () => {
  const { a, b } = syncedPair();
  a.upsert('r9', 9, 9);
  const remote = normalizeRemoteState(a.snapshot());
  b.merge(remote);
  assert.equal(b.state.records.r9.amountA, 9);
  assert.equal(a.digest(), b.digest());
});
