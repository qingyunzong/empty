'use strict';

// Backtracking assignment of transactions to batches with forward-checking
// propagation: after every assignment, any unassigned transaction whose
// remaining feasible routes are all infeasible prunes the branch.
function solveInstance(txs, batchIds, capacityOf) {
  const remaining = new Map();
  for (const tx of txs) {
    if (!remaining.has(tx.account)) remaining.set(tx.account, new Map());
  }
  for (const [account, per] of remaining) {
    for (const b of batchIds) per.set(b, capacityOf(account, b));
  }

  const ordered = [...txs].sort((x, y) =>
    x.domain.length - y.domain.length || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const tx of ordered) {
    if (tx.domain.length === 0) return { ok: false, assignment: null };
  }

  const assignment = new Map();
  const feasible = (tx) => tx.domain.some((b) => remaining.get(tx.account).get(b) >= tx.amount);

  function bt(index) {
    if (index === ordered.length) return true;
    const tx = ordered[index];
    const per = remaining.get(tx.account);
    for (const b of tx.domain) {
      if (per.get(b) < tx.amount) continue;
      per.set(b, per.get(b) - tx.amount);
      assignment.set(tx.id, b);
      let propagates = true;
      for (let j = index + 1; j < ordered.length; j++) {
        if (!feasible(ordered[j])) { propagates = false; break; }
      }
      if (propagates && bt(index + 1)) return true;
      assignment.delete(tx.id);
      per.set(b, per.get(b) + tx.amount);
    }
    return false;
  }

  return bt(0) ? { ok: true, assignment } : { ok: false, assignment: null };
}

const pairKey = (account, batch) => JSON.stringify([account, batch]);

// Minimal (by inclusion, via deletion) set of account-batch pairs such that the
// transactions whose routes are entirely contained in the set are still UNSAT.
function minimalConflict(txs, batchIds, capacityOf) {
  const all = new Set();
  for (const tx of txs) for (const b of tx.domain) all.add(pairKey(tx.account, b));

  const restrictedUnsat = (set) => {
    const contained = txs.filter((tx) => tx.domain.every((b) => set.has(pairKey(tx.account, b))));
    if (contained.length === 0) return false;
    return !solveInstance(contained, batchIds, capacityOf).ok;
  };

  let current = new Set(all);
  if (!restrictedUnsat(current)) return null;
  for (const key of [...current]) {
    const trial = new Set(current);
    trial.delete(key);
    if (restrictedUnsat(trial)) current = trial;
  }
  return [...current].sort().map((k) => {
    const [account, batch] = JSON.parse(k);
    return { account, batch };
  });
}

function plan(txs, batchIds, capacityOf) {
  const result = solveInstance(txs, batchIds, capacityOf);
  if (result.ok) return { ok: true, assignment: result.assignment };
  return { ok: false, conflict: minimalConflict(txs, batchIds, capacityOf) || [] };
}

module.exports = { solveInstance, minimalConflict, plan };
