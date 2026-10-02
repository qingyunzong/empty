import { normalizeScenario } from './model.js';
import { buildDemands, scheduleDemands } from './scheduler.js';

function computeObjective(runs, orders, completion, compensations) {
  let tardiness = 0;
  for (const order of orders) {
    const done = completion[order.id];
    if (done === undefined) continue;
    tardiness += Math.max(0, done - order.due);
  }
  const cleanout = runs.reduce((sum, r) => sum + r.cleanout, 0);
  const compensation = compensations.reduce((sum, c) => sum + c.duration, 0);
  return { tardiness, cleanout, compensation, total: tardiness + cleanout + compensation };
}

function quotaUsageReport(quotaUsed, recipes) {
  const rows = [];
  for (const [key, used] of quotaUsed.entries()) {
    const [day, recipe] = key.split(':');
    const quota = recipes.get(recipe).dailyQuota;
    rows.push({ day: Number(day), recipe, used, quota: quota === Infinity ? 'unlimited' : quota });
  }
  rows.sort((a, b) => a.day - b.day || (a.recipe < b.recipe ? -1 : 1));
  return rows;
}

function failedPlan(scenario, errors) {
  return {
    status: 'failed',
    reasons: errors,
    warnings: [],
    scenario,
    config: scenario?.config ?? null,
    runs: [],
    freezeTime: 0,
    freezeBoundary: { freezeTime: 0, frozenRunIds: [] },
    quotaUsage: [],
    compensations: [],
    objective: { tardiness: 0, cleanout: 0, compensation: 0, total: 0 },
    diff: { addedRunIds: [], removedRunIds: [], canceledOrderIds: [] },
    orderCompletion: {},
    nextRunId: 1,
  };
}

export function createPlan(scenario) {
  const { errors, config, recipes, orders } = normalizeScenario(scenario);
  if (errors.length > 0) return failedPlan(scenario, errors);

  const demands = buildDemands(orders, recipes);
  const quotaUsed = new Map();
  const { runs, reasons, completion, nextRunId } = scheduleDemands({ demands, recipes, config, quotaUsed });
  const compensations = [];
  return {
    status: reasons.length > 0 ? 'failed' : 'ok',
    reasons,
    warnings: [],
    scenario: { ...scenario, orders },
    config,
    runs,
    freezeTime: 0,
    freezeBoundary: { freezeTime: 0, frozenRunIds: [] },
    quotaUsage: quotaUsageReport(quotaUsed, recipes),
    compensations,
    objective: computeObjective(runs, orders, completion, compensations),
    diff: { addedRunIds: runs.map((r) => r.id), removedRunIds: [], canceledOrderIds: [] },
    orderCompletion: completion,
    nextRunId,
  };
}

export function updatePlan(plan, events = {}) {
  const base = plan.scenario;
  const mergedRecipes = [...(base.recipes ?? []), ...(events.addRecipes ?? [])];
  const mergedOrders = [...(base.orders ?? []), ...(events.addOrders ?? [])];
  const { errors, config, recipes, orders } = normalizeScenario({
    ...base,
    recipes: mergedRecipes,
    orders: mergedOrders,
  });
  if (errors.length > 0) return { ...plan, status: 'failed', reasons: errors };

  const freezeTime = Math.max(plan.freezeTime ?? 0, events.freezeTime ?? 0);
  const frozenRuns = plan.runs.filter((r) => r.start < freezeTime);
  const droppedRuns = plan.runs.filter((r) => r.start >= freezeTime);

  const frozenLoaded = new Map();
  const completion = {};
  for (const run of frozenRuns) {
    for (const load of run.loads) {
      frozenLoaded.set(load.orderId, (frozenLoaded.get(load.orderId) ?? 0) + load.qty);
      completion[load.orderId] = Math.max(completion[load.orderId] ?? 0, run.end);
    }
  }

  const warnings = [];
  const compensations = [...(plan.compensations ?? [])];
  const canceledOrderIds = [];
  const cancelSet = new Set(events.cancelOrders ?? []);
  const activeOrders = [];
  for (const order of orders) {
    if (!cancelSet.has(order.id)) {
      activeOrders.push(order);
      continue;
    }
    if ((frozenLoaded.get(order.id) ?? 0) > 0) {
      warnings.push(`order ${order.id}: cancel rejected, frozen runs already contain its loads`);
      activeOrders.push(order);
      continue;
    }
    canceledOrderIds.push(order.id);
    if (order.toolingPrepared) {
      compensations.push({
        orderId: order.id,
        slots: config.compensationSlots,
        duration: config.compensationSlots * config.slotDuration,
      });
    }
  }
  for (const id of cancelSet) {
    if (!orders.some((o) => o.id === id)) warnings.push(`cancel: unknown order ${id}`);
  }

  const remaining = [];
  for (const order of activeOrders) {
    const left = order.qty - (frozenLoaded.get(order.id) ?? 0);
    if (left > 0) remaining.push({ ...order, qty: left });
  }
  const demands = buildDemands(remaining, recipes);

  const quotaUsed = new Map();
  for (const run of frozenRuns) {
    for (const load of run.loads) {
      const key = `${run.day}:${load.recipe}`;
      quotaUsed.set(key, (quotaUsed.get(key) ?? 0) + load.qty);
    }
  }

  const lastFrozen = frozenRuns[frozenRuns.length - 1];
  const {
    runs: newRuns,
    reasons,
    completion: newCompletion,
    nextRunId,
  } = scheduleDemands({
    demands,
    recipes,
    config,
    startTime: lastFrozen ? lastFrozen.end : 0,
    initialFamily: lastFrozen ? lastFrozen.family : null,
    quotaUsed,
    nextRunId: plan.nextRunId ?? 1,
  });
  for (const [id, done] of Object.entries(newCompletion)) {
    completion[id] = Math.max(completion[id] ?? 0, done);
  }

  const runs = [...frozenRuns, ...newRuns];
  return {
    status: reasons.length > 0 ? 'failed' : 'ok',
    reasons,
    warnings,
    scenario: { ...base, recipes: mergedRecipes, orders: activeOrders },
    config,
    runs,
    freezeTime,
    freezeBoundary: { freezeTime, frozenRunIds: frozenRuns.map((r) => r.id) },
    quotaUsage: quotaUsageReport(quotaUsed, recipes),
    compensations,
    objective: computeObjective(runs, activeOrders, completion, compensations),
    diff: {
      addedRunIds: newRuns.map((r) => r.id),
      removedRunIds: droppedRuns.map((r) => r.id),
      canceledOrderIds,
    },
    orderCompletion: completion,
    nextRunId,
  };
}
