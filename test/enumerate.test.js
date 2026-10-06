'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const solver = require('../lib/solver');

const BATCHES = [
  { id: 'B1', start: '2026-10-06T09:00:00Z', end: '2026-10-06T10:00:00Z' },
  { id: 'B2', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z' },
];
const ALL_BATCH_IDS = BATCHES.map((b) => b.id);

// Reference: brute-force enumeration of every assignment of transactions to
// allowed batches, checking per-account per-batch capacity directly.
function bruteForceSat(transactions, accounts) {
  const domains = solver.buildDomains(transactions, BATCHES);
  const limits = new Map();
  for (const a of accounts) {
    for (const b of BATCHES) limits.set(solver.keyOf(a.id, b.id), a.limit);
  }
  const used = new Map();
  function dfs(i) {
    if (i === transactions.length) return true;
    const tx = transactions[i];
    for (const b of domains.get(tx.id)) {
      const k = solver.keyOf(tx.account, b);
      const next = (used.get(k) || 0) + tx.amount;
      if (next <= limits.get(k)) {
        used.set(k, next);
        if (dfs(i + 1)) return true;
        used.set(k, used.get(k) - tx.amount);
      }
    }
    return false;
  }
  return dfs(0);
}

function candidateKeys(transactions) {
  const keys = new Set();
  for (const tx of transactions) {
    const dom = tx.windows === undefined ? ALL_BATCH_IDS : tx.windows;
    for (const b of dom) keys.add(solver.keyOf(tx.account, b));
  }
  return keys;
}

function* cases() {
  const amounts = [10, 20];
  const limits = [10, 20, 30];
  const domainChoices = [['B1'], ['B2'], ['B1', 'B2'], []];
  for (let n = 1; n <= 3; n++) {
    for (const limit of limits) {
      for (let ai = 0; ai < amounts.length ** n; ai++) {
        for (let di = 0; di < domainChoices.length ** n; di++) {
          const transactions = [];
          let x = ai;
          let y = di;
          for (let i = 0; i < n; i++) {
            transactions.push({
              id: `T${i}`,
              account: 'A',
              amount: amounts[x % amounts.length],
              windows: domainChoices[y % domainChoices.length].slice(),
            });
            x = Math.floor(x / amounts.length);
            y = Math.floor(y / domainChoices.length);
          }
          yield { transactions, accounts: [{ id: 'A', limit }] };
        }
      }
    }
  }
}

test('solver verdict matches brute-force enumeration (<=3 txs, 2 batches)', () => {
  let checked = 0;
  let satCount = 0;
  for (const { transactions, accounts } of cases()) {
    const limit = accounts[0].limit;
    const expected = bruteForceSat(transactions, accounts);
    const assignment = solver.solve(transactions, BATCHES, accounts, null);
    assert.equal(
      assignment !== null,
      expected,
      `verdict mismatch for ${JSON.stringify(transactions)} limit=${limit}`
    );
    if (assignment !== null) {
      satCount++;
      // Every transaction is routed inside its allowed windows and no
      // account-batch freeze exceeds the limit.
      const used = new Map();
      for (const tx of transactions) {
        const b = assignment.get(tx.id);
        const dom = tx.windows === undefined ? ALL_BATCH_IDS : tx.windows;
        assert.ok(dom.includes(b), `${tx.id} routed outside allowed windows`);
        const k = solver.keyOf(tx.account, b);
        used.set(k, (used.get(k) || 0) + tx.amount);
        assert.ok(used.get(k) <= limit, `freeze exceeds limit at ${k}`);
      }
    } else {
      // UNSAT: the conflict set alone must be unsatisfiable...
      const conflict = solver.minimalConflict(transactions, BATCHES, accounts);
      const keys = new Set(conflict.map((c) => solver.keyOf(c.account, c.batch)));
      const candidates = candidateKeys(transactions);
      const relaxNonConflict = new Set([...candidates].filter((k) => !keys.has(k)));
      assert.equal(
        solver.solve(transactions, BATCHES, accounts, relaxNonConflict),
        null,
        'conflict set is satisfiable'
      );
      // ...and minimal: additionally relaxing any single member restores SAT.
      for (const k of keys) {
        const relaxed = new Set(relaxNonConflict);
        relaxed.add(k);
        assert.notEqual(
          solver.solve(transactions, BATCHES, accounts, relaxed),
          null,
          `conflict not minimal at ${k}`
        );
      }
    }
    checked++;
  }
  assert.ok(checked > 0);
  assert.ok(satCount > 0);
  assert.ok(satCount < checked);
  console.log(`enumeration cross-check: ${checked} cases, ${satCount} SAT, ${checked - satCount} UNSAT`);
});
