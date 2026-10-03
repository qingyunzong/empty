'use strict';

const { depsOf } = require('./collector');

// Independent reference ledger used by tests: group by acct, order by
// branchSeq, fold effective amounts (reversal negates its target).
function referenceBalances(events) {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const memo = new Map();
  function eff(e) {
    if (memo.has(e.eventId)) return memo.get(e.eventId);
    const v = e.reversalOf ? -eff(byId.get(e.reversalOf)) : e.amount;
    memo.set(e.eventId, v);
    return v;
  }
  const perAcct = new Map();
  for (const e of events) {
    if (!perAcct.has(e.acct)) perAcct.set(e.acct, []);
    perAcct.get(e.acct).push(e);
  }
  const out = {};
  for (const [acct, list] of [...perAcct.entries()].sort()) {
    list.sort((a, b) => a.branchSeq - b.branchSeq);
    out[acct] = list.reduce((sum, e) => sum + eff(e), 0);
  }
  return out;
}

module.exports = { referenceBalances, depsOf };
