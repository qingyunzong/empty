'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../lib/ledger');

const BASE = {
  alice: { credit: 100000 },
  bob: { credit: 100000 },
  seller1: { position: 1000 },
  seller2: { position: 1000 },
};

// 8 transactions, several with multiple partial fills.
const PUTS = [
  { txId: 'tx1', buyer: 'alice', seller: 'seller1', qty: 4, price: 10 },
  { txId: 'tx2', buyer: 'bob', seller: 'seller2', qty: 2, price: 20 },
  { txId: 'tx1', buyer: 'alice', seller: 'seller1', qty: 3, price: 10 },
  { txId: 'tx3', buyer: 'bob', seller: 'seller1', qty: 5, price: 8 },
  { txId: 'tx4', buyer: 'alice', seller: 'seller2', qty: 1, price: 50 },
  { txId: 'tx3', buyer: 'bob', seller: 'seller1', qty: 5, price: 8 },
  { txId: 'tx5', buyer: 'alice', seller: 'seller1', qty: 6, price: 10 },
  { txId: 'tx6', buyer: 'bob', seller: 'seller1', qty: 3, price: 8 },
  { txId: 'tx7', buyer: 'alice', seller: 'seller2', qty: 2, price: 20 },
  { txId: 'tx3', buyer: 'bob', seller: 'seller1', qty: 2, price: 8 },
  { txId: 'tx8', buyer: 'bob', seller: 'seller2', qty: 4, price: 50 },
  { txId: 'tx7', buyer: 'alice', seller: 'seller2', qty: 1, price: 20 },
];

const CANCELLED = ['tx1', 'tx3', 'tx5', 'tx7'];

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txlog-perm-'));
  return path.join(dir, name);
}

// Independent reference model: apply fills, then void cancelled txs.
function referenceFinalState() {
  const accounts = {};
  for (const [name, a] of Object.entries(BASE)) {
    accounts[name] = { credit: a.credit || 0, frozen: 0, position: a.position || 0 };
  }
  const txs = {};
  const acc = (n) => (accounts[n] = accounts[n] || { credit: 0, frozen: 0, position: 0 });
  for (const p of PUTS) {
    const tx = (txs[p.txId] = txs[p.txId] || { executed: 0, cancelled: false });
    acc(p.buyer).frozen += p.qty * p.price;
    acc(p.buyer).position += p.qty;
    acc(p.seller).position -= p.qty;
    tx.executed += p.qty;
  }
  for (const id of CANCELLED) {
    txs[id].cancelled = true;
    const executed = txs[id].executed;
    const puts = PUTS.filter((p) => p.txId === id);
    acc(puts[0].buyer).frozen = 0;
    // release per-tx frozen only; other txs of same buyer keep theirs
    const buyer = puts[0].buyer;
    accounts[buyer].frozen = PUTS.filter((p) => p.buyer === buyer && !CANCELLED.includes(p.txId))
      .reduce((s, p) => s + p.qty * p.price, 0);
    acc(buyer).position -= executed;
    acc(puts[0].seller).position += executed;
  }
  return { accounts, txs };
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const perm of permutations(rest)) {
      yield [arr[i], ...perm];
    }
  }
}

test('8 txs with partial fills: final state independent of cancel arrival order', () => {
  const expected = referenceFinalState();
  let count = 0;
  for (const order of permutations(CANCELLED)) {
    count++;
    const file = tmpFile('log.bin');
    const ledger = new Ledger(file, BASE);
    for (const p of PUTS) ledger.put(p);
    for (const txId of order) ledger.cancel(txId);

    const { state } = ledger.replay();
    assert.deepEqual(state.accounts, expected.accounts, `accounts differ for cancel order ${order}`);
    assert.deepEqual(state.txs, expected.txs, `txs differ for cancel order ${order}`);

    // Persistence: reopening the file and replaying yields the same state.
    const reopened = new Ledger(file, BASE);
    const again = reopened.replay();
    assert.deepEqual(again.state.accounts, expected.accounts, `reopen differs for order ${order}`);
    assert.equal(again.blocks, PUTS.length + CANCELLED.length);
  }
  assert.equal(count, 24, 'expected 4! = 24 cancel orders');
});

test('reference expectations are sane', () => {
  const expected = referenceFinalState();
  // tx1: 7@10, tx5: 6@10, tx7: 3@20 cancelled -> alice frozen only from tx4 (1@50)
  assert.equal(expected.accounts.alice.frozen, 50);
  // alice positions: (4+3+1+6+2+1) - (7+6+3) = 17 - 16 = 1
  assert.equal(expected.accounts.alice.position, 1);
  // bob: nothing cancelled among tx2,tx4? tx4 is alice. bob txs: tx2,tx3(cancelled),tx6,tx8
  assert.equal(expected.accounts.bob.frozen, 2 * 20 + 3 * 8 + 4 * 50);
  assert.equal(expected.accounts.bob.position, 2 + 12 + 3 + 4 - 12);
});
