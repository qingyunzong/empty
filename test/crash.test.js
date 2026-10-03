import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, openLedger } from './helpers.js';

function walRecords(dir) {
  const walFile = path.join(dir, 'wal.log');
  if (!fs.existsSync(walFile)) return [];
  return fs
    .readFileSync(walFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('acceptance 3: crash after PREPARE rolls back, then resubmit succeeds', () => {
  const dir = tempDir();
  const ledger = openLedger(dir);
  ledger.initRoot('root', 1000);
  ledger.addGroup('root', 'p1', 400);

  // Prepare, then "crash": no COMMIT is written before the restart.
  const prepared = ledger.prepare('p1');
  assert.equal(ledger.getView('p1').state, 'PREPARED');
  assert.equal(ledger.getView('root').pending, 400);

  const walBefore = walRecords(dir);
  assert.equal(walBefore.length, 1);
  assert.equal(walBefore[0].op, 'PREPARE');
  assert.equal(walBefore[0].groupId, 'p1');
  assert.deepEqual(walBefore[0].snapshot.states, { p1: 'OPEN' });
  assert.deepEqual(walBefore[0].budgetImpact, { parentId: 'root', amount: 400 });

  // Restart: recovery must roll the uncommitted transaction back.
  const recovered = openLedger(dir);
  assert.equal(recovered.getView('p1').state, 'OPEN');
  const rootView = recovered.getView('root');
  assert.equal(rootView.pending, 0, 'no partial budget deduction may survive');
  assert.equal(rootView.settled, 0);
  assert.equal(rootView.reserved, 400);
  assert.equal(rootView.available, 600);

  const walAfter = walRecords(dir);
  assert.deepEqual(
    walAfter.map((record) => record.op),
    ['PREPARE', 'ROLLBACK'],
  );
  assert.equal(walAfter[1].txId, prepared.txId);

  // Resubmitting the same group succeeds exactly once.
  const reprepared = recovered.prepare('p1');
  assert.notEqual(reprepared.txId, prepared.txId);
  const committed = recovered.commit('p1');
  assert.equal(committed.state, 'SETTLED');
  const finalRoot = recovered.getView('root');
  assert.equal(finalRoot.pending, 0);
  assert.equal(finalRoot.settled, 400, 'budget deducted exactly once');
  assert.equal(finalRoot.available, 600);

  assert.deepEqual(
    walRecords(dir).map((record) => record.op),
    ['PREPARE', 'ROLLBACK', 'PREPARE', 'COMMIT'],
  );
});

test('committed transactions are never rolled back by recovery', () => {
  const dir = tempDir();
  const ledger = openLedger(dir);
  ledger.initRoot('root', 1000);
  ledger.addGroup('root', 'p1', 400);
  ledger.prepare('p1');
  ledger.commit('p1');

  const recovered = openLedger(dir);
  assert.equal(recovered.getView('p1').state, 'SETTLED');
  assert.equal(recovered.getView('root').settled, 400);
  assert.equal(recovered.getView('root').pending, 0);
});

test('a later uncommitted prepare is rolled back while earlier commits survive', () => {
  const dir = tempDir();
  const ledger = openLedger(dir);
  ledger.initRoot('root', 1000);
  ledger.addGroup('root', 'p1', 400);
  ledger.addGroup('root', 'p2', 250);
  ledger.prepare('p1');
  ledger.commit('p1');
  ledger.prepare('p2');

  const recovered = openLedger(dir);
  assert.equal(recovered.getView('p1').state, 'SETTLED');
  assert.equal(recovered.getView('p2').state, 'OPEN');
  const rootView = recovered.getView('root');
  assert.equal(rootView.settled, 400);
  assert.equal(rootView.pending, 0);
  assert.equal(rootView.available, 350);
});
