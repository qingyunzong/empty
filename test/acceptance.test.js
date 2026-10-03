import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditDB } from '../src/db.js';
import { AuditError, E_TIME_ORDER, E_TOMBSTONE } from '../src/errors.js';

const T = (s) => `2024-${s}T00:00:00.000Z`;

test('A: backfilled correction rewrites historical report, old tx view preserved', () => {
  const db = new AuditDB();
  db.load([
    { id: 'e1', account: 'accA', validFrom: T('03-01'), validTo: null, txSeq: 1,
      payload: { amount: 100, limit: 10 } },
  ]);
  // Before correction: nothing valid in February.
  assert.equal(db.asOf('accA', T('02-15'), 1).balance, 0);
  assert.equal(db.asOf('accA', T('02-15'), 1).count, 0);

  // Correction recorded later (txSeq 2) moves validFrom back to January.
  db.load([
    { id: 'e2', account: 'accA', validFrom: T('01-01'), validTo: null, txSeq: 2,
      payload: { amount: 150, limit: 25 }, supersedes: 'e1' },
  ]);

  // Historical report as of tx 2 now shows the corrected past.
  const after = db.asOf('accA', T('02-15'), 2);
  assert.equal(after.balance, 150);
  assert.equal(after.limit, 25);
  assert.equal(after.count, 1);
  assert.deepEqual(after.versions, ['e2']);

  // The pre-correction transaction-time view is untouched (append-only).
  const before = db.asOf('accA', T('02-15'), 1);
  assert.equal(before.balance, 0);
  assert.equal(before.count, 0);
  // Old version still stored in the log.
  assert.equal(db.events.length, 2);
  assert.equal(db.events[0].id, 'e1');
});

test('B: tombstone deletes from later views, old asOf still visible and auditable', () => {
  const db = new AuditDB();
  db.load([
    { id: 'e1', account: 'accB', validFrom: T('01-01'), validTo: null, txSeq: 1,
      payload: { amount: 50, limit: 5 } },
    { id: 'e2', account: 'accB', validFrom: T('01-01'), validTo: null, txSeq: 2,
      supersedes: 'e1', tombstone: true },
  ]);

  // After the delete (tx 2): account is empty.
  const deleted = db.asOf('accB', T('06-01'), 2);
  assert.equal(deleted.count, 0);
  assert.equal(deleted.balance, 0);

  // Old asOf (tx 1) still sees the version: tombstone is itself an audit record.
  const before = db.asOf('accB', T('06-01'), 1);
  assert.equal(before.balance, 50);
  assert.equal(before.limit, 5);
  assert.deepEqual(before.versions, ['e1']);

  // The tombstone is auditable: both records remain in the append-only log.
  assert.equal(db.events.length, 2);
  assert.equal(db.events[1].tombstone, true);
  assert.equal(db.events[1].supersedes, 'e1');
});

test('D: NULL validTo is open-ended; validFrom inclusive, validTo exclusive', () => {
  const db = new AuditDB();
  db.load([
    { id: 'open', account: 'accD', validFrom: T('01-01'), validTo: null, txSeq: 1,
      payload: { amount: 1 } },
    { id: 'closed', account: 'accD', validFrom: T('02-01'), validTo: T('03-01'), txSeq: 2,
      payload: { amount: 10 } },
  ]);

  // NULL validTo: visible at validFrom boundary and arbitrarily far in the future.
  assert.equal(db.asOf('accD', T('01-01'), 2).balance, 1);
  assert.equal(db.asOf('accD', '2099-12-31T00:00:00.000Z', 2).balance, 1);

  // Closed interval: inclusive start, exclusive end.
  assert.equal(db.asOf('accD', T('02-01'), 2).balance, 11);
  assert.equal(db.asOf('accD', '2024-02-28T23:59:59.999Z', 2).balance, 11);
  assert.equal(db.asOf('accD', T('03-01'), 2).balance, 1);

  // NULL validTo can still be closed by a later correction.
  db.load([
    { id: 'open-fix', account: 'accD', validFrom: T('01-01'), validTo: T('01-15'), txSeq: 3,
      payload: { amount: 2 }, supersedes: 'open' },
  ]);
  assert.equal(db.asOf('accD', '2099-12-31T00:00:00.000Z', 3).balance, 0);
  assert.equal(db.asOf('accD', T('01-10'), 3).balance, 2);
  // ...but the old tx view still sees the open interval.
  assert.equal(db.asOf('accD', '2099-12-31T00:00:00.000Z', 1).balance, 1);
});

test('sum ignores NULL amount, count counts versions', () => {
  const db = new AuditDB();
  db.load([
    { id: 'a', account: 'accN', validFrom: T('01-01'), validTo: null, txSeq: 1,
      payload: { amount: null, limit: 3 } },
    { id: 'b', account: 'accN', validFrom: T('01-01'), validTo: null, txSeq: 2,
      payload: { amount: 7, limit: null } },
    { id: 'c', account: 'accN', validFrom: T('01-01'), validTo: null, txSeq: 3,
      payload: null },
  ]);
  const r = db.asOf('accN', T('06-01'), 3);
  assert.equal(r.balance, 7);
  assert.equal(r.limit, 3);
  assert.equal(r.count, 3);
});

test('E_TIME_ORDER: validTo must be strictly after validFrom', () => {
  const db = new AuditDB();
  assert.throws(
    () => db.load([{ id: 'x', account: 'a', validFrom: T('02-01'), validTo: T('01-01'), txSeq: 1 }]),
    (err) => err instanceof AuditError && err.code === E_TIME_ORDER,
  );
  // Equal bounds are an empty interval -> also rejected.
  assert.throws(
    () => db.load([{ id: 'x', account: 'a', validFrom: T('01-01'), validTo: T('01-01'), txSeq: 1 }]),
    (err) => err.code === E_TIME_ORDER,
  );
});

test('E_TIME_ORDER: txSeq must be strictly increasing (append-only system time)', () => {
  const db = new AuditDB();
  db.load([{ id: 'a', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 5 }]);
  assert.throws(
    () => db.load([{ id: 'b', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 5 }]),
    (err) => err.code === E_TIME_ORDER,
  );
  assert.throws(
    () => db.load([{ id: 'c', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 2 }]),
    (err) => err.code === E_TIME_ORDER,
  );
});

test('E_TOMBSTONE: cannot supersede a tombstone; deletes are final', () => {
  const db = new AuditDB();
  db.load([
    { id: 'e1', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 1, payload: { amount: 1 } },
    { id: 'del', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 2,
      supersedes: 'e1', tombstone: true },
  ]);
  // Correcting a tombstone is rejected.
  assert.throws(
    () => db.load([{ id: 'e2', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 3,
      payload: { amount: 2 }, supersedes: 'del' }]),
    (err) => err instanceof AuditError && err.code === E_TOMBSTONE,
  );
  // Double delete is rejected.
  assert.throws(
    () => db.load([{ id: 'del2', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 3,
      supersedes: 'del', tombstone: true }]),
    (err) => err.code === E_TOMBSTONE,
  );
  // Tombstone without supersedes is rejected.
  assert.throws(
    () => db.load([{ id: 'del3', account: 'a', validFrom: T('01-01'), validTo: null, txSeq: 3,
      tombstone: true }]),
    (err) => err.code === E_TOMBSTONE,
  );
});

test('indexed asOf never scans other accounts and matches per-account chains', () => {
  const db = new AuditDB();
  db.load([
    { id: 'x1', account: 'one', validFrom: T('01-01'), validTo: null, txSeq: 1, payload: { amount: 1 } },
    { id: 'y1', account: 'two', validFrom: T('01-01'), validTo: null, txSeq: 2, payload: { amount: 2 } },
  ]);
  assert.equal(db.asOf('one', T('06-01'), 2).balance, 1);
  assert.equal(db.asOf('two', T('06-01'), 2).balance, 2);
  assert.equal(db.asOf('ghost', T('06-01'), 2).count, 0);
});
