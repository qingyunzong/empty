import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../src/index.js';

// Acceptance 3: illegal ratios and cash/share mixing are rejected statically.

test('split ratio > 1 is rejected with E_RATIO', () => {
  let err;
  try {
    runSource('action S1 { security AAPL kind split ratio 2 exdate 2024-06-10 version 1 }');
  } catch (e) {
    err = e;
  }
  assert.equal(err?.code, 'E_RATIO');
  assert.match(err.message, /ratio/);
});

test('split ratio of exactly 1 and negative ratios are rejected', () => {
  assert.throws(
    () => runSource('action S1 { security AAPL kind split ratio 1 exdate 2024-06-10 version 1 }'),
    (e) => e.code === 'E_RATIO',
  );
  assert.throws(
    () => runSource('action S1 { security AAPL kind split ratio -1/2 exdate 2024-06-10 version 1 }'),
    (e) => e.code === 'E_RATIO',
  );
});

test('mixing cash and shares in an expression is E_TYPE', () => {
  assert.throws(
    () => runSource('action D1 { security AAPL kind dividend cash $2.5 + 3sh exdate 2024-06-10 version 1 }'),
    (e) => e.code === 'E_TYPE',
  );
  assert.throws(
    () => runSource('action D1 { security AAPL kind dividend cash $2.5 * $2 exdate 2024-06-10 version 1 }'),
    (e) => e.code === 'E_TYPE',
  );
});

test('dimensionless value in a cash field is E_TYPE', () => {
  assert.throws(
    () => runSource('action D1 { security AAPL kind dividend cash 100 exdate 2024-06-10 version 1 }'),
    (e) => e.code === 'E_TYPE',
  );
});

test('cash-typed ratio is E_RATIO', () => {
  assert.throws(
    () => runSource('action S1 { security AAPL kind split ratio $1/2 exdate 2024-06-10 version 1 }'),
    (e) => e.code === 'E_RATIO',
  );
});

test('typed expressions evaluate: cash * num stays cash', () => {
  const vm = runSource(
    'action D1 { security AAPL kind dividend cash $2.5 * (1 + 1) exdate 2024-06-10 version 1 }\napply D1',
    { lots: [{ id: 'L1', security: 'AAPL', qty: '10', date: '2024-01-01' }] },
  );
  assert.equal(vm.cash.toString(), '50');
});
