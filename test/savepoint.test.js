import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db.js';
import { tmpdir } from './helpers.js';

// Acceptance 1: inner split rolled back -> parent weight and child index
// restored; other outer modifications preserved.
test('rollback to inner savepoint restores weight and child index, keeps outer changes', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.setStatus({ id: 'A', status: 'passed' }); // outer modification
  db.savepoint('sp1');
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 40 }] });
  db.savepoint('sp2');
  db.split({ parents: ['A'], children: [{ id: 'C', weight: 30 }] });
  assert.deepEqual(db.children('A'), ['B', 'C']);
  assert.equal(db.get('A').effective, 30);

  db.rollbackTo('sp2'); // undo the inner split only
  assert.deepEqual(db.children('A'), ['B']);
  assert.equal(db.get('A').effective, 60);
  assert.throws(() => db.get('C'), /unknown batch/);

  db.split({ parents: ['A'], children: [{ id: 'D', weight: 50 }] }); // outer txn continues
  const { certificates } = db.commit();

  assert.equal(db.get('A').status, 'passed'); // outer modification kept
  assert.equal(db.get('A').consumed, 90);
  assert.deepEqual(db.children('A'), ['B', 'D']);
  assert.deepEqual(db.parents('B'), ['A']);
  assert.deepEqual(db.ancestors('D'), ['A']);
  assert.throws(() => db.get('C'), /unknown batch/);
  assert.ok(certificates.A && certificates.B && certificates.D && !certificates.C);
  db.close();
});

test('release drops the boundary but keeps modifications', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.savepoint('sp1');
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 40 }] });
  db.release('sp1');
  db.commit();
  assert.deepEqual(db.children('A'), ['B']); // change survived the release
  assert.equal(db.get('A').effective, 60);
  db.close();
});

test('release removes savepoints nested after it', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.savepoint('outer');
  db.savepoint('inner');
  db.release('outer');
  assert.throws(() => db.rollbackTo('inner'), /unknown savepoint/);
  assert.throws(() => db.rollbackTo('outer'), /unknown savepoint/);
  db.abort();
  db.close();
});

test('rollback keeps the named savepoint reusable and drops later ones', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.savepoint('sp');
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 10 }] });
  db.savepoint('later');
  db.rollbackTo('sp');
  assert.throws(() => db.rollbackTo('later'), /unknown savepoint/);
  db.split({ parents: ['A'], children: [{ id: 'C', weight: 20 }] });
  db.rollbackTo('sp'); // named savepoint still usable
  assert.deepEqual(db.children('A'), []);
  assert.equal(db.get('A').effective, 100);
  db.commit();
  db.close();
});

test('rollback to unknown savepoint is a business error', () => {
  const db = Database.open(tmpdir());
  db.begin();
  assert.throws(() => db.rollbackTo('nope'), /unknown savepoint/);
  assert.throws(() => db.release('nope'), /unknown savepoint/);
  db.abort();
  db.close();
});
