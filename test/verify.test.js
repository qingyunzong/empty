import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { propose, finalize, verify } from '../src/ledger.js';
import { createBlock } from '../src/block.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const store = new Store(dir);
  store.load();
  return { store, dir };
}

test('intact chain verifies clean', () => {
  const { store } = makeStore();
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  finalize(store);
  propose(store, { id: 't2', from: 'bob', to: 'alice', amount: 3 });
  finalize(store);
  assert.deepEqual(verify(store), []);
});

test('tampered block reports CORRUPT', () => {
  const { store, dir } = makeStore();
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  const block = finalize(store);
  store.save();
  const file = path.join(dir, 'blocks', `${block.hash}.json`);
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.deltas.alice = 9999;
  fs.writeFileSync(file, JSON.stringify(tampered, null, 2));
  const reloaded = new Store(dir);
  reloaded.load();
  const issues = verify(reloaded);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'CORRUPT');
  assert.equal(issues[0].hash, block.hash);
});

test('block with unknown parent reports MISSING', () => {
  const { store, dir } = makeStore();
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  finalize(store);
  store.save();
  const orphan = createBlock({
    level: 2,
    parent: 'f'.repeat(64),
    transfers: [],
    deltas: {},
    index: [],
  });
  fs.writeFileSync(path.join(dir, 'blocks', `${orphan.hash}.json`), JSON.stringify(orphan, null, 2));
  const reloaded = new Store(dir);
  reloaded.load();
  const issues = verify(reloaded);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'MISSING');
  assert.equal(issues[0].hash, orphan.hash);
});
