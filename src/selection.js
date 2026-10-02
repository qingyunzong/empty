'use strict';

const { BusinessError } = require('./errors');

const MAX_TRANSFERS = 10;

function compareIdSeq(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// transfers: [{id, from, to, amount}]
// budgets: {participant: maxNetOutflow} (remaining budget; missing = unlimited)
// Returns the settleable subset as a sorted array of transfer ids:
// maximum cardinality; ties broken by lexicographically smallest id sequence.
function selectSettleable(transfers, budgets) {
  if (transfers.length > MAX_TRANSFERS) {
    throw new BusinessError(`too many transfers: ${transfers.length} (max ${MAX_TRANSFERS})`);
  }
  const n = transfers.length;
  let best = null;
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    const net = new Map();
    const ids = [];
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const t = transfers[i];
      net.set(t.from, (net.get(t.from) || 0) + t.amount);
      net.set(t.to, (net.get(t.to) || 0) - t.amount);
      ids.push(t.id);
    }
    let feasible = true;
    for (const [p, v] of net) {
      const limit = budgets[p] === undefined ? Infinity : budgets[p];
      if (v > limit) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;
    ids.sort();
    if (
      best === null ||
      ids.length > best.length ||
      (ids.length === best.length && compareIdSeq(ids, best) < 0)
    ) {
      best = ids;
    }
  }
  return best;
}

module.exports = { selectSettleable, compareIdSeq, MAX_TRANSFERS };
