import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tmpdir } from './helpers.js';

// Acceptance 1: inner split rolled back -> parent weight & child index restored,
// outer modifications preserved; release only drops the boundary.
test('nested savepoint rollback restores splits/indexes, keeps outer changes', () => {
  const dir = tmpdir();
  const store = Store.open(dir);

  let tx = store.begin();
  tx.create({ id: 'P', weight: 100 });
  tx.commit();

  tx = store.begin();
  tx.qc({ id: 'P', status: 'passed' });          // outer modification
  tx.create({ id: 'E', weight: 5 });             // outer modification
  tx.savepoint('sp1');
  tx.split({ parent: 'P', children: [{ id: 'A', weight: 30 }, { id: 'B', weight: 40 }] });
  tx.savepoint('sp2');
  tx.split({ parent: 'A', children: [{ id: 'A1', weight: 10 }] });
  tx.qc({ id: 'B', status: 'failed' });          // inner modification
  tx.rollback('sp2');

  // Inner split and qc undone; outer split inside sp1 still present.
  assert.equal(tx.state.batches.A1, undefined);
  assert.deepEqual(tx.state.batches.A.children, []);
  assert.equal(tx.state.batches.A.weight, 30);
  assert.equal(tx.state.batches.B.qc, 'pending');

  tx.release('sp1'); // release boundary only, changes kept
  assert.deepEqual(tx.state.batches.P.children.map((c) => c.id).sort(), ['A', 'B']);
  tx.commit();

  const s = store.state;
  assert.equal(s.batches.P.qc, 'passed');        // outer mod kept
  assert.ok(s.batches.E);                        // outer mod kept
  assert.deepEqual(s.batches.P.children.map((c) => c.id).sort(), ['A', 'B']);
  assert.equal(s.batches.A.children.length, 0);
  assert.equal(s.batches.B.qc, 'pending');
  store.close();

  // Persisted across reopen.
  const reopened = Store.open(dir);
  assert.equal(reopened.state.batches.P.qc, 'passed');
  assert.ok(reopened.state.batches.E);
  assert.equal(reopened.state.batches.A1, undefined);
  reopened.close();
});

test('rollback to savepoint keeps the savepoint itself', () => {
  const store = Store.open(tmpdir());
  const tx = store.begin();
  tx.create({ id: 'P', weight: 10 });
  tx.savepoint('s');
  tx.create({ id: 'A', weight: 1 });
  tx.rollback('s');
  assert.equal(tx.state.batches.A, undefined);
  tx.create({ id: 'B', weight: 2 });
  tx.rollback('s'); // still valid: savepoint survives rollback
  assert.equal(tx.state.batches.B, undefined);
  tx.commit();
  assert.deepEqual(Object.keys(store.state.batches), ['P']);
  store.close();
});

test('release of unknown savepoint is a business error', () => {
  const store = Store.open(tmpdir());
  const tx = store.begin();
  tx.create({ id: 'P', weight: 10 });
  assert.throws(() => tx.release('nope'), /no such savepoint/);
  assert.throws(() => tx.rollback('nope'), /no such savepoint/);
  tx.commit();
  store.close();
});
