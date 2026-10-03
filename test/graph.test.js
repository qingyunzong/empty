import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tmpdir } from './helpers.js';

function openWith(events) {
  const store = Store.open(tmpdir());
  for (const [type, payload] of events) store.append(type, payload);
  return store;
}

test('count aggregation: valid only when all inputs valid and min met', () => {
  const s = openWith([
    ['ADD_FACT', { id: 'f1', source: 's1' }],
    ['ADD_FACT', { id: 'f2', source: 's2' }],
    ['ADD_DERIVED', { id: 'd', op: 'count', min: 2, inputs: ['f1', 'f2'] }],
  ]);
  assert.deepEqual(s.status('d'), { node: 'd', status: 'valid', support: 2 });
  s.append('REVOKE_SOURCE', { id: 's2' });
  // support 1 < min 2, and not all inputs valid -> degraded
  assert.equal(s.status('d').status, 'degraded');
  assert.equal(s.status('d').support, 1);
});

test('count with low min: weakened evidence is degraded, not valid', () => {
  const s = openWith([
    ['ADD_FACT', { id: 'f1', source: 's1' }],
    ['ADD_FACT', { id: 'f2', source: 's2' }],
    ['ADD_DERIVED', { id: 'd', op: 'count', min: 1, inputs: ['f1', 'f2'] }],
  ]);
  s.append('REVOKE_SOURCE', { id: 's2' });
  // threshold still met (1 >= 1) but evidence is incomplete -> degraded
  assert.equal(s.status('d').status, 'degraded');
});

test('sum aggregation over fact values and derived supports', () => {
  const s = openWith([
    ['ADD_FACT', { id: 'f1', source: 's1', value: 2 }],
    ['ADD_FACT', { id: 'f2', source: 's2', value: 3 }],
    ['ADD_DERIVED', { id: 'd1', op: 'sum', min: 5, inputs: ['f1', 'f2'] }],
    ['ADD_DERIVED', { id: 'd2', op: 'sum', min: 6, inputs: ['d1', 'f1'] }],
  ]);
  assert.equal(s.status('d1').status, 'valid'); // 2+3 >= 5
  assert.equal(s.status('d2').status, 'valid'); // 5+2 >= 6
  s.append('REVOKE_SOURCE', { id: 's2' });
  assert.equal(s.status('d1').status, 'degraded'); // support 2 < 5
  assert.equal(s.status('d1').support, 2);
  assert.equal(s.status('d2').status, 'degraded');
});

test('unknown input yields unknown, never counted as unsatisfiable', () => {
  const s = openWith([
    ['ADD_FACT', { id: 'f1', source: 's1' }],
    ['ADD_DERIVED', { id: 'd1', op: 'count', min: 1, inputs: ['missing'] }],
    ['ADD_DERIVED', { id: 'd2', op: 'count', min: 1, inputs: ['d1', 'f1'] }],
  ]);
  assert.equal(s.status('d1').status, 'unknown');
  // d2 has one valid input (f1) and one unknown: must be unknown, not degraded
  assert.equal(s.status('d2').status, 'unknown');
  // once the missing fact appears, everything resolves
  s.append('ADD_FACT', { id: 'missing', source: 's1' });
  assert.equal(s.status('d1').status, 'valid');
  assert.equal(s.status('d2').status, 'valid');
});

test('fact statuses: valid / revoked / deleted / unknown', () => {
  const s = openWith([
    ['ADD_FACT', { id: 'f1', source: 's1' }],
    ['ADD_FACT', { id: 'f2', source: 's2' }],
  ]);
  assert.equal(s.status('f1').status, 'valid');
  s.append('REVOKE_SOURCE', { id: 's1' });
  assert.equal(s.status('f1').status, 'revoked');
  s.append('DELETE_FACT', { id: 'f2' });
  assert.equal(s.status('f2').status, 'deleted');
  assert.equal(s.status('nope').status, 'unknown');
});
