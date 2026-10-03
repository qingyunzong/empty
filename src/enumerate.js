/**
 * Exact enumerator for small instances (<= 5 work orders recommended).
 *
 * Enumerates every ordered partition of all batches into furnace runs
 * (respecting compatibility group, capacity and daily quota), computes the
 * exact objective (tardiness + cleaning) for each, and returns the optimum.
 * Ties are broken by preferring loads in lower-numbered runs
 * (secondary key: sum of runNo * runUnits, smaller is better).
 *
 * Runs are built in sequence, so time, day, quota usage and cleaning are all
 * incremental. A partial branch is pruned once its cost can no longer beat
 * the incumbent.
 */
export function enumerateOptimal(cfg, orders) {
  const n = orders.length;
  const info = orders.map((o) => ({ ...o }));
  const groupOf = (i) => cfg.recipes[info[i].recipe].group;
  const quotaKey = (day, recipe) => `${day}|${recipe}`;

  const quotaUsed = new Map();
  const rem = info.map((o) => o.batches);
  let best = null;
  let explored = 0;

  function recipeUnitsOf(takes) {
    const map = new Map();
    for (let i = 0; i < n; i++) {
      if (takes[i] > 0) {
        const r = info[i].recipe;
        map.set(r, (map.get(r) ?? 0) + takes[i] * info[i].batchSize);
      }
    }
    return map;
  }

  function commit(g, clean, baseStart, takes, time, runNo, tardiness, cleaning, secondary, runs) {
    // Earliest start whose day has quota for every recipe in this run.
    let start = baseStart;
    const recipeUnits = recipeUnitsOf(takes);
    for (;;) {
      const day = Math.floor(start / cfg.dayLength);
      let fits = true;
      for (const [recipe, units] of recipeUnits) {
        if ((quotaUsed.get(quotaKey(day, recipe)) ?? 0) + units > cfg.recipes[recipe].dailyQuota) {
          fits = false;
          break;
        }
      }
      if (fits) break;
      start = (day + 1) * cfg.dayLength;
    }
    const day = Math.floor(start / cfg.dayLength);
    const end = start + cfg.runTime;

    let tard = 0;
    let units = 0;
    const loads = [];
    for (let i = 0; i < n; i++) {
      if (takes[i] === 0) continue;
      const u = takes[i] * info[i].batchSize;
      rem[i] -= takes[i];
      units += u;
      tard += takes[i] * Math.max(0, end - info[i].due);
      quotaUsed.set(quotaKey(day, info[i].recipe), (quotaUsed.get(quotaKey(day, info[i].recipe)) ?? 0) + u);
      loads.push({ order: info[i].id, recipe: info[i].recipe, batches: takes[i], units: u });
    }
    runs.push({ runNo, group: g, start, end, day, cleanBefore: clean, loads });

    rec(end, g, runNo + 1, tardiness + tard, cleaning + clean, secondary + runNo * units, runs);

    runs.pop();
    for (let i = 0; i < n; i++) {
      if (takes[i] === 0) continue;
      const u = takes[i] * info[i].batchSize;
      rem[i] += takes[i];
      quotaUsed.set(quotaKey(day, info[i].recipe), quotaUsed.get(quotaKey(day, info[i].recipe)) - u);
    }
  }

  function rec(time, prevGroup, runNo, tardiness, cleaning, secondary, runs) {
    explored += 1;
    // Prune only when strictly worse: equal-cost branches may still win the
    // tie-break (lower-numbered runs, fewer runs).
    if (best && tardiness + cleaning > best.total) return;
    if (rem.every((v) => v === 0)) {
      const total = tardiness + cleaning;
      if (
        !best ||
        total < best.total ||
        (total === best.total && secondary < best.secondary) ||
        (total === best.total && secondary === best.secondary && runs.length < best.runs.length)
      ) {
        best = {
          total,
          secondary,
          tardiness,
          cleaning,
          runs: runs.map((r) => ({ ...r, loads: r.loads.map((l) => ({ ...l })) })),
        };
      }
      return;
    }
    const groups = new Set();
    for (let i = 0; i < n; i++) if (rem[i] > 0) groups.add(groupOf(i));

    for (const g of groups) {
      const clean = prevGroup !== null && prevGroup !== g ? cfg.cleanTime : 0;
      const baseStart = time + clean;
      const idxs = [];
      for (let i = 0; i < n; i++) if (rem[i] > 0 && groupOf(i) === g) idxs.push(i);
      const takes = new Array(n).fill(0);

      // Enumerate every non-empty take-vector inside group g that fits one run
      // (capacity) and can fit a fresh day's quota per recipe.
      const recipeLoad = new Map();
      function enumContents(k, capLeft) {
        if (k === idxs.length) {
          let any = false;
          for (let i = 0; i < n; i++) if (takes[i] > 0) { any = true; break; }
          if (!any) return;
          commit(g, clean, baseStart, takes, time, runNo, tardiness, cleaning, secondary, runs);
          return;
        }
        const i = idxs[k];
        const bs = info[i].batchSize;
        const recipe = info[i].recipe;
        const recipeUsed = recipeLoad.get(recipe) ?? 0;
        const maxTake = Math.min(
          rem[i],
          Math.floor(capLeft / bs),
          Math.floor((cfg.recipes[recipe].dailyQuota - recipeUsed) / bs)
        );
        for (let t = 0; t <= maxTake; t++) {
          takes[i] = t;
          recipeLoad.set(recipe, recipeUsed + t * bs);
          enumContents(k + 1, capLeft - t * bs);
        }
        takes[i] = 0;
        recipeLoad.set(recipe, recipeUsed);
      }
      enumContents(0, cfg.capacity);
    }
  }

  rec(0, null, 1, 0, 0, 0, []);
  return { ...best, explored };
}
