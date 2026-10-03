'use strict';

// Standard 4-stage chain: trade -> fee -> freeze -> settlement (business
// flow). dependsOn points to children, so compensation runs in reverse:
// settlement, freeze, fee, trade.
function chainTx(id, { amounts = {}, statuses = {}, account = 'A' } = {}) {
  const defaultAmounts = { trade: 50, fee: 50, freeze: 100, settlement: 100 };
  const mk = (kind, dependsOn) => ({
    id: `${id}-${kind}`,
    kind,
    account,
    amount: amounts[kind] !== undefined ? amounts[kind] : defaultAmounts[kind],
    status: statuses[kind] || 'posted',
    dependsOn,
  });
  return {
    id,
    stages: [
      mk('trade', [`${id}-fee`]),
      mk('fee', [`${id}-freeze`]),
      mk('freeze', [`${id}-settlement`]),
      mk('settlement', []),
    ],
  };
}

// Reference solver: brute-force enumeration of all batch assignments for
// <= 4 stages. Used to cross-check the backtracking engine.
function referenceAssignment(stages, batches) {
  const usage = batches.map(() => new Map());
  const chosen = new Array(stages.length);
  const quotaOf = (batchIndex, account) => {
    const quota = batches[batchIndex].recoverable[account];
    return quota === undefined ? 0 : quota;
  };
  const enumerate = (index) => {
    if (index === stages.length) return true;
    const stage = stages[index];
    for (let i = 0; i < batches.length; i += 1) {
      if (!batches[i].domains.includes(stage.kind)) continue;
      const used = usage[i].get(stage.account) || 0;
      if (used + stage.amount > quotaOf(i, stage.account)) continue;
      usage[i].set(stage.account, used + stage.amount);
      chosen[index] = batches[i].id;
      if (enumerate(index + 1)) return true;
      usage[i].set(stage.account, used);
      chosen[index] = undefined;
    }
    return false;
  };
  return enumerate(0) ? [...chosen] : null;
}

// Deterministic PRNG (mulberry32) for reproducible randomized cross-checks.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { chainTx, referenceAssignment, mulberry32 };
