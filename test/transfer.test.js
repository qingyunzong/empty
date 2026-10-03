import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'px-test-'));
}

function seedThree(dir) {
  const store = Store.init(dir);
  store.put('P1', 'L1');
  store.put('P1', 'L2', { quarantine: true });
  store.put('P1', 'L3');
  return store;
}

test('acceptance 1: crash after_records rolls back the whole 3-lot transfer', () => {
  const dir = tmpdir();
  let store = seedThree(dir);
  const before = store.dump();

  assert.throws(
    () => store.transfer('P1', 'P2', ['L1', 'L2', 'L3'], { quarantine: true, crashPoint: 'after_records' }),
    (e) => e.code === 'E_CRASH',
  );

  store = Store.open(dir);
  const after = store.dump();
  assert.deepStrictEqual(after, before);
  assert.equal(after.txid, 3);
  assert.deepStrictEqual(
    after.pallets.P1.map((b) => [b.lot, b.quarantine]),
    [['L1', false], ['L2', true], ['L3', false]],
  );
  assert.equal(after.pallets.P2, undefined);
  assert.deepStrictEqual(
    after.index.map((i) => [i.pallet, i.lot]),
    [['P1', 'L1'], ['P1', 'L2'], ['P1', 'L3']],
  );
});

test('crash after_commit makes the whole 3-lot transfer visible after recovery', () => {
  const dir = tmpdir();
  let store = seedThree(dir);

  assert.throws(
    () => store.transfer('P1', 'P2', ['L1', 'L2', 'L3'], { quarantine: true, crashPoint: 'after_commit' }),
    (e) => e.code === 'E_CRASH',
  );

  store = Store.open(dir);
  const after = store.dump();
  assert.equal(after.txid, 4);
  assert.equal(after.pallets.P1, undefined);
  assert.deepStrictEqual(
    after.pallets.P2.map((b) => [b.lot, b.quarantine]),
    [['L1', true], ['L2', true], ['L3', true]],
  );
  assert.deepStrictEqual(
    after.index.map((i) => [i.pallet, i.lot]),
    [['P2', 'L1'], ['P2', 'L2'], ['P2', 'L3']],
  );
});

test('acceptance 2: concurrent transfers of the same batch -> one commits, other E_SNAPSHOT', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  store.put('P1', 'L1');

  const tx1 = store.begin();
  const tx2 = store.begin();
  tx1.transfer('P1', 'P2', ['L1']);
  tx2.transfer('P1', 'P3', ['L1']);
  tx1.commit();
  assert.throws(() => tx2.commit(), (e) => e.code === 'E_SNAPSHOT');

  const state = store.dump();
  assert.deepStrictEqual(Object.keys(state.pallets), ['P2']);
  assert.equal(state.pallets.P2[0].lot, 'L1');
});

test('acceptance 2: target pallet already holding the lotId -> E_DUP', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  store.put('P1', 'L1');
  store.put('P2', 'L1'); // different pallet keeps its own state: allowed

  const tx = store.begin();
  assert.throws(() => tx.transfer('P1', 'P2', ['L1']), (e) => e.code === 'E_DUP');

  // and the commit-time guard also fires when the conflict appears after the read
  const tx2 = store.begin();
  tx2.transfer('P1', 'P3', ['L1']);
  store.put('P3', 'L1');
  assert.throws(() => tx2.commit(), (e) => e.code === 'E_DUP');
});

test('same pallet cannot hold duplicate lotId (put)', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  store.put('P1', 'L1');
  assert.throws(() => store.put('P1', 'L1'), (e) => e.code === 'E_DUP');
});

test('transfer updates quarantine flag and version chain survives reopen', () => {
  const dir = tmpdir();
  let store = Store.init(dir);
  store.put('P1', 'L1');
  store.transfer('P1', 'P2', ['L1'], { quarantine: true });
  store = Store.open(dir);
  const state = store.dump();
  assert.equal(state.pallets.P2[0].quarantine, true);
  const chain = store.lots.get('b0');
  assert.equal(chain.length, 2);
  assert.equal(chain[0].pallet, 'P1');
  assert.equal(chain[1].pallet, 'P2');
});

test('transfer of a missing batch -> E_NOT_FOUND', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  store.put('P1', 'L1');
  assert.throws(() => store.transfer('P1', 'P2', ['L9']), (e) => e.code === 'E_NOT_FOUND');
});
