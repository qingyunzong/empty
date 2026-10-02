'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');

const MAX_N = 12;

function makeDeltaOps(mask, pos, refEntries) {
  const account = 'acct' + ((mask + pos) % 4);
  if (pos % 5 === 4) {
    for (let i = refEntries.length - 1; i >= 0; i -= 1) {
      if (refEntries[i].ops.every((op) => op.type === 'add')) {
        return [{ type: 'undo', seq: refEntries[i].seq }];
      }
    }
  }
  if (pos % 3 === 2) {
    return [{ type: 'correct', account, balance: (mask * 7 + pos * 3) % 100 }];
  }
  return [{ type: 'add', account, amount: ((mask >> (pos % 8)) & 3) + 1 }];
}

function refApply(ref, ops) {
  for (const op of ops) {
    if (op.type === 'add') {
      ref.accounts[op.account] = (ref.accounts[op.account] || 0) + op.amount;
    } else if (op.type === 'correct') {
      ref.accounts[op.account] = op.balance;
    } else if (op.type === 'undo') {
      const target = ref.entries.find((e) => e.seq === op.seq);
      for (const top of target.ops) {
        ref.accounts[top.account] = (ref.accounts[top.account] || 0) - top.amount;
      }
    }
  }
}

test(`enumerate all snapshot+delta combinations for n<=${MAX_N} and reconcile balances`, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-enum-'));
  let combos = 0;
  let snapshotsWritten = 0;
  let deltasAppended = 0;

  for (let n = 1; n <= MAX_N; n += 1) {
    for (let mask = 0; mask < (1 << n); mask += 1) {
      const dir = path.join(root, `n${n}-m${mask}`);
      const ref = { accounts: {}, entries: [] };
      for (let pos = 0; pos < n; pos += 1) {
        const isSnapshot = ((mask >> pos) & 1) === 1;
        if (isSnapshot) {
          store.writeSnapshot(dir, { accounts: Object.assign({}, ref.accounts) }, { fsync: false, chunkSize: 64 });
          snapshotsWritten += 1;
        } else {
          const ops = makeDeltaOps(mask, pos, ref.entries);
          const entry = store.appendDelta(dir, ops, { fsync: false });
          ref.entries.push({ seq: entry.seq, ops });
          refApply(ref, ops);
          deltasAppended += 1;
        }
      }
      const result = store.restore(dir);
      assert.deepStrictEqual(
        result.state.accounts,
        ref.accounts,
        `balance mismatch for n=${n} mask=${mask.toString(2).padStart(n, '0')}`
      );
      const expectedHash = store.sha256(store.serializeState({ accounts: ref.accounts }));
      assert.strictEqual(result.finalStateHash, expectedHash);
      combos += 1;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  t.diagnostic(`combos=${combos} snapshots=${snapshotsWritten} deltas=${deltasAppended}`);
  assert.strictEqual(combos, 2 ** (MAX_N + 1) - 2);
});
