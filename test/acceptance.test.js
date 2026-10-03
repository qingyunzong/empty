import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, openLedger, buildTree } from './helpers.js';

test('acceptance 1: revoking an all-OPEN tree returns every reserved budget', () => {
  const dir = tempDir();
  const ledger = buildTree(dir);
  assert.equal(ledger.getView('root').available, 300);

  const result = ledger.cancel('root');

  assert.equal(result.state, 'CANCELLED');
  assert.deepEqual([...result.cancelled].sort(), ['alpha', 'alpha-1', 'alpha-2', 'beta', 'root']);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.released, 400 + 150 + 100 + 300);

  for (const id of ['root', 'alpha', 'alpha-1', 'alpha-2', 'beta']) {
    assert.equal(ledger.getView(id).state, 'CANCELLED', `${id} must be CANCELLED`);
  }
  // All reservations returned: nothing occupies the root budget anymore.
  assert.equal(ledger.getView('root').reserved, 0);
  assert.equal(ledger.getView('root').available, 1000);

  // State survives a reload (persistence check).
  const reloaded = openLedger(dir);
  assert.equal(reloaded.getView('root').state, 'CANCELLED');
  assert.equal(reloaded.getView('root').available, 1000);
});

test('acceptance 2: mixed OPEN/SETTLED tree keeps settled groups and ends PARTIAL', () => {
  const dir = tempDir();
  const ledger = buildTree(dir);
  ledger.prepare('beta');
  ledger.commit('beta');
  assert.equal(ledger.getView('beta').state, 'SETTLED');

  const result = ledger.cancel('root');

  // OPEN descendants cancelled, SETTLED beta preserved.
  assert.deepEqual([...result.cancelled].sort(), ['alpha', 'alpha-1', 'alpha-2']);
  assert.deepEqual(result.kept, [{ id: 'beta', state: 'SETTLED' }]);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, 'beta');
  assert.match(result.blocked[0].reason, /ALREADY_SETTLED/);

  // Parent revocation is not a failure: it ends PARTIAL.
  assert.equal(result.state, 'PARTIAL');
  assert.equal(ledger.getView('root').state, 'PARTIAL');
  assert.equal(ledger.getView('beta').state, 'SETTLED');
  for (const id of ['alpha', 'alpha-1', 'alpha-2']) {
    assert.equal(ledger.getView(id).state, 'CANCELLED', `${id} must be CANCELLED`);
  }

  // Cancelled reservations released; settled beta still occupies 300.
  assert.equal(ledger.getView('root').reserved, 300);
  assert.equal(ledger.getView('root').available, 700);
  assert.equal(ledger.getView('root').settled, 300);

  const reloaded = openLedger(dir);
  assert.equal(reloaded.getView('root').state, 'PARTIAL');
  assert.equal(reloaded.getView('beta').state, 'SETTLED');
});

test('cancelling a settled or cancelled group is an error, not PARTIAL', () => {
  const dir = tempDir();
  const ledger = buildTree(dir);
  ledger.prepare('beta');
  ledger.commit('beta');
  assert.throws(() => ledger.cancel('beta'), /already settled|settled/i);
  ledger.cancel('alpha');
  assert.throws(() => ledger.cancel('alpha'), /already cancelled/i);
});
