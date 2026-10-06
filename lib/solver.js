'use strict';

function keyOf(account, batch) {
  return JSON.stringify([account, batch]);
}

// Build per-transaction routing domains (allowed batch windows).
function buildDomains(transactions, batches) {
  const allBatchIds = batches.map((b) => b.id);
  const domains = new Map();
  for (const tx of transactions) {
    domains.set(tx.id, tx.windows === undefined ? allBatchIds.slice() : tx.windows.slice());
  }
  return domains;
}

// Backtracking search with forward-checking propagation of capacity limits.
// capacityOf: (accountId, batchId) -> remaining limit (Infinity when relaxed).
function search(transactions, domains, capacityOf) {
  const assignment = new Map();
  const used = new Map(); // keyOf(account,batch) -> amount frozen so far

  function remaining(account, batch) {
    const cap = capacityOf(account, batch);
    if (cap === Infinity) return Infinity;
    return cap - (used.get(keyOf(account, batch)) || 0);
  }

  // Propagation: a route (tx -> batch) is feasible only if the tentative
  // freeze fits the account's remaining limit in that batch.
  function feasibleBatches(tx) {
    return domains.get(tx.id).filter((b) => remaining(tx.account, b) >= tx.amount);
  }

  function forwardCheck(unassigned) {
    for (const tx of unassigned) {
      if (feasibleBatches(tx).length === 0) return false; // domain wipeout -> infeasible route propagated
    }
    return true;
  }

  function dfs(unassigned) {
    if (unassigned.length === 0) return true;
    // MRV: branch on the transaction with fewest feasible routes.
    let pick = 0;
    let pickOptions = null;
    for (let i = 0; i < unassigned.length; i++) {
      const opts = feasibleBatches(unassigned[i]);
      if (opts.length === 0) return false;
      if (pickOptions === null || opts.length < pickOptions.length) {
        pick = i;
        pickOptions = opts;
        if (opts.length === 1) break;
      }
    }
    const tx = unassigned[pick];
    const rest = unassigned.slice(0, pick).concat(unassigned.slice(pick + 1));
    for (const batchId of pickOptions) {
      const k = keyOf(tx.account, batchId);
      used.set(k, (used.get(k) || 0) + tx.amount);
      assignment.set(tx.id, batchId);
      if (forwardCheck(rest) && dfs(rest)) return true;
      assignment.delete(tx.id);
      used.set(k, used.get(k) - tx.amount);
    }
    return false;
  }

  // Transactions with an empty routing domain are immediately infeasible.
  for (const tx of transactions) {
    if (domains.get(tx.id).length === 0) return null;
  }
  return dfs(transactions.slice()) ? assignment : null;
}

function solve(transactions, batches, accounts, relaxedPairs) {
  const limits = new Map();
  for (const a of accounts) {
    for (const b of batches) limits.set(keyOf(a.id, b.id), a.limit);
  }
  const capacityOf = (accountId, batchId) => {
    const k = keyOf(accountId, batchId);
    if (relaxedPairs && relaxedPairs.has(k)) return Infinity;
    return limits.get(k);
  };
  const domains = buildDomains(transactions, batches);
  return search(transactions, domains, capacityOf);
}

// Candidate (account, batch) capacity constraints relevant to the problem.
function candidatePairs(transactions, batches) {
  const pairs = new Set();
  for (const tx of transactions) {
    const dom = tx.windows === undefined ? batches.map((b) => b.id) : tx.windows;
    for (const b of dom) pairs.add(keyOf(tx.account, b));
  }
  return pairs;
}

// Deletion-based minimal conflict: smallest set of account-batch capacity
// constraints whose enforcement alone already makes the problem UNSAT.
function minimalConflict(transactions, batches, accounts) {
  let conflict = candidatePairs(transactions, batches);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of Array.from(conflict)) {
      const trial = new Set(conflict);
      trial.delete(pair);
      const relaxed = new Set();
      for (const p of candidatePairs(transactions, batches)) {
        if (!trial.has(p)) relaxed.add(p);
      }
      if (solve(transactions, batches, accounts, relaxed) === null) {
        conflict = trial; // pair not needed to stay infeasible
        changed = true;
      }
    }
  }
  return Array.from(conflict)
    .map((k) => {
      const [account, batch] = JSON.parse(k);
      return { account, batch };
    })
    .sort((x, y) => (x.account + x.batch).localeCompare(y.account + y.batch));
}

function plan(transactions, batches, accounts) {
  const assignment = solve(transactions, batches, accounts, null);
  if (assignment === null) {
    return { sat: false, conflict: minimalConflict(transactions, batches, accounts) };
  }
  return { sat: true, assignment };
}

module.exports = { plan, solve, minimalConflict, buildDomains, keyOf };
