'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SealRegistry } = require('../src/seal');
const { CODES } = require('../src/errors');

const entry = (id, over = {}) => ({
  id, accountId: 'a1', day: '2026-10-04', amount: 1, currency: 'CNY', status: 'settled', ...over,
});

test('late entry on sealed day rejected with SEALED', () => {
  const r = new SealRegistry();
  r.register(entry('t1'));
  r.seal('a1', '2026-10-04');
  assert.throws(() => r.admitLate(entry('t2')), (e) => e.code === CODES.SEALED);
});

test('unsealed day accepts late entries', () => {
  const r = new SealRegistry();
  assert.deepEqual(r.admitLate(entry('t2')), { superseded: null });
});

test('valid supersedes chain accepted on sealed day', () => {
  const r = new SealRegistry();
  r.register(entry('t1'));
  r.seal('a1', '2026-10-04');
  const { superseded } = r.admitLate(entry('t2', { supersedes: 't1' }));
  assert.equal(superseded.id, 't1');
  // chain can continue from the new head
  const next = r.admitLate(entry('t3', { supersedes: 't2' }));
  assert.equal(next.superseded.id, 't2');
});

test('broken supersedes links rejected with SEALED', () => {
  const r = new SealRegistry();
  r.register(entry('t1'));
  r.seal('a1', '2026-10-04');
  // unknown target
  assert.throws(() => r.admitLate(entry('t2', { supersedes: 'nope' })), (e) => e.code === CODES.SEALED);
  // double-supersede of same entry
  r.admitLate(entry('t2', { supersedes: 't1' }));
  assert.throws(() => r.admitLate(entry('t3', { supersedes: 't1' })), (e) => e.code === CODES.SEALED);
  // cross-day supersedes
  r.register(entry('x1', { day: '2026-10-03' }));
  assert.throws(
    () => r.admitLate(entry('t4', { supersedes: 'x1' })),
    (e) => e.code === CODES.SEALED,
  );
});
