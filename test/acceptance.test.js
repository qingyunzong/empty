import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tmpdir } from './helpers.js';

test('acceptance 1: revoking a source degrades a three-level derivation chain', () => {
  const dir = tmpdir();
  const s = Store.open(dir);
  s.append('ADD_FACT', { id: 'f', source: 'src' });
  s.append('ADD_DERIVED', { id: 'd1', op: 'count', inputs: ['f'] });
  s.append('ADD_DERIVED', { id: 'd2', op: 'count', inputs: ['d1'] });
  s.append('ADD_DERIVED', { id: 'd3', op: 'count', inputs: ['d2'] });
  assert.equal(s.status('d3').status, 'valid');

  s.append('REVOKE_SOURCE', { id: 'src' });
  assert.equal(s.status('f').status, 'revoked');
  assert.equal(s.status('d1').status, 'degraded');
  assert.equal(s.status('d2').status, 'degraded');
  assert.equal(s.status('d3').status, 'degraded');

  // restore returns the whole chain to the provable state
  s.append('RESTORE_SOURCE', { id: 'src' });
  assert.equal(s.status('d1').status, 'valid');
  assert.equal(s.status('d2').status, 'valid');
  assert.equal(s.status('d3').status, 'valid');

  // state survives a reload (WAL replay)
  const reopened = Store.open(dir);
  assert.equal(reopened.status('d3').status, 'valid');
});

test('acceptance 2: restore does not resurrect a fact deleted after the revoke', () => {
  const dir = tmpdir();
  const s = Store.open(dir);
  s.append('ADD_FACT', { id: 'f', source: 'src' });
  s.append('ADD_DERIVED', { id: 'd', op: 'count', inputs: ['f'] });
  s.append('REVOKE_SOURCE', { id: 'src' });
  s.append('DELETE_FACT', { id: 'f' }); // deleted while revoked
  s.append('RESTORE_SOURCE', { id: 'src' });

  // the tombstone wins: restore only clears the source revocation
  assert.equal(s.status('f').status, 'deleted');
  assert.equal(s.status('d').status, 'degraded');

  const reopened = Store.open(dir);
  assert.equal(reopened.status('f').status, 'deleted');
  assert.equal(reopened.status('d').status, 'degraded');
});
