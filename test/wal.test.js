import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger, E_WAL, E_IO } from '../src/ledger.js';
import { tempDir } from './helpers.js';

test('torn tail (partial last record) is truncated on recovery', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 10 });
  l.close();

  const walPath = path.join(dir, 'wal.log');
  const before = fs.statSync(walPath).size;
  fs.appendFileSync(walPath, '{"type":"intent","txId":"torn-partial'); // crash mid-append

  const l2 = new Ledger(dir).open();
  assert.equal(l2.status('k1').status, 'committed');
  assert.equal(l2.balance('alice').frozen, 10);
  assert.ok(fs.statSync(walPath).size === before); // torn bytes removed
  // and the WAL keeps working with correct sequence numbers
  l2.submit({ key: 'k2', op: 'freeze', account: 'alice', amount: 5 });
  assert.equal(l2.balance('alice').frozen, 15);
  l2.close();
});

test('corruption in the middle of the WAL is E_WAL', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 10 });
  l.close();

  const walPath = path.join(dir, 'wal.log');
  const data = fs.readFileSync(walPath, 'utf8');
  assert.ok(data.includes('"amount":100'));
  fs.writeFileSync(walPath, data.replace('"amount":100', '"amount":900'));

  assert.throws(() => new Ledger(dir).open(), (err) => err.code === E_WAL);
});

test('unreadable WAL path is E_IO', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'wal.log')); // directory where the WAL file should be
  assert.throws(() => new Ledger(dir).open(), (err) => err.code === E_IO);
});
