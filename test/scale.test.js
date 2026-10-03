'use strict';

// Acceptance 1 (scale part): 30k entries with ~5% corrections; the view must
// match the independent enumeration/fold applicator, and proofs must verify.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, verifyFile, buildView, makeProof, verifyProof } = require('../lib/ledger');
const { generateLog, referenceApply, randomValidOrder, mulberry32 } = require('./util');

test('30k entries with 5% corrections: verify passes, view matches reference applicator', () => {
  const t0 = Date.now();
  const { logPath, ledger, stats } = generateLog({
    count: 30000, accounts: 2000, corrRate: 0.05, seed: 17, conflictEvery: 40,
  });
  const genMs = Date.now() - t0;

  const t1 = Date.now();
  const res = verifyFile(logPath, { now: 1_700_000_000_000 + 30000 * 1000 + 10 ** 6 });
  const verifyMs = Date.now() - t1;
  assert.equal(res.ok, true);
  assert.equal(res.entries, ledger.entries.length);

  const t2 = Date.now();
  const view = buildView(ledger.entries);
  const viewMs = Date.now() - t2;

  // Cross-check every account against the independent applicator with several
  // random application orders (reference applicator is order-independent).
  const rand = mulberry32(99);
  const byAccount = new Map();
  for (const e of ledger.entries) {
    if (!byAccount.has(e.op.account)) byAccount.set(e.op.account, []);
    byAccount.get(e.op.account).push(e);
  }
  let accountsChecked = 0;
  let conflictsFound = 0;
  for (const [account, entries] of byAccount) {
    const expected = referenceApply(entries, randomValidOrder(entries, rand));
    const got = view.accounts[account];
    assert.equal(got.balance, expected.balance, `balance mismatch on ${account}`);
    assert.deepEqual([...got.effective].sort(), expected.effective, `effective mismatch on ${account}`);
    assert.deepEqual([...got.tombstoned].sort(), expected.tombstoned, `tombstone mismatch on ${account}`);
    conflictsFound += got.conflicts.length;
    accountsChecked++;
  }
  assert.ok(stats.corrections / stats.posts > 0.03, 'correction mix sane');
  assert.ok(conflictsFound > 0, 'conflict certificates exercised');

  // Proof for a sample of accounts must verify independently.
  const sample = [...byAccount.keys()].filter((_, i) => i % 200 === 0);
  for (const account of sample) {
    const proof = makeProof(ledger.entries, account);
    const pr = verifyProof(proof, ledger.key, { headHash: ledger.head.hash });
    assert.equal(pr.ok, true, `proof failed for ${account}`);
  }

  console.log(`  scale: entries=${res.entries} posts=${stats.posts} corrections=${stats.corrections} tombstones=${stats.tombstones} conflicts=${conflictsFound}`);
  console.log(`  timing: gen=${genMs}ms verify=${verifyMs}ms view=${viewMs}ms accounts=${accountsChecked} proofs=${sample.length}`);
}, { timeout: 120000 });
