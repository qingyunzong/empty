/**
 * Greedy furnace scheduler.
 *
 * Mechanics modeled:
 * - One furnace, runs are numbered sequentially and processed back to back.
 * - A run mixes orders whose recipes share a compatibility group, up to capacity (units).
 * - Switching the group between consecutive runs costs `cleanTime` (cleaning).
 * - Each recipe has a per-day quota (units); a run that would exceed today's
 *   quota is shifted to the next day boundary.
 * - Urgent orders outrank normal ones; normal orders age: their effective due
 *   date decreases with the time spent waiting (effectiveDue = due - agingRate * waited).
 */

export function effectiveDue(order, cfg, now) {
  return order.due - cfg.agingRate * Math.max(0, now - (order.arrival ?? 0));
}

function priorityRank(order) {
  return order.priority === 'urgent' ? 0 : 1;
}

export function makeOrderComparator(cfg, now) {
  return (a, b) =>
    priorityRank(a) - priorityRank(b) ||
    effectiveDue(a, cfg, now) - effectiveDue(b, cfg, now) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const quotaKey = (day, recipe) => `${day}|${recipe}`;

/**
 * @param cfg normalized config
 * @param queue array of orders with a `batches` count = batches still to schedule
 * @param opts { now, startTime, prevGroup, firstRunNo, quotaUsed (Map, seeded e.g. by frozen runs) }
 * @returns { runs, tardiness, cleaning, quotaUsed }
 */
export function greedySchedule(cfg, queue, opts = {}) {
  const now = opts.now ?? 0;
  const quotaUsed = opts.quotaUsed ?? new Map();
  const remaining = new Map();
  const info = new Map();
  for (const o of queue) {
    remaining.set(o.id, (remaining.get(o.id) ?? 0) + o.batches);
    if (!info.has(o.id)) info.set(o.id, o);
  }
  const cmp = makeOrderComparator(cfg, now);
  const used = (day, recipe) => quotaUsed.get(quotaKey(day, recipe)) ?? 0;

  const runs = [];
  let time = opts.startTime ?? 0;
  let group = opts.prevGroup ?? null;
  let runNo = opts.firstRunNo ?? 1;
  let cleaning = 0;
  let tardiness = 0;

  let totalRemaining = 0;
  for (const v of remaining.values()) totalRemaining += v;

  while (totalRemaining > 0) {
    const groups = new Set();
    for (const [id, b] of remaining) {
      if (b > 0) groups.add(cfg.recipes[info.get(id).recipe].group);
    }

    // Candidate next run per group: earliest feasible start (with quota day-shift).
    let best = null;
    for (const g of groups) {
      const ids = [];
      for (const [id, b] of remaining) {
        if (b > 0 && cfg.recipes[info.get(id).recipe].group === g) ids.push(id);
      }
      ids.sort((a, b) => cmp(info.get(a), info.get(b)));

      const clean = group !== null && group !== g ? cfg.cleanTime : 0;
      let start = time + clean;
      let day;
      let loads;
      for (;;) {
        day = Math.floor(start / cfg.dayLength);
        loads = [];
        let capLeft = cfg.capacity;
        for (const id of ids) {
          const o = info.get(id);
          const quotaLeft = cfg.recipes[o.recipe].dailyQuota - used(day, o.recipe);
          const take = Math.min(
            remaining.get(id),
            Math.floor(capLeft / o.batchSize),
            Math.floor(quotaLeft / o.batchSize)
          );
          if (take > 0) {
            loads.push({ order: id, recipe: o.recipe, batches: take, units: take * o.batchSize });
            capLeft -= take * o.batchSize;
          }
        }
        if (loads.length > 0) break;
        start = (day + 1) * cfg.dayLength; // quota exhausted today: wait for next day
      }
      const candidate = { g, clean, start, day, loads, head: ids[0] };
      if (
        !best ||
        candidate.start < best.start ||
        (candidate.start === best.start &&
          (cmp(info.get(candidate.head), info.get(best.head)) < 0 ||
            (cmp(info.get(candidate.head), info.get(best.head)) === 0 && candidate.g < best.g)))
      ) {
        best = candidate;
      }
    }

    const end = best.start + cfg.runTime;
    for (const load of best.loads) {
      remaining.set(load.order, remaining.get(load.order) - load.batches);
      totalRemaining -= load.batches;
      quotaUsed.set(quotaKey(best.day, load.recipe), used(best.day, load.recipe) + load.units);
      tardiness += load.batches * Math.max(0, end - info.get(load.order).due);
    }
    cleaning += best.clean;
    runs.push({
      runNo,
      group: best.g,
      start: best.start,
      end,
      day: best.day,
      cleanBefore: best.clean,
      loads: best.loads,
    });
    time = end;
    group = best.g;
    runNo += 1;
  }

  return { runs, tardiness, cleaning, quotaUsed };
}
