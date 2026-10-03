'use strict';

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toRecord(row, idField) {
  return {
    id: row[idField],
    amount: Number(row.amount),
    currency: row.currency,
    ts: Number(row.timestamp),
  };
}

function subsetsSum(pool, target, maxSize) {
  const items = pool.slice().sort(byId);
  const results = [];
  const chosen = [];
  function dfs(start, sum) {
    if (chosen.length >= 2 && sum === target) {
      results.push(chosen.map((x) => x.id));
    }
    if (chosen.length >= maxSize || sum >= target) return;
    for (let i = start; i < items.length; i++) {
      chosen.push(items[i]);
      dfs(i + 1, sum + items[i].amount);
      chosen.pop();
    }
  }
  dfs(0, 0);
  results.sort((a, b) => (a.join(',') < b.join(',') ? -1 : 1));
  return results;
}

function matchLayer(leftRows, rightRows, windowSec) {
  const left = leftRows.slice().sort(byId);
  const right = rightRows.slice().sort(byId);
  const usedLeft = new Set();
  const usedRight = new Set();
  const matched = [];
  const inWindow = (a, b) => Math.abs(a.ts - b.ts) <= windowSec;

  for (const l of left) {
    const candidates = right
      .filter((r) => !usedRight.has(r.id) && r.currency === l.currency && r.amount === l.amount && inWindow(l, r))
      .map((r) => r.id)
      .sort();
    if (candidates.length > 0) {
      usedLeft.add(l.id);
      usedRight.add(candidates[0]);
      matched.push({ left: [l.id], right: [candidates[0]], amount: l.amount, currency: l.currency, alternatives: candidates });
    }
  }

  for (const l of left) {
    if (usedLeft.has(l.id)) continue;
    const pool = right.filter((r) => !usedRight.has(r.id) && r.currency === l.currency && inWindow(l, r));
    if (pool.length === 0 || pool.length > 16) continue;
    const subsets = subsetsSum(pool, l.amount, 6);
    if (subsets.length > 0) {
      const chosen = subsets[0];
      usedLeft.add(l.id);
      chosen.forEach((id) => usedRight.add(id));
      matched.push({ left: [l.id], right: chosen, amount: l.amount, currency: l.currency, alternatives: subsets });
    }
  }

  for (const r of right) {
    if (usedRight.has(r.id)) continue;
    const pool = left.filter((l) => !usedLeft.has(l.id) && l.currency === r.currency && inWindow(l, r));
    if (pool.length === 0 || pool.length > 16) continue;
    const subsets = subsetsSum(pool, r.amount, 6);
    if (subsets.length > 0) {
      const chosen = subsets[0];
      usedRight.add(r.id);
      chosen.forEach((id) => usedLeft.add(id));
      matched.push({ left: chosen, right: [r.id], amount: r.amount, currency: r.currency, alternatives: subsets });
    }
  }

  return {
    matched,
    unmatchedLeft: left.filter((l) => !usedLeft.has(l.id)).map((l) => l.id),
    unmatchedRight: right.filter((r) => !usedRight.has(r.id)).map((r) => r.id),
  };
}

function reconcile({ channels, clearing, bank, windowSec = 86400 }) {
  const channelRecords = channels.map((r) => toRecord(r, 'txId'));
  const clearingRecords = clearing.map((r) => toRecord(r, 'recordId'));
  const bankRecords = bank.map((r) => toRecord(r, 'receiptId'));
  return {
    channelClearing: matchLayer(channelRecords, clearingRecords, windowSec),
    clearingBank: matchLayer(clearingRecords, bankRecords, windowSec),
  };
}

module.exports = { reconcile, matchLayer, subsetsSum, toRecord };
