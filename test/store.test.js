import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, verify, GENESIS_HASH, WAL_FILE } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-audit-test-'));
}

test('acceptance 1: three commits verify; as-of queries match snapshot visibility', async () => {
  const dir = tmpdir();
  const store = Store.open(dir);

  const c1 = await store.commit({ type: 'payment', id: 't1', party: 'alice', amount: 100, currency: 'USD' });
  const c2 = await store.commit({ type: 'settlement', id: 't2', party: 'alice', amount: -40, currency: 'USD' });
  const c3 = await store.commit({ type: 'reversal', ref: 't1' });

  // Certificate chain: version, parent, snapshot, prevHash linkage.
  assert.equal(c1.version, 1);
  assert.equal(c1.parentVersion, 0);
  assert.equal(c1.prevHash, GENESIS_HASH);
  assert.equal(c2.prevHash, c1.digest);
  assert.equal(c3.prevHash, c2.digest);
  assert.equal(c3.snapshotVersion, 2);
  assert.match(c3.opHash, /^[0-9a-f]{64}$/);
  assert.match(c3.digest, /^[0-9a-f]{64}$/);

  const result = verify(dir);
  assert.deepEqual(result.ok, true);
  assert.equal(result.versions, 3);
  assert.equal(result.head, c3.digest);

  // As-of visibility per version.
  assert.equal(store.getAt('t1', 1).status, 'active');
  assert.equal(store.getAt('t2', 1), null);
  assert.equal(store.getAt('t1', 2).status, 'active');
  assert.equal(store.getAt('t2', 2).status, 'active');
  assert.equal(store.getAt('t1', 3).status, 'reversed');
  assert.equal(store.getAt('t1', 3).reversedBy, 'rev:t1');
  // Reversal is a reverse entry: negated amount, same party/currency.
  const rev = store.getAt('rev:t1', 3);
  assert.equal(rev.amount, -100);
  assert.equal(rev.party, 'alice');
  assert.equal(rev.ref, 't1');
  assert.equal(store.getAt('rev:t1', 2), null);

  // Party secondary index, as-of.
  assert.deepEqual(store.auditParty('alice', 1).map((r) => r.id), ['t1']);
  assert.deepEqual(store.auditParty('alice', 2).map((r) => r.id), ['t1', 't2']);
  assert.deepEqual(store.auditParty('alice', 3).map((r) => r.id), ['rev:t1', 't1', 't2']);
  assert.deepEqual(store.auditParty('nobody', 3), []);

  // Reopen from disk: MVCC state rebuilt from WAL, old versions still queryable.
  store.close();
  const reopened = Store.open(dir);
  assert.equal(reopened.head, 3);
  assert.equal(reopened.getAt('t1', 1).status, 'active');
  assert.equal(reopened.getAt('t1', 3).status, 'reversed');
  assert.deepEqual(reopened.auditParty('alice', 2).map((r) => r.id), ['t1', 't2']);
  reopened.close();
});

test('acceptance 2: concurrent reversals — one commits, one E_CONFLICT, chain stays continuous', async () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const c1 = await store.commit({ type: 'payment', id: 't1', party: 'bob', amount: 200, currency: 'EUR' });

  const snapA = store.begin();
  const snapB = store.begin();
  const settled = await Promise.allSettled([
    store.commit({ type: 'reversal', ref: 't1', id: 'r-a' }, snapA),
    store.commit({ type: 'reversal', ref: 't1', id: 'r-b' }, snapB),
  ]);
  const ok = settled.filter((s) => s.status === 'fulfilled');
  const failed = settled.filter((s) => s.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'E_CONFLICT');
  assert.equal(ok[0].value.version, 2);
  assert.equal(ok[0].value.prevHash, c1.digest);

  // Failed commit appended nothing; head advanced by exactly one.
  assert.equal(store.head, 2);
  assert.equal(verify(dir).ok, true);

  // Chain remains continuous: next commit links to the surviving certificate.
  const c3 = await store.commit({ type: 'payment', id: 't3', party: 'bob', amount: 5, currency: 'EUR' });
  assert.equal(c3.parentVersion, 2);
  assert.equal(c3.prevHash, ok[0].value.digest);
  const result = verify(dir);
  assert.equal(result.ok, true);
  assert.equal(result.versions, 3);

  // Sequential double reversal on a fresh snapshot is rejected as a state error.
  await assert.rejects(
    store.commit({ type: 'reversal', ref: 't1', id: 'r-c' }),
    (err) => err.code === 'E_STATE',
  );
  store.close();
});

test('acceptance 3: tampered WAL amount in a copied dir yields E_TAMPER at first mismatched seq', async () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  await store.commit({ type: 'payment', id: 't1', party: 'alice', amount: 100, currency: 'USD' });
  await store.commit({ type: 'payment', id: 't2', party: 'alice', amount: 200, currency: 'USD' });
  await store.commit({ type: 'reversal', ref: 't1' });
  store.close();

  const copy = tmpdir();
  fs.cpSync(dir, copy, { recursive: true });
  const walPath = path.join(copy, WAL_FILE);
  const lines = fs.readFileSync(walPath, 'utf8').split('\n').filter((l) => l.length > 0);
  const rec = JSON.parse(lines[1]);
  rec.op.amount = 999; // tamper with seq 2
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(walPath, lines.join('\n') + '\n');

  const result = verify(copy);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_TAMPER');
  assert.equal(result.seq, 2);
  assert.equal(result.field, 'opHash');

  // Tampering the first record is located at seq 1.
  const copy1 = tmpdir();
  fs.cpSync(dir, copy1, { recursive: true });
  const wal1 = path.join(copy1, WAL_FILE);
  const lines1 = fs.readFileSync(wal1, 'utf8').split('\n').filter((l) => l.length > 0);
  const rec1 = JSON.parse(lines1[0]);
  rec1.op.amount = 1;
  lines1[0] = JSON.stringify(rec1);
  fs.writeFileSync(wal1, lines1.join('\n') + '\n');
  const result1 = verify(copy1);
  assert.equal(result1.code, 'E_TAMPER');
  assert.equal(result1.seq, 1);

  // Original directory is untouched and still verifies.
  assert.equal(verify(dir).ok, true);
});
