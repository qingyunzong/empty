import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditStore, AuditError,
  E_TIME_ORDER, E_TOMBSTONE, E_TX_SEQ,
} from '../src/auditdb.js';

// --- Acceptance A: backfilled correction changes the historical report -----
test('A: backfilled correction rewrites history as of later txSeq', () => {
  const s = new AuditStore();
  s.append({ id: 'e1', account: 'acc', txSeq: 1, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 100, limit: 10 } });
  // Correction arrives later (txSeq 2) but backfills validFrom into the past.
  s.append({ id: 'e2', account: 'acc', txSeq: 2, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 250, limit: 10 }, supersedes: 'e1' });

  // Same valid time, different tx knowledge => different historical report.
  assert.deepEqual(s.asOf('acc', '2024-06-01T00:00:00Z', 1), { balance: 100, limitUsed: 10, versions: 1 });
  assert.deepEqual(s.asOf('acc', '2024-06-01T00:00:00Z', 2), { balance: 250, limitUsed: 10, versions: 1 });
  // Old version retained in the append-only log.
  assert.equal(s.events.length, 2);
  assert.equal(s.byId.get('e1').payload.amount, 100);
});

// --- Acceptance B: tombstone deletes going forward, old asOf still visible --
test('B: tombstone hides current view but old asOf remains visible', () => {
  const s = new AuditStore();
  s.append({ id: 'e1', account: 'acc', txSeq: 1, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 100 } });
  s.append({ id: 't1', account: 'acc', txSeq: 2, tombstone: true, supersedes: 'e1' });

  // Before the tombstone's txSeq the version is still visible.
  assert.deepEqual(s.asOf('acc', '2024-06-01T00:00:00Z', 1), { balance: 100, limitUsed: 0, versions: 1 });
  // At/after the tombstone the fact is gone — but the log keeps both rows.
  assert.deepEqual(s.asOf('acc', '2024-06-01T00:00:00Z', 2), { balance: 0, limitUsed: 0, versions: 0 });
  assert.equal(s.events.length, 2);
  assert.equal(s.byId.get('e1').tombstone, false);
});

// --- Acceptance D: NULL validTo boundary semantics --------------------------
test('D: NULL validTo is open-ended; validTo is exclusive', () => {
  const s = new AuditStore();
  s.append({ id: 'open', account: 'a', txSeq: 1, validFrom: '2024-03-01T00:00:00Z', validTo: null, payload: { amount: 5 } });
  s.append({ id: 'closed', account: 'b', txSeq: 2, validFrom: '2024-03-01T00:00:00Z', validTo: '2024-04-01T00:00:00Z', payload: { amount: 7 } });

  // NULL validTo: visible arbitrarily far into the future.
  assert.equal(s.asOf('a', '2099-12-31T23:59:59Z', 99).balance, 5);
  // Not visible before validFrom.
  assert.equal(s.asOf('a', '2024-02-28T23:59:59.999Z', 99).versions, 0);
  // validFrom is inclusive.
  assert.equal(s.asOf('b', '2024-03-01T00:00:00Z', 99).balance, 7);
  // validTo is exclusive.
  assert.equal(s.asOf('b', '2024-04-01T00:00:00Z', 99).versions, 0);
  assert.equal(s.asOf('b', '2024-03-31T23:59:59.999Z', 99).balance, 7);
});

// --- Aggregates: sum ignores NULL amount, count counts versions -------------
test('aggregates: NULL amount skipped by sum, counted by versions', () => {
  const s = new AuditStore();
  s.append({ id: 'e1', account: 'acc', txSeq: 1, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 10, limit: 3 } });
  s.append({ id: 'e2', account: 'acc', txSeq: 2, validFrom: '2024-01-02T00:00:00Z', validTo: null, payload: { amount: null } });
  s.append({ id: 'e3', account: 'acc', txSeq: 3, validFrom: '2024-01-03T00:00:00Z', validTo: null, payload: {} });
  const r = s.asOf('acc', '2024-06-01T00:00:00Z', 99);
  assert.deepEqual(r, { balance: 10, limitUsed: 3, versions: 3 });
});

// --- Error codes -------------------------------------------------------------
test('E_TIME_ORDER: validTo must be after validFrom', () => {
  const s = new AuditStore();
  assert.throws(
    () => s.append({ id: 'bad', account: 'a', txSeq: 1, validFrom: '2024-05-01T00:00:00Z', validTo: '2024-05-01T00:00:00Z' }),
    (e) => e instanceof AuditError && e.code === E_TIME_ORDER,
  );
  assert.throws(
    () => s.append({ id: 'bad2', account: 'a', txSeq: 1, validFrom: '2024-05-02T00:00:00Z', validTo: '2024-05-01T00:00:00Z' }),
    (e) => e.code === E_TIME_ORDER,
  );
});

test('E_TOMBSTONE: invalid delete requests rejected, log untouched', () => {
  const s = new AuditStore();
  s.append({ id: 'e1', account: 'a', txSeq: 1, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 1 } });
  // Tombstone without supersedes.
  assert.throws(() => s.append({ id: 't1', account: 'a', txSeq: 2, tombstone: true }), (e) => e.code === E_TOMBSTONE);
  // Tombstone of unknown id.
  assert.throws(() => s.append({ id: 't2', account: 'a', txSeq: 2, tombstone: true, supersedes: 'nope' }), (e) => e.code === E_TOMBSTONE);
  // Valid tombstone, then double-delete and superseding a tombstone.
  s.append({ id: 't3', account: 'a', txSeq: 2, tombstone: true, supersedes: 'e1' });
  assert.throws(() => s.append({ id: 't4', account: 'a', txSeq: 3, tombstone: true, supersedes: 'e1' }), (e) => e.code === E_TOMBSTONE);
  assert.throws(() => s.append({ id: 'e9', account: 'a', txSeq: 3, validFrom: '2024-01-01T00:00:00Z', validTo: null, supersedes: 't3' }), (e) => e.code === E_TOMBSTONE);
  // Failed appends never entered the log.
  assert.equal(s.events.length, 2);
});

test('E_TX_SEQ: txSeq must strictly increase', () => {
  const s = new AuditStore();
  s.append({ id: 'e1', account: 'a', txSeq: 5, validFrom: '2024-01-01T00:00:00Z', validTo: null });
  assert.throws(
    () => s.append({ id: 'e2', account: 'a', txSeq: 5, validFrom: '2024-01-01T00:00:00Z', validTo: null }),
    (e) => e.code === E_TX_SEQ,
  );
});

test('persistence round-trip keeps index and semantics', () => {
  const s = new AuditStore();
  s.append({ id: 'e1', account: 'a', txSeq: 1, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 42 } });
  s.append({ id: 'e2', account: 'a', txSeq: 2, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 43 }, supersedes: 'e1' });
  const restored = AuditStore.fromJSON(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(restored.asOf('a', '2024-06-01T00:00:00Z', 2), { balance: 43, limitUsed: 0, versions: 1 });
  assert.deepEqual(restored.asOf('a', '2024-06-01T00:00:00Z', 1), { balance: 42, limitUsed: 0, versions: 1 });
});
