'use strict';

const { ERR_ORPHAN } = require('./errors');

const toCents = (v) => Math.round(Number(v) * 100);

function normalize(rows, layer) {
  return rows.map((r) => ({
    recordId: r.recordId || r.id,
    batchId: r.batchId || '',
    customerId: r.customerId || '',
    amount: toCents(r.amount),
    currency: r.currency,
    time: Date.parse(r.timestamp),
    layer,
  })).sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
}

// All minimum-size subsets of candidates whose amounts sum to target.
// Each subset is a sorted id array; the list is sorted lexicographically.
function subsetSums(candidates, target, cap = 12) {
  const pool = candidates.slice(0, cap);
  const n = pool.length;
  let best = Infinity;
  const found = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    const size = popcount(mask);
    if (size < 2 || size > best) continue;
    let sum = 0;
    const ids = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += pool[i].amount; ids.push(pool[i].recordId); }
    }
    if (sum === target) {
      if (size < best) { best = size; found.length = 0; }
      found.push(ids.sort());
    }
  }
  found.sort(compareTuples);
  return found;
}

function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
function compareTuples(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// Match each target record to one or many source records (equal total amount,
// same currency, within the time window). Tied matches are all listed in
// `candidates`; the lexicographically smallest one is chosen.
function matchLayer(targets, sources, usedSourceIds, windowMs, label) {
  const matches = [];
  for (const t of targets) {
    const pool = sources.filter((s) =>
      !usedSourceIds.has(s.recordId) &&
      s.currency === t.currency &&
      Math.abs(s.time - t.time) <= windowMs);
    const exact = pool.filter((s) => s.amount === t.amount).map((s) => s.recordId).sort();
    if (exact.length > 0) {
      const chosen = exact[0];
      usedSourceIds.add(chosen);
      matches.push({
        layer: label, target: t.recordId, sources: [chosen],
        amount: t.amount, currency: t.currency,
        candidates: exact.map((id) => [id]), chosen: [chosen],
      });
      continue;
    }
    const subs = subsetSums(pool, t.amount);
    if (subs.length > 0) {
      const chosen = subs[0];
      for (const id of chosen) usedSourceIds.add(id);
      matches.push({
        layer: label, target: t.recordId, sources: chosen,
        amount: t.amount, currency: t.currency,
        candidates: subs, chosen,
      });
    }
  }
  return matches;
}

// Three-layer reconciliation: channel -> clearing -> bank.
function reconcile(input, opts = {}) {
  const windowMs = (opts.windowSec ?? 300) * 1000;
  const channel = normalize(input.channel || [], 'channel');
  const clearing = normalize(input.clearing || [], 'clearing');
  const bank = normalize(input.bank || [], 'bank');

  const usedChannel = new Set();
  const usedClearing = new Set();
  const matched = [
    ...matchLayer(clearing, channel, usedChannel, windowMs, 'clearing<->channel'),
    ...matchLayer(bank, clearing, usedClearing, windowMs, 'bank<->clearing'),
  ];

  const matchedClearingTargets = new Set(
    matched.filter((m) => m.layer === 'clearing<->channel').map((m) => m.target));
  const matchedBankTargets = new Set(
    matched.filter((m) => m.layer === 'bank<->clearing').map((m) => m.target));

  const unmatched = {
    channel: channel.filter((c) => !usedChannel.has(c.recordId)).map(publicRecord),
    clearing: clearing.filter((c) => !matchedClearingTargets.has(c.recordId)).map(publicRecord),
    bank: bank.filter((b) => !matchedBankTargets.has(b.recordId)).map(publicRecord),
    orphans: bank.filter((b) => !matchedBankTargets.has(b.recordId))
      .map((b) => Object.assign(publicRecord(b), { code: ERR_ORPHAN, reason: 'orphan bank receipt' })),
  };
  return { matched, unmatched };
}

function publicRecord(r) {
  return { recordId: r.recordId, batchId: r.batchId, amount: r.amount, currency: r.currency };
}

module.exports = { reconcile, subsetSums, toCents };
