import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { propose, finalize, report } from '../src/ledger.js';
import { createBlock } from '../src/block.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const store = new Store(dir);
  store.load();
  return { store, dir };
}

test('crash after block persist but before index update recovers from block chain', () => {
  const { store, dir } = makeStore();
  store.state.budgets = { alice: 100 };
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  store.save(); // index persisted without the block
  const block = finalize(store); // block file written; index update "crashes" (no save)
  assert.ok(fs.existsSync(path.join(dir, 'blocks', `${block.hash}.json`)));

  const recovered = new Store(dir);
  recovered.load();
  assert.equal(recovered.state.levels['1'], block.hash, 'block adopted into level index');
  assert.deepEqual([...recovered.state.pending], [], 'settled transfer leaves pending');
  const state = report(recovered);
  assert.equal(state.balances.alice, 10);
  assert.deepEqual(state.settled, ['t1']);
  assert.equal(state.missing.length, 0);
});

test('incomplete reference stays missing and is not settleable', () => {
  const { store, dir } = makeStore();
  store.state.budgets = { alice: 100 };
  propose(store, { id: 't9', from: 'alice', to: 'bob', amount: 5 });
  store.save();
  const dangling = createBlock({
    level: 3,
    parent: '0'.repeat(64),
    transfers: ['t9'],
    deltas: { alice: 5, bob: -5 },
    index: [{ id: 't9', from: 'alice', to: 'bob', amount: 5 }],
  });
  fs.mkdirSync(path.join(dir, 'blocks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'blocks', `${dangling.hash}.json`), JSON.stringify(dangling, null, 2));

  const recovered = new Store(dir);
  recovered.load();
  assert.ok(recovered.state.missing[dangling.hash], 'block kept as missing');
  assert.equal(recovered.state.missing[dangling.hash].parent, '0'.repeat(64));
  assert.deepEqual([...recovered.state.pending], [], 't9 not returned to settleable pool');
  const state = report(recovered);
  assert.deepEqual(state.settled, [], 'missing block not treated as settled');
  assert.deepEqual(state.balances, {}, 'missing block contributes nothing to balances');
  assert.equal(state.levels.length, 0);
});
