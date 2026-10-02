import { buildDemands } from './scheduler.js';

// Exact enumerator for small instances (<= maxItems demands after group
// merging; the spec requires support for <= 5 orders). Every demand is
// treated as an atomic load. Enumerates all set partitions of demands into
// runs (capacity + family compatible) and all run orderings, simulates each
// schedule, and keeps the best objective. Ties are broken deterministically
// by run numbering order (lexicographic run composition).

export function enumerateOptimal({ orders, recipes, config, maxItems = 6 }) {
  const demands = buildDemands(orders, recipes);
  if (demands.length > maxItems) {
    throw new Error(`enumeration supports at most ${maxItems} demand(s), got ${demands.length}`);
  }
  for (const d of demands) {
    if (d.qty > config.capacity) return null;
  }

  const quotaKey = (day, recipe) => `${day}:${recipe}`;
  let best = null;

  function simulate(sequence) {
    const quotaUsed = new Map();
    let time = 0;
    let prevFamily = null;
    let tardiness = 0;
    let cleanoutTotal = 0;
    const runs = [];
    for (const block of sequence) {
      const cleanout = prevFamily !== null && prevFamily !== block.family ? config.cleanoutTime : 0;
      let start = time + cleanout;
      const usage = new Map();
      for (const d of block.items) {
        for (const it of d.items) usage.set(it.recipe, (usage.get(it.recipe) ?? 0) + it.qty);
      }
      let day = Math.floor(start / config.dayLength);
      let guard = 0;
      while (
        [...usage].some(
          ([recipe, qty]) => qty > recipes.get(recipe).dailyQuota - (quotaUsed.get(quotaKey(day, recipe)) ?? 0),
        )
      ) {
        if (++guard > 10000) return null;
        day += 1;
        start = day * config.dayLength;
      }
      for (const [recipe, qty] of usage) {
        quotaUsed.set(quotaKey(day, recipe), (quotaUsed.get(quotaKey(day, recipe)) ?? 0) + qty);
      }
      const end = start + config.runDuration;
      for (const d of block.items) {
        for (const it of d.items) tardiness += Math.max(0, end - it.due);
      }
      cleanoutTotal += cleanout;
      runs.push({
        id: runs.length + 1,
        family: block.family,
        loads: block.items.flatMap((d) =>
          d.items.map((it) => ({ orderId: it.orderId, recipe: it.recipe, qty: it.qty })),
        ),
        start,
        end,
        cleanout,
        day,
      });
      time = end;
      prevFamily = block.family;
    }
    return {
      objective: { tardiness, cleanout: cleanoutTotal, compensation: 0, total: tardiness + cleanoutTotal },
      runs,
    };
  }

  function planKey(plan) {
    return plan.runs.map((r) => r.loads.map((l) => l.orderId).sort().join('+')).join('|');
  }

  function isBetter(candidate, current) {
    if (current === null) return true;
    if (candidate.objective.total !== current.objective.total) {
      return candidate.objective.total < current.objective.total;
    }
    if (candidate.runs.length !== current.runs.length) return candidate.runs.length < current.runs.length;
    return planKey(candidate) < planKey(current);
  }

  function evaluateBlocks(blocks) {
    const k = blocks.length;
    const used = new Array(k).fill(false);
    const seq = new Array(k);
    (function place(i) {
      if (i === k) {
        const result = simulate(seq);
        if (result && isBetter(result, best)) best = result;
        return;
      }
      for (let j = 0; j < k; j++) {
        if (used[j]) continue;
        used[j] = true;
        seq[i] = blocks[j];
        place(i + 1);
        used[j] = false;
      }
    })(0);
  }

  const blocks = [];
  (function recurse(i) {
    if (i === demands.length) {
      evaluateBlocks(blocks);
      return;
    }
    const d = demands[i];
    for (const block of blocks) {
      if (block.family !== d.family) continue;
      if (block.qty + d.qty > config.capacity) continue;
      block.items.push(d);
      block.qty += d.qty;
      recurse(i + 1);
      block.items.pop();
      block.qty -= d.qty;
    }
    blocks.push({ family: d.family, items: [d], qty: d.qty });
    recurse(i + 1);
    blocks.pop();
  })(0);

  return best;
}
