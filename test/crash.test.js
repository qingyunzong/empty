import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tmpdir } from './helpers.js';

// Acceptance 2: crash before commit marker -> tentative changes invisible;
// crash after marker -> redo restores full lineage.
test('crash before commit marker leaves no partial batches', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  let tx = store.begin();
  tx.create({ id: 'P', weight: 100 });
  tx.commit();

  tx = store.begin();
  tx.split({ parent: 'P', children: [{ id: 'A', weight: 30 }, { id: 'B', weight: 40 }] });
  tx.qc({ id: 'P', status: 'passed' });
  assert.throws(() => tx.commit({ crash: 'beforeMarker' }), /simulated crash/);
  store.close();

  const recovered = Store.open(dir);
  assert.deepEqual(Object.keys(recovered.state.batches), ['P']);
  assert.equal(recovered.state.batches.P.qc, 'pending');
  assert.equal(recovered.state.seq, 1);
  recovered.close();
});

test('crash after commit marker redoes full lineage and rebuilds indexes', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  let tx = store.begin();
  tx.create({ id: 'P', weight: 100 });
  tx.commit();

  tx = store.begin();
  tx.split({ parent: 'P', children: [{ id: 'A', weight: 30 }, { id: 'B', weight: 40 }] });
  tx.merge({ parents: ['A', 'B'], child: { id: 'M', weight: 50 } });
  tx.qc({ id: 'M', status: 'passed' });
  assert.throws(() => tx.commit({ crash: 'afterMarker' }), /simulated crash/);
  store.close();

  const recovered = Store.open(dir);
  const b = recovered.state.batches;
  assert.deepEqual(Object.keys(b).sort(), ['A', 'B', 'M', 'P']);
  assert.deepEqual(b.P.children.map((c) => c.id).sort(), ['A', 'B']);
  assert.deepEqual(b.M.parents.map((p) => p.id).sort(), ['A', 'B']);
  assert.equal(b.M.qc, 'passed');
  assert.equal(recovered.state.seq, 2);
  const cert = recovered.latestCertificate();
  assert.equal(cert.seq, 2);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
  recovered.close();
});

test('uncommitted tx without any commit attempt is discarded on reopen', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const tx = store.begin();
  tx.create({ id: 'X', weight: 1 });
  store.close(); // process "dies" without commit
  const recovered = Store.open(dir);
  assert.equal(recovered.state.batches.X, undefined);
  recovered.close();
});
