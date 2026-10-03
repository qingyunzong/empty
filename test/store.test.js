'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store');
const { encodeFrame } = require('../src/wal');
const cli = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'budget-mvcc-'));
}

async function debitWithRetry(store, id, amount, usage) {
  for (;;) {
    const tx = store.begin();
    tx.debit(id, amount, usage);
    try {
      return await tx.commit();
    } catch (err) {
      if (err.code === 'CONFLICT') continue;
      if (err.code === 'BUDGET_EXCEEDED') return null;
      throw err;
    }
  }
}

test('snapshot isolation: readers observe a stable snapshot', async () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  await store.createAccount('a', 100);

  const reader = store.begin();
  assert.equal(reader.getBalance('a'), 100);

  const writer = store.begin();
  writer.debit('a', 40, { resource: 'gpu' });
  await writer.commit();

  assert.equal(reader.getBalance('a'), 100, 'snapshot read must not see the concurrent commit');
  assert.equal(reader.getUsage('a').length, 0);
  assert.equal(store.balanceOf('a'), 60);
  assert.equal(store.usageOf('a').length, 1);
  store.close();
});

test('unknown account raises NO_ACCOUNT', async () => {
  const store = Store.open(tmpdir());
  assert.throws(() => store.balanceOf('ghost'), (e) => e.code === 'NO_ACCOUNT');
  const tx = store.begin();
  assert.throws(() => tx.getBalance('ghost'), (e) => e.code === 'NO_ACCOUNT');
  const tx2 = store.begin();
  tx2.debit('ghost', 10);
  await assert.rejects(tx2.commit(), (e) => e.code === 'NO_ACCOUNT');
  store.close();
});

test('write-write conflict on intersecting write sets raises retryable CONFLICT', async () => {
  const store = Store.open(tmpdir());
  await store.createAccount('a', 100);

  const tx1 = store.begin();
  const tx2 = store.begin();
  tx1.debit('a', 10);
  tx2.debit('a', 20);
  await tx1.commit();
  await assert.rejects(tx2.commit(), (e) => e.code === 'CONFLICT' && e.retryable === true);
  assert.equal(store.balanceOf('a'), 90);
  store.close();
});

test('BUDGET_EXCEEDED aborts the whole transaction with no partial effects', async () => {
  const store = Store.open(tmpdir());
  await store.createAccount('a', 50);
  await store.createAccount('b', 1000);

  const tx = store.begin();
  tx.debit('a', 10);
  tx.debit('b', 5000); // exceeds b's balance
  await assert.rejects(tx.commit(), (e) => e.code === 'BUDGET_EXCEEDED');

  assert.equal(store.balanceOf('a'), 50, 'debit to a must not be applied');
  assert.equal(store.balanceOf('b'), 1000);
  assert.equal(store.usageOf().length, 0, 'no usage record may survive a failed commit');
  store.close();
});

test('persistence: reopening replays accounts and usage records from WAL', async () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  await store.createAccount('a', 100);
  await debitWithRetry(store, 'a', 30, { resource: 'gpu', units: 2 });
  await debitWithRetry(store, 'a', 20, { resource: 'cpu', units: 5 });
  store.close();

  store = Store.open(dir);
  assert.equal(store.balanceOf('a'), 50);
  const usage = store.usageOf('a');
  assert.equal(usage.length, 2);
  assert.deepEqual(usage.map((u) => u.amount), [30, 20]);
  assert.equal(store.getHistory('a').length, 2);
  store.close();
});

test('acceptance 1: balance 100, two concurrent debits of 80 -> exactly one succeeds', async () => {
  const store = Store.open(tmpdir());
  await store.createAccount('acc', 100);

  const attempt = async () => {
    const tx = store.begin();
    tx.debit('acc', 80, { resource: 'gpu-h100', units: 1 });
    try {
      await tx.commit();
      return 'committed';
    } catch (err) {
      return err.code;
    }
  };

  const results = await Promise.all([attempt(), attempt()]);
  const committed = results.filter((r) => r === 'committed');
  assert.equal(committed.length, 1, `exactly one debit may commit, got: ${results}`);
  assert.ok(results.every((r) => r === 'committed' || r === 'CONFLICT'));

  assert.equal(store.balanceOf('acc'), 20);
  const usage = store.usageOf('acc');
  assert.equal(usage.length, 1, 'exactly one usage record must exist');
  assert.equal(usage[0].amount, 80);
  assert.equal(store.balanceOf('acc') + usage.reduce((s, u) => s + u.amount, 0), 100,
    'balance and usage records must reconcile with the initial budget');
  store.close();
});

test('acceptance 2: torn WAL commit frame -> account and usage records both present or both absent', async () => {
  const dir = tmpdir();

  // Commit one full transaction, then simulate a crash that leaves a
  // half-written commit frame (debit of 30) at the tail of the WAL.
  let store = Store.open(dir);
  await store.createAccount('acc', 100);
  await debitWithRetry(store, 'acc', 40, { resource: 'gpu', units: 1 });
  store.close();

  const tornRecord = {
    type: 'commit',
    txid: 99,
    ts: new Date().toISOString(),
    debits: [{ account: 'acc', amount: 30, balanceAfter: 30 }],
    usage: [{ accountId: 'acc', amount: 30, resource: 'gpu', units: 1, ts: new Date().toISOString() }],
  };
  const frame = encodeFrame(tornRecord);
  fs.appendFileSync(path.join(dir, 'wal.log'), frame.subarray(0, Math.floor(frame.length / 2)));

  // Restart: the torn frame must be discarded wholesale. Balance and usage
  // records stay strictly correspondent (both from the intact commit only).
  store = Store.open(dir);
  assert.equal(store.balanceOf('acc'), 60);
  assert.equal(store.usageOf('acc').length, 1);
  assert.equal(store.balanceOf('acc') + store.usageOf('acc').reduce((s, u) => s + u.amount, 0), 100);

  // The store must keep working after recovery (torn tail was truncated).
  await debitWithRetry(store, 'acc', 10, { resource: 'gpu', units: 1 });
  store.close();

  store = Store.open(dir);
  assert.equal(store.balanceOf('acc'), 50);
  assert.equal(store.usageOf('acc').length, 2);
  assert.equal(store.balanceOf('acc') + store.usageOf('acc').reduce((s, u) => s + u.amount, 0), 100);
  store.close();
});

test('acceptance 3: randomized concurrent debits match serial-enumeration reference', async (t) => {
  // Deterministic PRNG (mulberry32) for reproducible runs.
  const rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };

  // Reference: every serial order of the debit requests, each debit applied
  // greedily iff affordable at its turn. Collects all reachable final balances.
  function serialReference(initial, amounts) {
    const finals = new Set();
    const permute = (items, balance) => {
      if (items.length === 0) { finals.add(balance); return; }
      for (let i = 0; i < items.length; i++) {
        const rest = items.slice(0, i).concat(items.slice(i + 1));
        permute(rest, balance); // debit fails (insufficient funds at its turn)
        if (balance >= items[i]) permute(rest, balance - items[i]); // debit succeeds
      }
    };
    permute(amounts, initial);
    return finals;
  }

  for (let seed = 1; seed <= 20; seed++) {
    const rand = rng(seed);
    const initial = 50 + Math.floor(rand() * 151); // 50..200
    const n = 5 + Math.floor(rand() * 4); // 5..8 debits
    const amounts = Array.from({ length: n }, () => 10 + Math.floor(rand() * 81)); // 10..90

    const store = Store.open(tmpdir());
    await store.createAccount('acc', initial);

    const outcomes = await Promise.all(amounts.map((amount) => debitWithRetry(store, 'acc', amount, { resource: 'gpu' })));
    const succeeded = outcomes.filter((r) => r !== null).length;

    const finalBalance = store.balanceOf('acc');
    const usage = store.usageOf('acc');

    const reference = serialReference(initial, amounts);
    assert.ok(reference.has(finalBalance),
      `seed ${seed}: final balance ${finalBalance} not in serial reference set ${[...reference].sort((a, b) => a - b)} (initial=${initial}, amounts=${amounts})`);

    // Strict correspondence: balance and usage records reconcile exactly.
    assert.equal(usage.length, succeeded, `seed ${seed}: usage record count must equal successful debits`);
    assert.equal(finalBalance + usage.reduce((s, u) => s + u.amount, 0), initial,
      `seed ${seed}: balance + usage amounts must equal initial budget`);

    // Persistence agrees: recovered state matches in-memory state.
    store.close();
    const reopened = Store.open(store.dir);
    assert.equal(reopened.balanceOf('acc'), finalBalance);
    assert.equal(reopened.usageOf('acc').length, usage.length);
    reopened.close();
  }
});

test('CLI: create-account / debit / balance / usage / history end to end', async () => {
  const dir = tmpdir();
  const run = async (...args) => {
    const result = await cli.run(args);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const created = await run('create-account', '--db', dir, '--id', 'acc', '--balance', '100');
  assert.equal(created.ok, true);

  const debited = await run('debit', '--db', dir, '--id', 'acc', '--amount', '30', '--resource', 'gpu', '--units', '2');
  assert.equal(debited.ok, true);
  assert.equal(debited.debits[0].balanceAfter, 70);

  const balance = await run('balance', '--db', dir, '--id', 'acc');
  assert.equal(balance.balance, 70);

  const usage = await run('usage', '--db', dir, '--id', 'acc');
  assert.equal(usage.usage.length, 1);
  assert.equal(usage.usage[0].resource, 'gpu');

  const history = await run('history', '--db', dir, '--id', 'acc');
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].debits[0].amount, 30);
});

test('CLI: error conventions NO_ACCOUNT and BUDGET_EXCEEDED', async () => {
  const dir = tmpdir();

  let result = await cli.run(['balance', '--db', dir, '--id', 'ghost']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /NO_ACCOUNT/);

  await cli.run(['create-account', '--db', dir, '--id', 'acc', '--balance', '10']);
  result = await cli.run(['debit', '--db', dir, '--id', 'acc', '--amount', '50']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /BUDGET_EXCEEDED/);

  const balanceResult = await cli.run(['balance', '--db', dir, '--id', 'acc']);
  const balance = JSON.parse(balanceResult.stdout);
  assert.equal(balance.balance, 10, 'failed debit must leave balance untouched');
});
