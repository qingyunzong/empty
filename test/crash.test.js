'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { TxStore } = require('../lib/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'g17-crash-'));
}

test('committed transaction persists both balance and freeze', () => {
  const dir = tmpdir();
  const store = new TxStore(dir);
  store.tx((bal, frz) => { bal.A = 10; frz.A = 10; });
  store.tx((bal, frz) => { bal.A -= 4; frz.A -= 4; });
  assert.deepEqual(new TxStore(dir).snapshot(), { balance: { A: 6 }, freeze: { A: 6 } });
  assert.equal(fs.existsSync(path.join(dir, 'journal.json')), false);
});

test('crash after balance commit but before freeze commit: recovery rolls back both sides', () => {
  const dir = tmpdir();
  // setup: sale of 10 -> balance 10, frozen 10 (committed)
  new TxStore(dir).tx((bal, frz) => { bal.A = 10; frz.A = 10; });

  // real process crash mid-transaction: refund 4 commits balance, dies before freeze
  const child = spawnSync(process.execPath, ['-e', `
    const { TxStore } = require(${JSON.stringify(path.resolve('lib/store.js'))});
    const store = new TxStore(process.argv[1], { afterBalanceWrite: () => process.exit(1) });
    store.tx((bal, frz) => { bal.A -= 4; frz.A -= 4; });
  `, dir], { stdio: 'inherit' });
  assert.notEqual(child.status, 0, 'child must crash');

  // mid-crash observation: balance moved, freeze did not, journal present
  const crashed = new TxStore(dir).snapshot();
  assert.deepEqual(crashed.balance, { A: 6 }, 'balance committed before crash');
  assert.deepEqual(crashed.freeze, { A: 10 }, 'freeze not committed');
  assert.equal(fs.existsSync(path.join(dir, 'journal.json')), true);

  // recovery: both sides consistently rolled back to pre-transaction images
  const recovered = new TxStore(dir);
  assert.equal(recovered.recover(), true);
  assert.deepEqual(recovered.snapshot(), { balance: { A: 10 }, freeze: { A: 10 } });
  assert.equal(fs.existsSync(path.join(dir, 'journal.json')), false);

  // post-recovery transactions behave normally
  recovered.tx((bal, frz) => { bal.A -= 4; frz.A -= 4; });
  assert.deepEqual(new TxStore(dir).snapshot(), { balance: { A: 6 }, freeze: { A: 6 } });
});

test('recover() is a no-op when no journal exists', () => {
  const dir = tmpdir();
  const store = new TxStore(dir);
  store.tx((bal, frz) => { bal.A = 3; frz.A = 3; });
  assert.equal(new TxStore(dir).recover(), false);
  assert.deepEqual(new TxStore(dir).snapshot(), { balance: { A: 3 }, freeze: { A: 3 } });
});
