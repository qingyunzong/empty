import { maxRuns } from './state.js';
import { signatureOf, compareSignatures } from './solver.js';

// Independent brute-force enumerator used to cross-check the solver on
// small instances (n <= 9). Feasibility is re-derived from scratch for each
// candidate placement instead of maintained incrementally.

function combosOf(recipe) {
  const combos = [];
  for (const temp of recipe.temps) {
    for (const atmosphere of recipe.atmospheres) {
      for (const duration of recipe.durations) {
        combos.push({ temp, atmosphere, duration, gas: duration * (recipe.gasPerHour ?? 0) });
      }
    }
  }
  return combos;
}

export function enumerateOptimum(instance) {
  const config = instance.config;
  const locks = instance.locks ?? {};
  const runCount = maxRuns(config);
  const hazardous = new Set(config.hazardous ?? []);
  const profileNames = Object.keys(config.rampProfiles ?? {});
  const minCoverage = config.minCoverage ?? 0;

  const items = instance.recipes
    .map((r) => ({
      id: r.id,
      priority: r.priority,
      crucible: r.crucible,
      rampRequired: r.rampRequired ?? 0,
      combos: combosOf(r),
      lock: locks[r.id] ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const assignment = new Array(items.length).fill(null);
  const usedRuns = new Set();
  for (const item of items) {
    if (item.lock) usedRuns.add(item.lock.run);
  }
  let best = null;

  const suffix = new Array(items.length + 1).fill(0);
  for (let i = items.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + items[i].priority;
  }

  function runOk(runIdx) {
    const members = [];
    for (let i = 0; i < items.length; i++) {
      if (assignment[i] && assignment[i].run === runIdx) {
        members.push({ item: items[i], combo: assignment[i].combo });
      }
    }
    if (members.length > config.slotsPerRun) return false;
    const crucibles = Object.create(null);
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    let hazardousAtmo = null;
    const profiles = new Set(profileNames);
    for (const { item, combo } of members) {
      crucibles[item.crucible] = (crucibles[item.crucible] ?? 0) + 1;
      if (crucibles[item.crucible] > (config.crucibles?.[item.crucible] ?? 0)) return false;
      minTemp = Math.min(minTemp, combo.temp);
      maxTemp = Math.max(maxTemp, combo.temp);
      if (hazardous.has(combo.atmosphere)) {
        if (hazardousAtmo !== null && hazardousAtmo !== combo.atmosphere) return false;
        hazardousAtmo = combo.atmosphere;
      }
      for (const p of [...profiles]) {
        if (item.rampRequired > (config.rampProfiles[p].maxRamp ?? Infinity)) {
          profiles.delete(p);
        }
      }
      if (profileNames.length > 0 && profiles.size === 0) return false;
    }
    if (members.length > 0 && maxTemp - minTemp > config.tempDelta) return false;
    return true;
  }

  function recurse(i, weight, gasUsed) {
    if (best && weight + suffix[i] < best.weight) return;
    if (i === items.length) {
      if (weight < minCoverage) return;
      const scheduled = [];
      for (let k = 0; k < items.length; k++) {
        if (assignment[k]) {
          scheduled.push({ id: items[k].id, run: assignment[k].run, ...assignment[k].combo });
        }
      }
      const sig = signatureOf(scheduled);
      if (
        !best ||
        weight > best.weight ||
        (weight === best.weight && compareSignatures(sig, best.signature) < 0)
      ) {
        best = { weight, signature: sig, scheduled };
      }
      return;
    }
    const item = items[i];
    const place = (run, combo) => {
      assignment[i] = { run, combo };
      const added = !usedRuns.has(run);
      usedRuns.add(run);
      if (gasUsed + combo.gas <= config.gasBudget && runOk(run)) {
        recurse(i + 1, weight + item.priority, gasUsed + combo.gas);
      }
      if (added) usedRuns.delete(run);
      assignment[i] = null;
    };
    if (item.lock) {
      const combo = item.combos.find(
        (c) =>
          c.temp === item.lock.temp &&
          c.atmosphere === item.lock.atmosphere &&
          c.duration === item.lock.duration,
      );
      if (combo) place(item.lock.run, combo);
      return;
    }
    const runOptions = [...usedRuns].sort((a, b) => a - b);
    if (usedRuns.size < runCount) {
      let next = 0;
      while (usedRuns.has(next)) next += 1;
      runOptions.push(next);
    }
    for (const r of runOptions) {
      for (const combo of item.combos) {
        place(r, combo);
      }
    }
    recurse(i + 1, weight, gasUsed);
  }

  recurse(0, 0, 0);

  if (!best) return { status: 'UNSAT', weight: null, scheduled: [] };
  return { status: 'OPTIMAL', weight: best.weight, signature: best.signature, scheduled: best.scheduled };
}
