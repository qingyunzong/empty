'use strict';
const { SyncError } = require('./util');

function reduceEvents(events, opts = {}) {
  const byTx = new Map();
  for (const e of events) {
    const cur = byTx.get(e.txId);
    if (!cur || e.seq > cur.seq) byTx.set(e.txId, e);
  }
  const effective = [...byTx.values()].sort((a, b) => (a.seq - b.seq) || (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0));

  const txs = new Map();
  const undosByRef = new Map();
  for (const e of effective) {
    if (e.op === 'undo') {
      const list = undosByRef.get(e.ref) || [];
      list.push(e);
      undosByRef.set(e.ref, list);
    } else {
      txs.set(e.txId, e);
    }
  }

  const conflicts = [];
  const undone = new Set();
  for (const [ref, list] of undosByRef) {
    list.sort((a, b) => a.seq - b.seq);
    const target = txs.get(ref);
    if (!target) {
      for (const u of list) conflicts.push({ txId: u.txId, ref, code: 'UNDO_UNKNOWN_REF' });
      continue;
    }
    const valid = list.filter((u) => u.seq > target.seq);
    for (const u of list) {
      if (u.seq <= target.seq) conflicts.push({ txId: u.txId, ref, code: 'STALE_UNDO' });
    }
    if (valid.length === 0) continue;
    undone.add(ref);
    for (let i = 1; i < valid.length; i += 1) {
      conflicts.push({ txId: valid[i].txId, ref, code: 'DUPLICATE_UNDO' });
    }
  }
  conflicts.sort((a, b) => (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0));

  const balances = {};
  for (const [txId, e] of txs) {
    if (undone.has(txId)) continue;
    const bal = balances[e.account] || 0;
    balances[e.account] = e.op === 'credit' ? bal + e.amount : bal - e.amount;
  }

  if (opts.enforceNonNegative) {
    for (const acc of Object.keys(balances).sort()) {
      if (balances[acc] < 0) {
        throw new SyncError('NEGATIVE_BALANCE', `account ${acc} has negative balance ${balances[acc]}`, {
          account: acc, balance: balances[acc],
        });
      }
    }
  }

  return {
    balances,
    conflicts,
    applied: txs.size,
    undone: [...undone].sort(),
  };
}

module.exports = { reduceEvents };
