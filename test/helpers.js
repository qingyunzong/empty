'use strict';

// Deterministic PRNG (mulberry32) so every randomized test is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a random concurrent history for one account.
 * n ops; each op is freeze/hold/release; holds/releases reference a random
 * earlier freeze; each op causally depends on 0..2 random earlier ops
 * (ops without causes are concurrent -> branches to merge).
 */
function genAccountOps(rand, account, n, opts = {}) {
  const maxAmount = opts.maxAmount || 60;
  const ops = [];
  const freezes = [];
  for (let i = 0; i < n; i++) {
    const roll = rand();
    let type = 'freeze';
    if (freezes.length > 0) {
      if (roll < 0.35) type = 'release';
      else if (roll < 0.55) type = 'hold';
    }
    const causes = [];
    const depCount = rand() < 0.55 ? 0 : 1 + Math.floor(rand() * 2);
    for (let d = 0; d < depCount && ops.length > 0; d++) {
      const dep = ops[Math.floor(rand() * ops.length)].opId;
      if (!causes.includes(dep)) causes.push(dep);
    }
    const op = {
      opId: `${account}-op${i}`,
      account,
      type,
      amount: 1 + Math.floor(rand() * maxAmount),
      day: '2026-10-02',
      ts: i, // stable tie-break; concurrency comes from empty causes
      causes,
    };
    if (type !== 'freeze') op.ref = freezes[Math.floor(rand() * freezes.length)];
    if (type === 'freeze') freezes.push(op.opId);
    ops.push(op);
  }
  return ops;
}

/** Generate the 5-account x 200-op acceptance history (seeded). */
function genFleetHistory(seed, accounts = 5, opsPerAccount = 200) {
  const rand = mulberry32(seed);
  const all = [];
  for (let a = 0; a < accounts; a++) {
    all.push(...genAccountOps(rand, `acc${a}`, opsPerAccount, { maxAmount: 50 }));
  }
  // inject a few duplicate opIds and invalid ops (error paths)
  for (let i = 0; i < 5; i++) {
    all.push({ ...all[i * 37], opId: all[i * 37].opId }); // duplicate opId -> code 12
  }
  for (let i = 0; i < 3; i++) {
    all.push({
      opId: `bad-${i}`,
      account: `acc${i}`,
      type: 'freeze',
      amount: -10 - i, // invalid amount -> code 15
      day: '2026-10-02',
      ts: 10000 + i,
      causes: [],
    });
  }
  // shuffle append order (interleaved concurrent submission)
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

const FLEET_CONFIG = {
  default: { limit: 400, dailyFreezeCap: 300 },
};

module.exports = { mulberry32, genAccountOps, genFleetHistory, FLEET_CONFIG };
