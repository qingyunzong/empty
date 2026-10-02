// Constructive furnace scheduler.
// Priority per run: urgent first, then longest waiting (aging), then earliest
// due, then id. A run only mixes recipes of one family; switching family
// between consecutive runs costs config.cleanoutTime. Per-recipe daily quota
// is a hard constraint: if nothing fits on the current day, the run is moved
// to the next day boundary.

export function buildDemands(orders, recipes) {
  const demands = [];
  const groups = new Map();
  for (const order of orders) {
    const family = recipes.get(order.recipe).family;
    if (!order.group) {
      demands.push({
        key: order.id,
        family,
        items: [{ orderId: order.id, recipe: order.recipe, qty: order.qty, due: order.due }],
        qty: order.qty,
        due: order.due,
        priority: order.priority,
        arrival: order.arrival,
        splittable: order.splittable,
      });
      continue;
    }
    let grouped = groups.get(order.group);
    if (!grouped) {
      grouped = {
        key: `group:${order.group}`,
        family,
        items: [],
        qty: 0,
        due: order.due,
        priority: order.priority,
        arrival: order.arrival,
        splittable: false,
      };
      groups.set(order.group, grouped);
      demands.push(grouped);
    }
    grouped.items.push({ orderId: order.id, recipe: order.recipe, qty: order.qty, due: order.due });
    grouped.qty += order.qty;
    grouped.due = Math.min(grouped.due, order.due);
    grouped.arrival = Math.max(grouped.arrival, order.arrival);
    if (order.priority === 'urgent') grouped.priority = 'urgent';
  }
  return demands;
}

function demandComparator(time) {
  return (a, b) => {
    const pa = a.priority === 'urgent' ? 0 : 1;
    const pb = b.priority === 'urgent' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const waitA = time - a.arrival;
    const waitB = time - b.arrival;
    if (waitA !== waitB) return waitB - waitA;
    if (a.due !== b.due) return a.due - b.due;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
}

export function scheduleDemands({
  demands,
  recipes,
  config,
  startTime = 0,
  initialFamily = null,
  quotaUsed = new Map(),
  nextRunId = 1,
}) {
  const runs = [];
  const reasons = [];
  const completion = {};
  const pending = demands.map((d) => ({ ...d, items: d.items.map((it) => ({ ...it })), qtyLeft: d.qty }));
  const quotaKey = (day, recipe) => `${day}:${recipe}`;
  const usedQty = (day, recipe) => quotaUsed.get(quotaKey(day, recipe)) ?? 0;
  const quotaLeft = (day, recipe) => recipes.get(recipe).dailyQuota - usedQty(day, recipe);

  let time = startTime;
  let prevFamily = initialFamily;
  let runId = nextRunId;
  let guard = 0;

  while (pending.length > 0) {
    if (++guard > 100000) {
      reasons.push('scheduling iteration limit exceeded');
      break;
    }
    const available = pending.filter((d) => d.arrival <= time);
    if (available.length === 0) {
      time = Math.min(...pending.map((d) => d.arrival));
      continue;
    }
    available.sort(demandComparator(time));
    const family = available[0].family;
    const candidates = available.filter((d) => d.family === family);
    const cleanout = prevFamily !== null && prevFamily !== family ? config.cleanoutTime : 0;
    let start = time + cleanout;
    let scheduled = false;

    for (let attempt = 0; attempt < 10000 && !scheduled; attempt++) {
      const day = Math.floor(start / config.dayLength);
      const runUsage = new Map();
      const left = (recipe) => quotaLeft(day, recipe) - (runUsage.get(recipe) ?? 0);
      let capacityLeft = config.capacity;
      const loads = [];
      const taken = new Map();

      for (const d of candidates) {
        if (capacityLeft <= 0) break;
        if (d.splittable) {
          const item = d.items[0];
          const take = Math.min(d.qtyLeft, capacityLeft, Math.max(0, left(item.recipe)));
          if (take <= 0) continue;
          loads.push({ orderId: item.orderId, recipe: item.recipe, qty: take });
          runUsage.set(item.recipe, (runUsage.get(item.recipe) ?? 0) + take);
          capacityLeft -= take;
          taken.set(d, take);
        } else {
          if (d.qty > capacityLeft) continue;
          if (!d.items.every((it) => left(it.recipe) >= it.qty)) continue;
          for (const it of d.items) {
            loads.push({ orderId: it.orderId, recipe: it.recipe, qty: it.qty });
            runUsage.set(it.recipe, (runUsage.get(it.recipe) ?? 0) + it.qty);
          }
          capacityLeft -= d.qty;
          taken.set(d, d.qty);
        }
      }

      if (loads.length === 0) {
        start = (day + 1) * config.dayLength;
        continue;
      }

      for (const [d, take] of taken) d.qtyLeft -= take;
      for (const [recipe, qty] of runUsage) {
        quotaUsed.set(quotaKey(day, recipe), usedQty(day, recipe) + qty);
      }
      const end = start + config.runDuration;
      for (const load of loads) {
        completion[load.orderId] = Math.max(completion[load.orderId] ?? 0, end);
      }
      runs.push({ id: runId++, family, loads, start, end, cleanout, day });
      time = end;
      prevFamily = family;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].qtyLeft <= 0) pending.splice(i, 1);
      }
      scheduled = true;
    }

    if (!scheduled) {
      reasons.push(`unable to schedule ${pending.length} remaining demand(s)`);
      break;
    }
  }

  return { runs, reasons, completion, nextRunId: runId, quotaUsed };
}
