import { DEFAULT_BUDGETS, maxRuns } from './state.js';

export const UNLIMITED_BUDGETS = {
  propagation: Infinity,
  backtrack: Infinity,
  improvement: Infinity,
};

// Canonical comparison key of a solution: sorted [id, temp, atmosphere,
// duration] tuples. Equal-weight solutions are ordered by recipe id first,
// then by the chosen values. Run indices are intentionally excluded: they
// are machinery, not identity.
export function signatureOf(scheduled) {
  return scheduled
    .map((s) => [s.id, s.temp, s.atmosphere, s.duration])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function compareSignatures(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i][0] !== b[i][0]) return a[i][0] < b[i][0] ? -1 : 1;
  }
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    for (let j = 1; j < 4; j++) {
      if (a[i][j] !== b[i][j]) return a[i][j] < b[i][j] ? -1 : 1;
    }
  }
  return 0;
}

function combosOf(recipe) {
  const combos = [];
  for (const temp of recipe.temps) {
    for (const atmosphere of recipe.atmospheres) {
      for (const duration of recipe.durations) {
        combos.push({ temp, atmosphere, duration, gas: duration * (recipe.gasPerHour ?? 0) });
      }
    }
  }
  combos.sort(
    (a, b) =>
      a.gas - b.gas ||
      a.temp - b.temp ||
      (a.atmosphere < b.atmosphere ? -1 : a.atmosphere > b.atmosphere ? 1 : 0) ||
      a.duration - b.duration,
  );
  return combos;
}

export function solve(instance, budgets = DEFAULT_BUDGETS, options = {}) {
  const { withCore = true } = options;
  const config = instance.config;
  const locks = instance.locks ?? {};
  const runCount = maxRuns(config);
  const hazardous = new Set(config.hazardous ?? []);
  const profileNames = Object.keys(config.rampProfiles ?? {});
  const minCoverage = config.minCoverage ?? 0;

  const items = instance.recipes.map((r) => {
    const lock = locks[r.id] ?? null;
    let combos = combosOf(r);
    if (lock) {
      combos = combos.filter(
        (c) => c.temp === lock.temp && c.atmosphere === lock.atmosphere && c.duration === lock.duration,
      );
    }
    return {
      id: r.id,
      priority: r.priority,
      crucible: r.crucible,
      rampRequired: r.rampRequired ?? 0,
      combos,
      minGas: combos.length ? Math.min(...combos.map((c) => c.gas)) : Infinity,
      lock,
    };
  });

  const order = items.map((_, i) => i);
  order.sort(
    (a, b) => items[b].priority - items[a].priority || (items[a].id < items[b].id ? -1 : 1),
  );

  const newRun = () => ({
    profiles: new Set(profileNames),
    minTemp: Infinity,
    maxTemp: -Infinity,
    hazardousAtmo: null,
    crucibles: Object.create(null),
    slotsUsed: 0,
  });

  const runs = Array.from({ length: runCount }, newRun);
  const openRuns = new Set();
  for (const item of items) {
    if (item.lock) openRuns.add(item.lock.run);
  }

  function canJoin(run, item, combo) {
    if (run.slotsUsed >= config.slotsPerRun) return false;
    const cap = config.crucibles?.[item.crucible] ?? 0;
    if ((run.crucibles[item.crucible] ?? 0) >= cap) return false;
    if (run.slotsUsed > 0) {
      if (combo.temp - run.minTemp > config.tempDelta) return false;
      if (run.maxTemp - combo.temp > config.tempDelta) return false;
    }
    if (
      hazardous.has(combo.atmosphere) &&
      run.hazardousAtmo !== null &&
      run.hazardousAtmo !== combo.atmosphere
    ) {
      return false;
    }
    if (profileNames.length > 0) {
      let ok = false;
      for (const p of run.profiles) {
        if (item.rampRequired <= (config.rampProfiles[p].maxRamp ?? Infinity)) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }
    return true;
  }

  function join(run, item, combo) {
    const saved = {
      profiles: new Set(run.profiles),
      minTemp: run.minTemp,
      maxTemp: run.maxTemp,
      hazardousAtmo: run.hazardousAtmo,
      crucibleCount: run.crucibles[item.crucible] ?? 0,
      slotsUsed: run.slotsUsed,
    };
    run.slotsUsed += 1;
    run.crucibles[item.crucible] = (run.crucibles[item.crucible] ?? 0) + 1;
    run.minTemp = Math.min(run.minTemp, combo.temp);
    run.maxTemp = Math.max(run.maxTemp, combo.temp);
    if (hazardous.has(combo.atmosphere)) run.hazardousAtmo = combo.atmosphere;
    for (const p of [...run.profiles]) {
      if (item.rampRequired > (config.rampProfiles[p].maxRamp ?? Infinity)) {
        run.profiles.delete(p);
      }
    }
    return saved;
  }

  function unjoin(run, item, saved) {
    run.slotsUsed = saved.slotsUsed;
    run.crucibles[item.crucible] = saved.crucibleCount;
    run.minTemp = saved.minTemp;
    run.maxTemp = saved.maxTemp;
    run.hazardousAtmo = saved.hazardousAtmo;
    run.profiles = saved.profiles;
  }

  const rem = {
    propagation: budgets.propagation,
    backtrack: budgets.backtrack,
    improvement: budgets.improvement,
  };
  const used = { propagation: 0, backtrack: 0, improvement: 0 };
  let pending = false;
  let best = null;
  let rootBound = null;

  function spend(kind) {
    used[kind] += 1;
    rem[kind] -= 1;
    if (rem[kind] < 0) {
      pending = true;
      return false;
    }
    return true;
  }

  function hasAnyCandidate(item, gasUsed) {
    if (item.lock) {
      const combo = item.combos[0];
      if (!combo) return false;
      return gasUsed + combo.gas <= config.gasBudget && canJoin(runs[item.lock.run], item, combo);
    }
    for (const r of openRuns) {
      for (const combo of item.combos) {
        if (gasUsed + combo.gas <= config.gasBudget && canJoin(runs[r], item, combo)) return true;
      }
    }
    if (openRuns.size < runCount) {
      const fresh = newRun();
      for (const combo of item.combos) {
        if (gasUsed + combo.gas <= config.gasBudget && canJoin(fresh, item, combo)) return true;
      }
    }
    return false;
  }

  // Resource-profile lower-bound propagation. Returns true when the branch
  // cannot improve on the incumbent or cannot reach feasibility.
  function propagate(idx, weight, gasUsed, assignedCount) {
    let ub = weight;
    const possible = [];
    for (let j = idx; j < items.length; j++) {
      const item = items[order[j]];
      const ok = hasAnyCandidate(item, gasUsed);
      if (item.lock && !ok) return true;
      if (ok) {
        ub += item.priority;
        possible.push(item);
      }
    }
    if (idx === 0) rootBound = ub;
    if (best && ub < best.weight) return true;
    if (ub < minCoverage) return true;
    const deficit = minCoverage - weight;
    if (deficit > 0) {
      const sorted = possible.slice().sort((a, b) => b.priority - a.priority);
      let acc = 0;
      let needGas = 0;
      let needCount = 0;
      for (const item of sorted) {
        if (acc >= deficit) break;
        const remaining = deficit - acc;
        if (item.priority <= remaining) {
          acc += item.priority;
          needGas += item.minGas;
          needCount += 1;
        } else {
          needGas += (remaining / item.priority) * item.minGas;
          needCount += 1;
          acc = deficit;
        }
      }
      if (acc < deficit) return true;
      if (gasUsed + needGas > config.gasBudget + 1e-9) return true;
      const freeSlots = openRuns.size * config.slotsPerRun - assignedCount;
      const minNewRuns = Math.max(0, Math.ceil((needCount - freeSlots) / config.slotsPerRun));
      if (openRuns.size + minNewRuns > runCount) return true;
    }
    return false;
  }

  const scheduled = [];

  function recurse(idx, weight, gasUsed, assignedCount) {
    if (pending) return;
    if (!spend('backtrack')) return;
    if (!spend('propagation')) return;
    if (propagate(idx, weight, gasUsed, assignedCount)) return;
    if (idx === items.length) {
      if (weight >= minCoverage) {
        const sig = signatureOf(scheduled);
        if (
          !best ||
          weight > best.weight ||
          (weight === best.weight && compareSignatures(sig, best.signature) < 0)
        ) {
          if (!spend('improvement')) return;
          best = { weight, signature: sig, scheduled: scheduled.map((s) => ({ ...s })) };
        }
      }
      return;
    }
    const item = items[order[idx]];
    if (item.lock) {
      const combo = item.combos[0];
      if (combo && gasUsed + combo.gas <= config.gasBudget && canJoin(runs[item.lock.run], item, combo)) {
        const saved = join(runs[item.lock.run], item, combo);
        scheduled.push({ id: item.id, run: item.lock.run, ...combo });
        recurse(idx + 1, weight + item.priority, gasUsed + combo.gas, assignedCount + 1);
        scheduled.pop();
        unjoin(runs[item.lock.run], item, saved);
      }
      return;
    }
    const runOptions = [...openRuns].sort((a, b) => a - b);
    if (openRuns.size < runCount) {
      let next = 0;
      while (openRuns.has(next)) next += 1;
      runOptions.push(next);
    }
    for (const r of runOptions) {
      for (const combo of item.combos) {
        if (pending) return;
        if (gasUsed + combo.gas > config.gasBudget) continue;
        if (!canJoin(runs[r], item, combo)) continue;
        const isNew = !openRuns.has(r);
        const saved = join(runs[r], item, combo);
        openRuns.add(r);
        scheduled.push({ id: item.id, run: r, ...combo });
        recurse(idx + 1, weight + item.priority, gasUsed + combo.gas, assignedCount + 1);
        scheduled.pop();
        if (isNew) openRuns.delete(r);
        unjoin(runs[r], item, saved);
      }
    }
    if (pending) return;
    recurse(idx + 1, weight, gasUsed, assignedCount);
  }

  recurse(0, 0, 0, 0);

  const budgetsUsed = { ...used };
  const finish = (scheduledList) =>
    scheduledList.map((s) => ({
      ...s,
      day: Math.floor(s.run / config.maxRunsPerDay),
    }));

  if (pending) {
    return {
      status: 'PENDING',
      weight: best ? best.weight : null,
      bound: rootBound,
      scheduled: best ? finish(best.scheduled) : [],
      budgetsUsed,
    };
  }
  if (!best) {
    const result = { status: 'UNSAT', weight: null, bound: 0, scheduled: [], budgetsUsed };
    if (withCore) result.core = minimalCore(instance);
    return result;
  }
  return {
    status: 'OPTIMAL',
    weight: best.weight,
    bound: best.weight,
    scheduled: finish(best.scheduled),
    budgetsUsed,
  };
}

// Deletion-based minimal unsatisfiable core: a minimal (by inclusion) set of
// recipes whose sub-instance is still UNSAT. Coverage is rescaled to the
// subset so that the core reflects genuine conflicts (e.g. hazardous
// atmosphere mutual exclusion) rather than missing recipes.
export function minimalCore(instance) {
  const ids = instance.recipes.map((r) => r.id).sort();
  let core = [...ids];
  const isUnsat = (subset) => {
    const keep = new Set(subset);
    const recipes = instance.recipes.filter((r) => keep.has(r.id));
    const locks = Object.fromEntries(
      Object.entries(instance.locks ?? {}).filter(([k]) => keep.has(k)),
    );
    const sum = recipes.reduce((s, r) => s + r.priority, 0);
    const config = {
      ...instance.config,
      minCoverage: Math.min(instance.config.minCoverage ?? 0, sum),
    };
    return solve({ config, recipes, locks }, UNLIMITED_BUDGETS, { withCore: false }).status === 'UNSAT';
  };
  for (const id of ids) {
    if (core.length <= 1) break;
    const trial = core.filter((x) => x !== id);
    if (isUnsat(trial)) core = trial;
  }
  return core;
}
