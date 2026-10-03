import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { validateState } from '../src/state.js';
import { tmpdir } from './helpers.js';

test('total output weight may not exceed effective parent weight', () => {
  const store = Store.open(tmpdir());
  const tx = store.begin();
  tx.create({ id: 'P', weight: 100 });
  tx.split({ parent: 'P', children: [{ id: 'A', weight: 60 }] });
  assert.throws(
    () => tx.split({ parent: 'P', children: [{ id: 'B', weight: 41 }] }),
    /weight conservation violated/);
  tx.split({ parent: 'P', children: [{ id: 'B', weight: 40 }] });
  tx.commit();
  assert.equal(validateState(store.state).length, 0);
  store.close();
});

test('merge limited by sum of effective parent weights', () => {
  const store = Store.open(tmpdir());
  const tx = store.begin();
  tx.create({ id: 'P1', weight: 30 });
  tx.create({ id: 'P2', weight: 30 });
  assert.throws(
    () => tx.merge({ parents: ['P1', 'P2'], child: { id: 'M', weight: 61 } }),
    /weight conservation violated/);
  tx.merge({ parents: ['P1', 'P2'], child: { id: 'M', weight: 60 } });
  tx.commit();
  store.close();
});

test('cyclic ancestors are forbidden', () => {
  const store = Store.open(tmpdir());
  const tx = store.begin();
  tx.create({ id: 'P', weight: 100 });
  tx.split({ parent: 'P', children: [{ id: 'A', weight: 50 }] });
  assert.throws(() => tx.link({ parent: 'A', child: 'P', amount: 1 }), /cyclic ancestor/);
  assert.throws(() => tx.link({ parent: 'P', child: 'P', amount: 1 }), /self link/);
  tx.commit();
  assert.equal(validateState(store.state).length, 0);
  store.close();
});

test('certificate hash chains across commits', () => {
  const store = Store.open(tmpdir());
  let tx = store.begin();
  tx.create({ id: 'P', weight: 10 });
  const c1 = tx.commit();
  tx = store.begin();
  tx.qc({ id: 'P', status: 'passed' });
  const c2 = tx.commit();
  assert.equal(c2.prevHash, c1.hash);
  assert.notEqual(c1.hash, c2.hash);
  store.close();
});
