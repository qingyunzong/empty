import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger, LedgerError, hashTx } from '../src/ledger.js';
import { makeDir, mulberry32 } from './helpers.js';

// Independent brute-force reference: enumerate every keep-subset of free
// NORMAL transactions and find the minimum cardinality that preserves
// per-account totals (required = sum of ALL NORMAL amounts per account,
// since every REVERSAL is kept and reversed NORMALs are dropped).
function bruteForce(suffix) {
  const reversedIds = new Set(
    suffix.filter((t) => t.kind === 'REVERSAL').map((t) => t.id.slice(4)),
  );
  const free = [];
  const required = new Map();
  suffix.forEach((tx, index) => {
    if (tx.kind !== 'NORMAL') return;
    required.set(tx.account, (required.get(tx.account) ?? 0) + tx.amount);
    if (!reversedIds.has(tx.id)) free.push(index);
  });
  let best = null;
  for (let mask = 0; mask < 1 << free.length; mask++) {
    const sums = new Map();
    let size = 0;
    for (let j = 0; j < free.length; j++) {
      if (!(mask & (1 << j))) continue;
      size++;
      const tx = suffix[free[j]];
      sums.set(tx.account, (sums.get(tx.account) ?? 0) + tx.amount);
    }
    const accounts = new Set([...required.keys(), ...sums.keys()]);
    let ok = true;
    for (const account of accounts) {
      if ((sums.get(account) ?? 0) !== (required.get(account) ?? 0)) {
        ok = false;
        break;
      }
    }
    if (ok && (best === null || size < best)) best = size;
  }
  return best; // null => unsatisfiable
}

function buildSuffix(ledger, rand, n) {
  const suffix = [];
  let counter = 0;
  for (let i = 0; i < n; i++) {
    const reversible = suffix.filter(
      (t) => t.kind === 'NORMAL' && !suffix.some((r) => r.id === `REV-${t.id}`),
    );
    if (reversible.length > 0 && rand() < 0.35) {
      const target = reversible[Math.floor(rand() * reversible.length)];
      suffix.push(ledger.reverse(target.id).tx);
    } else {
      counter++;
      const amount = Math.floor(rand() * 11) - 5;
      const account = ['A', 'B', 'C'][Math.floor(rand() * 3)];
      const { tx } = ledger.append({
        id: `t${counter}`,
        amount,
        account,
        kind: 'NORMAL',
        payloadHash: `ph-${counter}`,
      });
      suffix.push(tx);
    }
  }
  return suffix;
}

test('rewrite enumerations for n<=7 unpublished txs preserve nets and causality', () => {
  const TRIALS = 60;
  let satisfiable = 0;
  let unsatisfiable = 0;
  for (let seed = 1; seed <= TRIALS; seed++) {
    const rand = mulberry32(seed);
    const dir = makeDir();
    const ledger = Ledger.init(dir);
    ledger.append({ id: 'anchor', amount: 1, account: 'reserve', kind: 'NORMAL', payloadHash: 'ph-a' });

    const n = 1 + Math.floor(rand() * 7);
    const suffix = buildSuffix(ledger, rand, n);
    assert.ok(suffix.length >= 1 && suffix.length <= 7);

    const chainBefore = ledger.loadChain();
    const anchorHash = hashTx(chainBefore[0]);
    const prefixFile = path.join(dir, 'txs', `${anchorHash}.json`);
    const prefixBytes = fs.readFileSync(prefixFile, 'utf8');
    const accountsBefore = ledger.verify().accounts;

    // determinism reference: an identical copy must rewrite identically
    const dirCopy = makeDir();
    fs.cpSync(dir, dirCopy, { recursive: true });

    const expectedMinFree = bruteForce(suffix);
    let result = null;
    let error = null;
    try {
      result = ledger.rewrite(anchorHash);
    } catch (e) {
      error = e;
    }

    if (expectedMinFree === null) {
      unsatisfiable++;
      assert.ok(error instanceof LedgerError, `seed ${seed}: expected UNSATISFIABLE`);
      assert.equal(error.code, 'UNSATISFIABLE', `seed ${seed}`);
      assert.equal(error.exitCode, 2, `seed ${seed}`);
      // failed rewrite must not mutate the chain
      assert.deepEqual(ledger.verify().accounts, accountsBefore, `seed ${seed}`);
      continue;
    }

    satisfiable++;
    assert.equal(error, null, `seed ${seed}: ${error}`);
    const reversalCount = suffix.filter((t) => t.kind === 'REVERSAL').length;
    assert.equal(result.kept.length, reversalCount + expectedMinFree, `seed ${seed}: minimality`);

    // every REVERSAL is kept, in original relative order (causality)
    const keptReversals = result.kept.filter((id) => id.startsWith('REV-'));
    const originalReversals = suffix.filter((t) => t.kind === 'REVERSAL').map((t) => t.id);
    assert.deepEqual(keptReversals, originalReversals, `seed ${seed}: reversal causality`);

    // kept set preserves original relative order overall
    const keptSet = new Set(result.kept);
    const expectedOrder = suffix.filter((t) => keptSet.has(t.id)).map((t) => t.id);
    assert.deepEqual(result.kept, expectedOrder, `seed ${seed}: stable order`);

    // per-account nets unchanged
    const after = ledger.verify();
    const allAccounts = new Set([...Object.keys(accountsBefore), ...Object.keys(after.accounts)]);
    for (const account of allAccounts) {
      assert.equal(
        after.accounts[account] ?? 0,
        accountsBefore[account] ?? 0,
        `seed ${seed}: net for account ${account}`,
      );
    }

    // published prefix untouched, chain re-anchored correctly
    assert.equal(fs.readFileSync(prefixFile, 'utf8'), prefixBytes, `seed ${seed}: prefix bytes`);
    const chainAfter = ledger.loadChain();
    assert.equal(hashTx(chainAfter[0]), anchorHash, `seed ${seed}: prefix hash`);
    assert.equal(chainAfter.length, 1 + result.kept.length, `seed ${seed}`);
    assert.equal(after.published, anchorHash, `seed ${seed}: published marker`);

    // determinism: the copy rewrites to the same kept set
    const replay = new Ledger(dirCopy).rewrite(anchorHash);
    assert.deepEqual(replay.kept, result.kept, `seed ${seed}: determinism`);
  }
  assert.ok(satisfiable > 0, 'expected at least one satisfiable trial');
  assert.ok(unsatisfiable > 0, 'expected at least one unsatisfiable trial');
});
