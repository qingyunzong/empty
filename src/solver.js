import { createHash } from 'node:crypto';

const MAX_DP_JOBS = 22; // 2^22 state table is the practical ceiling; beyond -> UNKNOWN

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function hashInstance(instance) {
  const canon = {
    jobs: instance.jobs.map((j) => ({ id: j.id, due: j.due, work: j.work, energy: j.energy, mold: j.mold })),
    molds: instance.molds,
    setup: instance.setup,
    energyBudget: instance.energyBudget,
  };
  return sha256(JSON.stringify(canon));
}

const bitIndex = (mask) => 31 - Math.clz32(mask);

/**
 * Insert a label into a state's Pareto list with dominance pruning on
 * (time, tardiness) — energy is constant per mask. Equal labels are merged
 * so every tied optimal sequence stays reachable through `preds`.
 */
function insertLabel(list, label) {
  if (list === null) return [label];
  for (const existing of list) {
    if (existing.time <= label.time && existing.tardiness <= label.tardiness) {
      if (existing.time === label.time && existing.tardiness === label.tardiness) {
        existing.preds.push(...label.preds); // tied partial solution: keep both
      }
      return list; // dominated or merged
    }
  }
  const kept = list.filter((e) => !(label.time <= e.time && label.tardiness <= e.tardiness));
  kept.push(label);
  return kept;
}

function hashStates(states, size, n) {
  const parts = [];
  for (let mask = 0; mask < size; mask++) {
    const row = states[mask];
    if (!row) continue;
    for (let last = 0; last < n; last++) {
      const list = row[last];
      if (!list) continue;
      const sorted = list
        .map((l) => `${l.time},${l.energy},${l.tardiness}`)
        .sort();
      for (const s of sorted) parts.push(`${mask}:${last}:${s}`);
    }
  }
  return sha256(parts.join(';'));
}

/**
 * Solve a canonical instance via subset DP (Held-Karp style) with Pareto
 * pruning and per-shift energy-budget pruning.
 *
 * Objective is lexicographic (makespan, energy, tardiness).
 * All tied optimal sequences are enumerated (up to maxSolutions).
 *
 * options.reuse = { states, size, changedJobsMask } recomputes only the
 * states whose mask intersects changedJobsMask (incremental re-solve).
 *
 * Returns { status: 'FEASIBLE' | 'UNSAT' | 'UNKNOWN', ... }.
 * UNKNOWN is returned only on resource limits and is never collapsed to UNSAT.
 */
export function solveCanonical(instance, options = {}) {
  const maxStates = options.maxStates ?? Infinity;
  const maxSolutions = options.maxSolutions ?? 100000;
  const { jobs, setup, energyBudget } = instance;
  const n = jobs.length;

  if (n === 0) {
    return {
      status: 'FEASIBLE',
      objective: { makespan: 0, energy: 0, tardiness: 0 },
      solutions: [[]],
      truncated: false,
      stats: { statesComputed: 0, incremental: false },
      enumerationHash: sha256(''),
      table: { size: 1, states: [null], n: 0 },
    };
  }
  if (n > MAX_DP_JOBS) {
    return { status: 'UNKNOWN', reason: `instance too large for exact DP (n=${n})`, stats: { statesComputed: 0 } };
  }

  const size = 1 << n;
  const fullMask = size - 1;
  const reuse = options.reuse && options.reuse.size === size ? options.reuse : null;
  const changedJobsMask = reuse ? reuse.changedJobsMask : fullMask;
  const states = reuse ? reuse.states : new Array(size).fill(null);

  let statesComputed = 0;
  let exceeded = false;

  // Ascending mask order is valid: every predecessor mask is strictly smaller.
  for (let mask = 1; mask <= fullMask; mask++) {
    if (reuse && (mask & changedJobsMask) === 0) continue; // unaffected subproblem
    if (states[mask] === null) states[mask] = new Array(n).fill(null);
    else states[mask].fill(null);
    statesComputed++;
    if (statesComputed > maxStates) { exceeded = true; break; }

    if ((mask & (mask - 1)) === 0) {
      const j = bitIndex(mask);
      const job = jobs[j];
      if (job.energy <= energyBudget) {
        states[mask][j] = [{
          time: job.work,
          energy: job.energy,
          tardiness: Math.max(0, job.work - job.due),
          preds: [],
        }];
      }
      continue;
    }

    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const prevMask = mask ^ (1 << last);
      const job = jobs[last];
      let list = null;
      for (let pl = 0; pl < n; pl++) {
        const prevLabels = states[prevMask] ? states[prevMask][pl] : null;
        if (!prevLabels) continue;
        const setupTime = setup[jobs[pl].moldIdx][job.moldIdx];
        for (const plab of prevLabels) {
          const energy = plab.energy + job.energy;
          if (energy > energyBudget) continue; // per-shift energy budget pruning
          const time = plab.time + setupTime + job.work;
          const tardiness = plab.tardiness + Math.max(0, time - job.due);
          list = insertLabel(list, {
            time, energy, tardiness,
            preds: [{ mask: prevMask, last: pl, label: plab }],
          });
        }
      }
      states[mask][last] = list;
    }
  }

  if (exceeded) {
    return { status: 'UNKNOWN', reason: `state limit exceeded (maxStates=${maxStates})`, stats: { statesComputed } };
  }

  const enumerationHash = hashStates(states, size, n);
  const table = { size, states, n };
  const stats = { statesComputed, incremental: reuse !== null };

  // Global lexicographic optimum over final labels (energy is constant per mask).
  let best = null;
  const bestLabels = [];
  for (let last = 0; last < n; last++) {
    const list = states[fullMask] ? states[fullMask][last] : null;
    if (!list) continue;
    for (const lab of list) {
      const cand = { time: lab.time, energy: lab.energy, tardiness: lab.tardiness };
      if (!best || cand.time < best.time ||
          (cand.time === best.time && (cand.energy < best.energy ||
           (cand.energy === best.energy && cand.tardiness < best.tardiness)))) {
        best = cand;
        bestLabels.length = 0;
        bestLabels.push({ last, label: lab });
      } else if (cand.time === best.time && cand.energy === best.energy && cand.tardiness === best.tardiness) {
        bestLabels.push({ last, label: lab });
      }
    }
  }

  if (!best) {
    return { status: 'UNSAT', stats, enumerationHash, table };
  }

  // Enumerate every tied optimal sequence by backtracking predecessor DAG.
  const solutions = [];
  let truncated = false;
  const walk = (last, label, acc) => {
    if (solutions.length >= maxSolutions) { truncated = true; return; }
    acc.push(jobs[last].id);
    if (label.preds.length === 0) {
      solutions.push(acc.slice().reverse());
    } else {
      for (const p of label.preds) walk(p.last, p.label, acc);
    }
    acc.pop();
  };
  for (const { last, label } of bestLabels) walk(last, label, []);

  return {
    status: 'FEASIBLE',
    objective: { makespan: best.time, energy: best.energy, tardiness: best.tardiness },
    solutions,
    truncated,
    stats,
    enumerationHash,
    table,
  };
}

/**
 * Build a minimal infeasible certificate for an UNSAT instance:
 * a subset ("core") of jobs whose energy demand exceeds the shift budget,
 * such that removing ANY single job from the core makes the instance feasible.
 * Includes the enumeration hash of the failed exploration for re-verification.
 */
export function buildUnsatCertificate(instance, result) {
  const { jobs, energyBudget } = instance;
  const totalEnergy = jobs.reduce((a, j) => a + j.energy, 0);

  // Greedy minimization: drop jobs while the remainder stays infeasible.
  let core = jobs.map((_, i) => i);
  let i = 0;
  while (i < core.length) {
    const rest = core.filter((_, k) => k !== i);
    const restEnergy = rest.reduce((a, j) => a + jobs[j].energy, 0);
    if (restEnergy > energyBudget) core = rest;
    else i++;
  }

  // Prove 1-minimality: re-solve the core subsystem minus each constraint;
  // every such restriction must be FEASIBLE (IIS property).
  const removals = core.map((j) => {
    const sub = { ...instance, jobs: core.filter((k) => k !== j).map((k) => jobs[k]) };
    const r = solveCanonical(sub);
    return { removed: jobs[j].id, status: r.status, objective: r.objective ?? null };
  });

  return {
    type: 'MINIMAL_INFEASIBLE_CORE',
    inputHash: hashInstance(instance),
    enumerationHash: result.enumerationHash,
    energyBudget,
    totalEnergy,
    core: core.map((j) => ({ id: jobs[j].id, energy: jobs[j].energy })),
    coreEnergy: core.reduce((a, j) => a + jobs[j].energy, 0),
    removals,
    minimal: removals.every((r) => r.status === 'FEASIBLE'),
  };
}

/** Re-verify an UNSAT certificate from scratch. Returns { ok, reason? }. */
export function verifyUnsatCertificate(instance, cert) {
  if (!cert || cert.type !== 'MINIMAL_INFEASIBLE_CORE') return { ok: false, reason: 'bad certificate type' };
  if (hashInstance(instance) !== cert.inputHash) return { ok: false, reason: 'input hash mismatch' };

  const rerun = solveCanonical(instance);
  if (rerun.status !== 'UNSAT') return { ok: false, reason: 'instance is not UNSAT' };
  if (rerun.enumerationHash !== cert.enumerationHash) return { ok: false, reason: 'enumeration hash mismatch' };

  const coreIds = new Set(cert.core.map((c) => c.id));
  const coreEnergy = instance.jobs.filter((j) => coreIds.has(j.id)).reduce((a, j) => a + j.energy, 0);
  if (coreEnergy !== cert.coreEnergy) return { ok: false, reason: 'core energy mismatch' };
  if (coreEnergy <= instance.energyBudget) return { ok: false, reason: 'core is actually feasible' };

  for (const c of cert.core) {
    const sub = {
      ...instance,
      jobs: instance.jobs.filter((j) => coreIds.has(j.id) && j.id !== c.id),
    };
    if (solveCanonical(sub).status !== 'FEASIBLE') {
      return { ok: false, reason: `core minus ${c.id} is still infeasible: core not minimal` };
    }
  }
  return { ok: true };
}

/** Expand a solution (job-id sequence) into a timed schedule. */
export function buildSchedule(instance, sequence) {
  const byId = new Map(instance.jobs.map((j) => [j.id, j]));
  let time = 0;
  let prev = null;
  return sequence.map((id) => {
    const job = byId.get(id);
    const setupTime = prev === null ? 0 : instance.setup[prev.moldIdx][job.moldIdx];
    const start = time + setupTime;
    const completion = start + job.work;
    const entry = {
      job: id,
      mold: job.mold,
      setup: setupTime,
      start,
      completion,
      due: job.due,
      energy: job.energy,
      tardiness: Math.max(0, completion - job.due),
    };
    time = completion;
    prev = job;
    return entry;
  });
}
