import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mvcc-'));

test('committed data survives reopening the store (data lands on disk)', () => {
  const dir = tmpdir();
  const store1 = Store.open(dir);
  const tx = store1.begin();
  tx.put('wo-1', { workcenter: 'cnc-1', timeSlot: '08:00', qty: 5 });
  tx.put('', 'zero-length-key');
  tx.commit();

  assert.ok(fs.existsSync(path.join(dir, 'log.jsonl')));

  const store2 = Store.open(dir);
  assert.equal(store2.version, 1);
  const reader = store2.begin();
  assert.deepEqual(reader.get('wo-1'), { workcenter: 'cnc-1', timeSlot: '08:00', qty: 5 });
  assert.equal(reader.get(''), 'zero-length-key');
});

test('unique index is enforced after reopen', () => {
  const dir = tmpdir();
  const store1 = Store.open(dir);
  const tx = store1.begin();
  tx.put('wo-1', { workcenter: 'cnc-1', timeSlot: '08:00' });
  tx.commit();

  const store2 = Store.open(dir);
  const tx2 = store2.begin();
  tx2.put('wo-2', { workcenter: 'cnc-1', timeSlot: '08:00' });
  assert.throws(() => tx2.commit(), (err) => err.code === 'E_UNIQUE');
});

test('multiple commits replay in order', () => {
  const dir = tmpdir();
  const store1 = Store.open(dir);
  for (let i = 0; i < 10; i += 1) {
    const tx = store1.begin();
    tx.put(`k${i}`, { n: i });
    tx.commit();
  }
  const store2 = Store.open(dir);
  assert.equal(store2.version, 10);
  const reader = store2.begin();
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(reader.get(`k${i}`), { n: i });
  }
});
