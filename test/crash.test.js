import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../src/db.js';
import { CorruptionError } from '../src/errors.js';
import { tmpdir } from './helpers.js';

// Acceptance 2a: top-level transaction dies before the commit marker is
// written -> after restart no partial batch is visible.
test('crash before commit marker: tentative changes invisible after restart', () => {
  const dir = tmpdir();
  const db = Database.open(dir);
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 40 }] });
  db.close(); // process ends without commit

  const reopened = Database.open(dir);
  assert.deepEqual(reopened.snapshot(), []);
  reopened.close();
});

test('crash during commit, before the marker: partial WAL records ignored', () => {
  const dir = tmpdir();
  const db = Database.open(dir, {
    hooks: {
      beforeCommitMarker() {
        throw new Error('simulated crash');
      },
    },
  });
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 40 }] });
  assert.throws(() => db.commit(), /simulated crash/);
  db.close();

  // WAL now contains op records but no commit marker.
  const wal = fs.readFileSync(path.join(dir, 'wal.log'), 'utf8');
  assert.ok(wal.includes('"type":"op"') && !wal.includes('"type":"commit"'));

  const reopened = Database.open(dir);
  assert.deepEqual(reopened.snapshot(), []);
  reopened.close();
});

// Acceptance 2b: commit marker written, then crash -> redo rebuilds the full
// lineage and both index directions.
test('crash after commit marker: redo restores complete lineage and indexes', () => {
  const dir = tmpdir();
  const db = Database.open(dir, {
    hooks: {
      afterCommitMarker() {
        throw new Error('simulated crash');
      },
    },
  });
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.create({ id: 'M', weight: 50 });
  db.split({ parents: ['A', 'M'], children: [{ id: 'B', weight: 80 }, { id: 'C', weight: 60 }] });
  db.setStatus({ id: 'B', status: 'passed' });
  let committed;
  assert.throws(() => {
    committed = db.commit();
  }, /simulated crash/);
  db.close();

  const reopened = Database.open(dir);
  assert.deepEqual(reopened.children('A').sort(), ['B', 'C']);
  assert.deepEqual(reopened.children('M').sort(), ['B', 'C']);
  assert.deepEqual(reopened.parents('B'), ['A', 'M']);
  assert.deepEqual(reopened.ancestors('C'), ['A', 'M']);
  assert.deepEqual(reopened.descendants('A').sort(), ['B', 'C']);
  assert.equal(reopened.get('A').consumed + reopened.get('M').consumed, 140);
  assert.equal(reopened.get('B').status, 'passed');
  // Certificates recomputed after redo match a clean in-memory computation.
  const certs = reopened.snapshot().map((b) => [b.id, reopened.certificate(b.id)]);
  assert.equal(certs.length, 4);
  reopened.close();

  // A third open is stable (idempotent redo).
  const again = Database.open(dir);
  assert.deepEqual(
    again.snapshot().map((b) => [b.id, again.certificate(b.id)]),
    certs,
  );
  again.close();
});

test('torn tail write is truncated, committed data survives', () => {
  const dir = tmpdir();
  const db = Database.open(dir);
  db.begin();
  db.create({ id: 'A', weight: 10 });
  db.commit();
  db.close();

  fs.appendFileSync(path.join(dir, 'wal.log'), 'deadbeef{"txid":2,"type":"com'); // torn write
  const reopened = Database.open(dir);
  assert.deepEqual(reopened.snapshot().map((b) => b.id), ['A']);
  reopened.close();
  // Tail was truncated; a new commit can proceed.
  const db2 = Database.open(dir);
  db2.begin();
  db2.create({ id: 'B', weight: 5 });
  db2.commit();
  db2.close();
  const db3 = Database.open(dir);
  assert.deepEqual(db3.snapshot().map((b) => b.id), ['A', 'B']);
  db3.close();
});

test('corruption in the middle of the WAL is a CorruptionError', () => {
  const dir = tmpdir();
  const db = Database.open(dir);
  db.begin();
  db.create({ id: 'A', weight: 10 });
  db.commit();
  db.begin();
  db.create({ id: 'B', weight: 5 });
  db.commit();
  db.close();

  const walPath = path.join(dir, 'wal.log');
  const wal = fs.readFileSync(walPath, 'utf8');
  const lines = wal.split('\n');
  lines[0] = lines[0].replace('"weight":10', '"weight":11'); // checksum now invalid, not the tail
  fs.writeFileSync(walPath, lines.join('\n'));
  assert.throws(() => Database.open(dir), CorruptionError);
});
