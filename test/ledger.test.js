import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { tempDir, enumerateBalances, balancesOf } from './helpers.js';

test('small event set matches independent enumeration', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'RM', qty: 100 }, 'k-recv-1');
  ledger.execute('receive', { batch: 'RM-A', qty: 40, parent: 'RM' }, 'k-recv-2');
  ledger.execute('reserve', { batch: 'RM', qty: 10 }, 'k-res-1');
  ledger.execute('issue', { batch: 'RM', qty: 20 }, 'k-iss-1');
  ledger.execute('return', { batch: 'RM-A', qty: 5 }, 'k-ret-1');

  const enumerated = enumerateBalances(dir);
  const status = ledger.status();
  for (const [name, expected] of enumerated) {
    assert.equal(status.batches[name].onHand, expected.onHand, `${name} onHand`);
    assert.equal(status.batches[name].reserved, expected.reserved, `${name} reserved`);
  }
  assert.equal(Object.keys(status.batches).length, enumerated.size);

  const reopened = Ledger.open(dir);
  assert.deepEqual(balancesOf(reopened.status()), balancesOf(status));
});

test('duplicate idempotency key returns original result without changing stock', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  const first = ledger.execute('receive', { batch: 'X', qty: 10 }, 'dup-1');
  const before = balancesOf(ledger.status());
  const logSize = statSync(join(dir, 'events.log')).size;

  const second = ledger.execute('receive', { batch: 'X', qty: 10 }, 'dup-1');
  assert.deepEqual(second, first);
  assert.deepEqual(balancesOf(ledger.status()), before);
  assert.equal(statSync(join(dir, 'events.log')).size, logSize);

  const reopened = Ledger.open(dir);
  const third = reopened.execute('receive', { batch: 'X', qty: 10 }, 'dup-1');
  assert.deepEqual(third, first);
  assert.deepEqual(balancesOf(reopened.status()), before);
  assert.equal(statSync(join(dir, 'events.log')).size, logSize);
});

test('insufficient stock yields E_STOCK, is idempotent and durable', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'B', qty: 10 }, 'e1');

  const rejected = ledger.execute('reserve', { batch: 'B', qty: 15 }, 'e2');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'E_STOCK');
  const rejectedIssue = ledger.execute('issue', { batch: 'B', qty: 15 }, 'e3');
  assert.equal(rejectedIssue.code, 'E_STOCK');
  assert.deepEqual(balancesOf(ledger.status()), { B: { onHand: 10, reserved: 0 } });

  assert.deepEqual(ledger.execute('reserve', { batch: 'B', qty: 15 }, 'e2'), rejected);

  const reopened = Ledger.open(dir);
  assert.deepEqual(reopened.execute('reserve', { batch: 'B', qty: 15 }, 'e2'), rejected);
  assert.deepEqual(reopened.execute('issue', { batch: 'B', qty: 15 }, 'e3'), rejectedIssue);
  assert.deepEqual(balancesOf(reopened.status()), { B: { onHand: 10, reserved: 0 } });
});

test('rollback to unknown savepoint returns E_SAVEPOINT', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  assert.throws(() => ledger.rollback('nope'), (err) => err.code === 'E_SAVEPOINT');
});

test('savepoint rollback appends compensation, keeps old entries, then append works', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'M', qty: 50 }, 'k1');
  ledger.savepoint('S');
  const atSavepoint = balancesOf(ledger.status());
  ledger.execute('receive', { batch: 'M', qty: 20 }, 'k2');
  ledger.execute('issue', { batch: 'M', qty: 10 }, 'k3');
  assert.equal(ledger.status().batches.M.onHand, 60);

  const certificate = ledger.rollback('S');
  assert.equal(certificate.savepoint, 'S');
  assert.deepEqual(certificate.reversedKeys, ['k3', 'k2']);
  assert.equal(typeof certificate.stateHashAfter, 'string');

  assert.deepEqual(balancesOf(ledger.status()), atSavepoint);

  const history = ledger.history();
  const keys = history.map((r) => r.key);
  assert.ok(keys.includes('k2') && keys.includes('k3'), 'old entries are kept');
  assert.ok(history.some((r) => r.kind === 'rollback' && r.certificate.id === certificate.id));

  const after = ledger.execute('receive', { batch: 'M', qty: 5 }, 'k4');
  assert.equal(after.onHand, 55);

  const reopened = Ledger.open(dir);
  assert.deepEqual(balancesOf(reopened.status()), balancesOf(ledger.status()));
  assert.deepEqual(reopened.execute('receive', { batch: 'M', qty: 5 }, 'k4'), after);
});
