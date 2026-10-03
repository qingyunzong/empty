import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, QuotaError } from '../src/store.js';
import { PositionalIndex, compressPositions, decompressPositions } from '../src/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
}

// Independent recursive summation over raw request records.
function independentRemaining(store, id) {
  const all = store.list();
  const byId = new Map(all.map((r) => [r.id, r]));
  const frozenSum = (rid) => {
    const r = byId.get(rid);
    let sum = r.state === 'active' ? r.amount : 0;
    for (const c of all.filter((x) => x.parentId === rid)) sum += frozenSum(c.id);
    return sum;
  };
  return byId.get(id).quota - frozenSum(id);
}

test('acceptance 1: three-level freeze chain balances match independent recursive sum', () => {
  const store = new Store(tmpDir());
  const r1 = store.freeze({ id: 'root', amount: 10, quota: 100, policyText: 'root policy' });
  const r2 = store.freeze({ id: 'mid', parentId: 'root', amount: 20, quota: 50, policyText: 'mid policy' });
  const r3 = store.freeze({ id: 'leaf', parentId: 'mid', amount: 15, quota: 30, policyText: 'leaf policy' });

  // Receipt levels reflect before/after balances on the chain.
  assert.deepEqual(
    r3.levels.map((l) => [l.id, l.before, l.after]),
    [
      ['root', 70, 55],
      ['mid', 30, 15],
    ]
  );
  assert.deepEqual(
    r3.occupancyChain.map((o) => [o.id, o.amount]),
    [
      ['root', 10],
      ['mid', 20],
      ['leaf', 15],
    ]
  );
  assert.equal(typeof r3.certificate.hash, 'string');
  assert.equal(r3.certificate.version, 3);

  // Every level's balance equals an independent recursive summation.
  for (const id of ['root', 'mid', 'leaf']) {
    assert.equal(store.balance(id).remaining, independentRemaining(store, id), `balance mismatch at ${id}`);
  }
  assert.equal(store.balance('root').remaining, 55);
  assert.equal(store.balance('mid').remaining, 15);
  assert.equal(store.balance('leaf').remaining, 15);

  // Balances stay consistent after restart (persistence).
  const reopened = new Store(store.dir);
  for (const id of ['root', 'mid', 'leaf']) {
    assert.equal(reopened.balance(id).remaining, independentRemaining(reopened, id));
  }
  assert.equal(reopened.balance('root').remaining, 55);
});

test('acceptance 2: expire hides phrase, restore revives it, purge is permanent across restart', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.freeze({ id: 'a', amount: 5, quota: 100, policyText: 'the quick brown fox jumps' });
  store.freeze({ id: 'b', amount: 5, quota: 100, policyText: 'quick brown eyes only' });

  // Exact phrase query works positionally.
  assert.deepEqual(store.query('quick brown fox'), ['a']);
  assert.deepEqual(store.query('brown fox'), ['a']);
  assert.deepEqual(store.query('brown quick'), []); // wrong order: no match
  assert.deepEqual(store.query('quick'), ['a', 'b']);

  // expire = logical delete: phrase no longer found.
  store.expire('a', 1);
  assert.deepEqual(store.query('quick brown fox'), []);
  assert.deepEqual(store.query('quick'), ['b']);
  assert.equal(store.get('a').state, 'expired');

  // Logical delete is recoverable.
  store.restore('a', 2);
  assert.deepEqual(store.query('quick brown fox'), ['a']);
  assert.equal(store.get('a').state, 'active');

  // purge = physical delete; unrecoverable, survives restart.
  store.expire('a', 3);
  const purged = store.purge();
  assert.deepEqual(purged.purged, ['a']);
  assert.equal(purged.segments, 1); // compressed segments merged into one
  assert.throws(() => store.get('a'), /not found/);
  assert.throws(() => store.restore('a', 4), (e) => e.code === 'NOT_FOUND');

  const segFiles = fs.readdirSync(path.join(dir, 'index')).filter((f) => f.startsWith('seg-'));
  assert.equal(segFiles.length, 1);

  const reopened = new Store(dir);
  assert.deepEqual(reopened.query('quick brown fox'), []);
  assert.deepEqual(reopened.query('quick'), ['b']);
  assert.throws(() => reopened.get('a'), /not found/);
  assert.throws(() => reopened.restore('a', 4), (e) => e.code === 'NOT_FOUND');
});

test('acceptance 3: over-quota, missing parent and stale-version writes fail without state change', () => {
  const store = new Store(tmpDir());
  store.freeze({ id: 'root', amount: 10, quota: 100, policyText: 'root' });
  store.freeze({ id: 'child', parentId: 'root', amount: 30, quota: 60, policyText: 'child' });
  // An expired parent, prepared before the snapshot.
  store.freeze({ id: 'tmp', amount: 1, quota: 10 });
  store.expire('tmp', 1);
  const snapshotBefore = store.list();
  const certBefore = store.certificate();

  // Over-quota freeze rejected (root remaining = 60, child remaining = 30).
  assert.throws(
    () => store.freeze({ id: 'big', parentId: 'child', amount: 31, quota: 100 }),
    (e) => e.code === 'QUOTA_EXCEEDED'
  );
  // Over-quota update rejected.
  assert.throws(() => store.update('child', 1, { amount: 61 }), (e) => e.code === 'QUOTA_EXCEEDED');
  // Missing parent rejected.
  assert.throws(
    () => store.freeze({ id: 'orphan', parentId: 'ghost', amount: 1, quota: 10 }),
    (e) => e.code === 'PARENT_NOT_FOUND'
  );
  // Expired parent rejected.
  assert.throws(
    () => store.freeze({ id: 'orphan2', parentId: 'tmp', amount: 1, quota: 10 }),
    (e) => e.code === 'PARENT_NOT_ACTIVE'
  );
  // Stale version writes rejected.
  assert.throws(() => store.expire('child', 99), (e) => e.code === 'STALE_VERSION');
  assert.throws(() => store.update('child', 0, { amount: 5 }), (e) => e.code === 'STALE_VERSION');
  assert.throws(() => store.restore('tmp', 1), (e) => e.code === 'STALE_VERSION');

  // State unchanged: same records, same versions, same balances, same cert chain head.
  assert.deepEqual(store.list(), snapshotBefore);
  assert.equal(store.balance('root').remaining, 60);
  assert.equal(store.balance('child').remaining, 30);
  assert.deepEqual(store.certificate(), certBefore);
});

test('version certificates chain monotonically and stale writes do not advance it', () => {
  const store = new Store(tmpDir());
  const r1 = store.freeze({ id: 'x', amount: 1, quota: 10 });
  const r2 = store.update('x', 1, { policyText: 'hello world' });
  const r3 = store.expire('x', 2);
  assert.ok(r1.certificate.version < r2.certificate.version);
  assert.ok(r2.certificate.version < r3.certificate.version);
  assert.notEqual(r1.certificate.hash, r2.certificate.hash);
  assert.throws(() => store.restore('x', 2), (e) => e.code === 'STALE_VERSION');
  assert.equal(store.certificate().version, r3.certificate.version);
  const r4 = store.restore('x', 3);
  assert.equal(store.certificate().hash, r4.certificate.hash);
});

test('compressed positional index round-trips and matches phrases exactly', () => {
  const positions = [0, 3, 3, 17, 250, 40000];
  assert.deepEqual(decompressPositions(compressPositions(positions)), [...positions].sort((a, b) => a - b));

  const idx = new PositionalIndex();
  idx.add('d1', 'alpha beta gamma beta');
  idx.add('d2', 'alpha beta');
  idx.add('d3', 'beta alpha gamma');
  assert.deepEqual(idx.search('alpha beta'), ['d1', 'd2']);
  assert.deepEqual(idx.search('beta gamma'), ['d1']);
  assert.deepEqual(idx.search('gamma beta'), ['d1']);
  assert.deepEqual(idx.search('beta beta'), []);
  assert.deepEqual(idx.search('alpha gamma'), ['d3']); // consecutive at positions 1,2
  assert.deepEqual(idx.search('gamma alpha'), []); // wrong order: no match
  idx.remove('d1');
  assert.deepEqual(idx.search('alpha beta'), ['d2']);

  // Segment serialization round-trip.
  const seg = idx.toSegment([{ id: 'd2', text: 'alpha beta' }]);
  const idx2 = new PositionalIndex();
  idx2.applySegment(seg);
  assert.deepEqual(idx2.search('alpha beta'), ['d2']);
});

test('expired requests stop consuming quota; restore re-validates constraints', () => {
  const store = new Store(tmpDir());
  store.freeze({ id: 'root', amount: 0.5, quota: 10 });
  store.freeze({ id: 'c1', parentId: 'root', amount: 6, quota: 8 });
  // root remaining = 3.5; freezing 4 would fail...
  assert.throws(() => store.freeze({ id: 'c2', parentId: 'root', amount: 4, quota: 5 }), (e) => e.code === 'QUOTA_EXCEEDED');
  // ...until c1 is expired (logical delete frees its consumption).
  store.expire('c1', 1);
  assert.equal(store.balance('root').remaining, 9.5);
  store.freeze({ id: 'c2', parentId: 'root', amount: 4, quota: 5 });
  // Restoring c1 now would exceed root quota -> rejected.
  assert.throws(() => store.restore('c1', 2), (e) => e.code === 'QUOTA_EXCEEDED');
  store.expire('c2', 1);
  const receipt = store.restore('c1', 2);
  assert.equal(store.balance('root').remaining, 3.5);
  assert.equal(receipt.levels.find((l) => l.id === 'root').after, 3.5);
});
