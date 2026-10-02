'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshDb, applyRow, reverseRow, replay } = require('../lib/core');

// Enumerate every linear extension (total order) of the event poset:
// k pairs (txn_i, undo_i) with undo_i after txn_i, plus one extra txn when n is odd.
// Replays each order through the real ledger ops and compares final balances.
function enumerateAllOrders(k, extra, canonicalAccounts, canonicalConflicts) {
  const total = 2 * k + (extra ? 1 : 0);
  const rows = [];
  for (let i = 0; i < k; i++) {
    rows.push({ id: 't' + i, account: 'acc' + i, amount_cents: 100 * (i + 1) });
  }
  for (let i = 0; i < k; i++) {
    rows.push({ id: 'u' + i, undo: 't' + i });
  }
  if (extra) rows.push({ id: 'tx', account: 'accX', amount_cents: 7 });

  const db = freshDb();
  const done = new Array(total).fill(false);
  let count = 0;
  let mismatches = 0;
  const canonicalKeys = Object.keys(canonicalAccounts).sort();

  function available(i) {
    if (done[i]) return false;
    if (i >= k && i < 2 * k) return done[i - k]; // undo only after its txn
    return true;
  }

  function check() {
    count++;
    if (db.conflicts.length !== canonicalConflicts) {
      mismatches++;
      return;
    }
    const keys = Object.keys(db.accounts);
    if (keys.length !== canonicalKeys.length) {
      mismatches++;
      return;
    }
    for (const key of canonicalKeys) {
      if (db.accounts[key] !== canonicalAccounts[key]) {
        mismatches++;
        return;
      }
    }
  }

  function bt(depth) {
    if (depth === total) {
      check();
      return;
    }
    for (let i = 0; i < total; i++) {
      if (!available(i)) continue;
      done[i] = true;
      applyRow(db, rows[i]);
      bt(depth + 1);
      reverseRow(db, rows[i]);
      done[i] = false;
    }
  }
  bt(0);
  return { count, mismatches };
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

test('exhaustive total-order replay for n<=12 yields identical final balances', () => {
  for (let n = 1; n <= 12; n++) {
    const k = Math.floor(n / 2);
    const extra = n % 2 === 1;
    const rows = [];
    for (let i = 0; i < k; i++) {
      rows.push({ id: 't' + i, account: 'acc' + i, amount_cents: 100 * (i + 1) });
      rows.push({ id: 'u' + i, undo: 't' + i });
    }
    if (extra) rows.push({ id: 'tx', account: 'accX', amount_cents: 7 });
    const canonical = replay(rows);
    const { count, mismatches } = enumerateAllOrders(k, extra, canonical.accounts, canonical.conflicts.length);
    const expected = factorial(n) / 2 ** k;
    assert.strictEqual(count, expected, 'n=' + n + ': expected ' + expected + ' linear extensions');
    assert.strictEqual(mismatches, 0, 'n=' + n + ': ' + mismatches + ' orders produced divergent balances');
  }
});
