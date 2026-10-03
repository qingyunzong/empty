// UNSAT certificates: a minimal infeasible core plus a re-verifiable
// enumeration hash.
//
// A certificate claims: for the job subset S, minEnergy(S) > budget, and for
// every j in S, minEnergy(S \ {j}) <= budget (removing any single constraint
// restores feasibility). minEnergy(T) = sum of job energy in T + minimal total
// mold-setup time over all orderings of T (exact Held-Karp subset DP).
// The enumHash commits to the full DP enumeration table so a verifier can
// re-run the enumeration and compare hashes.

import { createHash } from 'node:crypto';

const MAX_CORE_JOBS = 18;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function instanceHash(norm) {
  return sha256(stableStringify({
    jobs: norm.jobs,
    molds: norm.molds,
    setup: norm.setup,
    energyBudget: norm.energyBudget,
  }));
}

// Exact min-setup enumeration over `subset` (array of job indices).
// Returns { minSetups, lines } where lines enumerate every nonempty sub-mask's
// optimal value (the full enumeration the DP performs).
function enumerateSubset(norm, subset) {
  const k = subset.length;
  if (k > MAX_CORE_JOBS) {
    throw new Error(`certificate core too large (${k} > ${MAX_CORE_JOBS})`);
  }
  const moldIndexOf = new Map(norm.molds.map((name, i) => [name, i]));
  const molds = subset.map((j) => moldIndexOf.get(norm.jobs[j].mold));
  const setup = norm.setup;
  const size = 1 << k;
  const dp = new Float64Array(size * k).fill(Infinity);
  for (let i = 0; i < k; i++) dp[(1 << i) * k + i] = 0;
  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < k; last++) {
      const cur = dp[mask * k + last];
      if (cur === Infinity) continue;
      for (let j = 0; j < k; j++) {
        if (mask & (1 << j)) continue;
        const cost = cur + setup[molds[last]][molds[j]];
        const slot = (mask | (1 << j)) * k + j;
        if (cost < dp[slot]) dp[slot] = cost;
      }
    }
  }
  const lines = [];
  for (let mask = 1; mask < size; mask++) {
    let best = Infinity;
    for (let last = 0; last < k; last++) {
      if (dp[mask * k + last] < best) best = dp[mask * k + last];
    }
    lines.push(`${mask}:${best}`);
  }
  return { minSetups: Number(lines[lines.length - 1].split(':')[1]), lines };
}

function sumEnergy(norm, subset) {
  let total = 0;
  for (const j of subset) total += norm.jobs[j].energy;
  return total;
}

function minEnergyOf(norm, subset) {
  if (subset.length === 0) return 0;
  return sumEnergy(norm, subset) + enumerateSubset(norm, subset).minSetups;
}

// Greedy deletion minimization: keep removing jobs while the core stays
// infeasible. The result is 1-minimal: removing any remaining job makes the
// core feasible.
export function buildUnsatCertificate(norm) {
  const budget = norm.energyBudget;
  let core = norm.jobs.map((_, i) => i);
  if (minEnergyOf(norm, core) <= budget) {
    throw new Error('instance is not UNSAT: no certificate exists');
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (const j of core) {
      const rest = core.filter((x) => x !== j);
      if (minEnergyOf(norm, rest) > budget) {
        core = rest;
        improved = true;
        break;
      }
    }
  }
  const { minSetups, lines } = enumerateSubset(norm, core);
  const minEnergy = sumEnergy(norm, core) + minSetups;
  const removals = core.map((j) => {
    const rest = core.filter((x) => x !== j);
    return { removed: norm.jobs[j].id, minEnergy: minEnergyOf(norm, rest) };
  });
  const enumHash = sha256(lines.join('\n'));
  return {
    type: 'unsat-certificate',
    version: 1,
    instanceHash: instanceHash(norm),
    jobs: core.map((j) => norm.jobs[j].id),
    budget,
    minEnergy,
    removals,
    enumHash,
  };
}

// Re-verify a certificate against an instance: recompute the minimal core
// energy, every single-removal relaxation, and the enumeration hash.
export function verifyUnsatCertificate(norm, cert) {
  const checks = [];
  const ok = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    return pass;
  };
  if (!cert || cert.type !== 'unsat-certificate') {
    ok('certificate-type', false, 'not an unsat-certificate');
    return { valid: false, checks };
  }
  if (!ok('instance-hash', cert.instanceHash === instanceHash(norm), 'certificate bound to this instance')) {
    return { valid: false, checks };
  }
  const idToIndex = new Map(norm.jobs.map((j, i) => [j.id, i]));
  const core = cert.jobs.map((id) => idToIndex.get(id));
  if (core.some((i) => i === undefined)) {
    ok('core-jobs-known', false, 'certificate references unknown job ids');
    return { valid: false, checks };
  }
  let valid = true;
  try {
    const { minSetups, lines } = enumerateSubset(norm, core);
    const minEnergy = sumEnergy(norm, core) + minSetups;
    valid = ok('core-infeasible', minEnergy > cert.budget && minEnergy === cert.minEnergy,
      `minEnergy=${minEnergy} budget=${cert.budget}`) && valid;
    for (const entry of cert.removals) {
      const rest = core.filter((x) => x !== idToIndex.get(entry.removed));
      const relaxed = minEnergyOf(norm, rest);
      valid = ok(`removal-${JSON.stringify(entry.removed)}`,
        relaxed <= cert.budget && relaxed === entry.minEnergy,
        `minEnergy without job=${relaxed}`) && valid;
    }
    valid = ok('enum-hash', sha256(lines.join('\n')) === cert.enumHash, 'enumeration hash matches') && valid;
  } catch (e) {
    ok('enumeration', false, e.message);
    return { valid: false, checks };
  }
  return { valid, checks };
}
