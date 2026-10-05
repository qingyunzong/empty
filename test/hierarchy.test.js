import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { tempDir, balancesOf } from './helpers.js';

function buildHierarchy(dir) {
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'P', qty: 0 }, 'h-p');
  ledger.execute('receive', { batch: 'A', qty: 30, parent: 'P' }, 'h-a');
  ledger.execute('receive', { batch: 'B', qty: 70, parent: 'P' }, 'h-b');
  ledger.execute('reserve', { batch: 'A', qty: 10 }, 'h-res');
  return ledger;
}

test('parent issue consumes child batches proportionally to availability', () => {
  const dir = tempDir();
  const ledger = buildHierarchy(dir);
  // available: A = 30 - 10 = 20, B = 70 -> total 90
  const result = ledger.execute('issue', { batch: 'P', qty: 45 }, 'h-iss');
  assert.equal(result.ok, true);
  assert.deepEqual(result.breakdown, [
    { batch: 'A', qty: 10 },
    { batch: 'B', qty: 35 },
  ]);
  assert.deepEqual(balancesOf(ledger.status()), {
    P: { onHand: 0, reserved: 0 },
    A: { onHand: 20, reserved: 10 },
    B: { onHand: 35, reserved: 0 },
  });
});

test('proportional remainder distribution is deterministic', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'Q', qty: 0 }, 'r-q');
  ledger.execute('receive', { batch: 'c1', qty: 1, parent: 'Q' }, 'r-c1');
  ledger.execute('receive', { batch: 'c2', qty: 1, parent: 'Q' }, 'r-c2');
  ledger.execute('receive', { batch: 'c3', qty: 1, parent: 'Q' }, 'r-c3');
  const result = ledger.execute('issue', { batch: 'Q', qty: 2 }, 'r-iss');
  assert.deepEqual(result.breakdown, [
    { batch: 'c1', qty: 1 },
    { batch: 'c2', qty: 1 },
  ]);
});

test('hierarchical rollback then append is deterministic', () => {
  const dir = tempDir();
  const ledger = buildHierarchy(dir);
  ledger.savepoint('S');
  const atSavepoint = balancesOf(ledger.status());

  const first = ledger.execute('issue', { batch: 'P', qty: 45 }, 'h-iss');
  const certificate = ledger.rollback('S');
  assert.deepEqual(certificate.reversedKeys, ['h-iss']);
  assert.deepEqual(balancesOf(ledger.status()), atSavepoint);

  const second = ledger.execute('issue', { batch: 'P', qty: 45 }, 'h-iss-2');
  assert.deepEqual(second.breakdown, first.breakdown);
  assert.deepEqual(balancesOf(ledger.status()), {
    P: { onHand: 0, reserved: 0 },
    A: { onHand: 20, reserved: 10 },
    B: { onHand: 35, reserved: 0 },
  });

  const reopened = Ledger.open(dir);
  assert.deepEqual(balancesOf(reopened.status()), balancesOf(ledger.status()));
  assert.deepEqual(reopened.execute('issue', { batch: 'P', qty: 45 }, 'h-iss-2'), second);
});

test('reservation budget accounts for whole subtree', () => {
  const dir = tempDir();
  const ledger = buildHierarchy(dir);
  // subtree P available = 0 + 20 + 70 = 90
  const over = ledger.execute('reserve', { batch: 'P', qty: 91 }, 'h-over');
  assert.equal(over.ok, false);
  assert.equal(over.code, 'E_STOCK');
  const exact = ledger.execute('reserve', { batch: 'P', qty: 90 }, 'h-exact');
  assert.equal(exact.ok, true);
  assert.equal(exact.available, 0);
  const none = ledger.execute('issue', { batch: 'P', qty: 1 }, 'h-none');
  assert.equal(none.code, 'E_STOCK');
});
