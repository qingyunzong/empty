/**
 * Rolling-plan engine.
 *
 * State persisted between revisions:
 * - config, orders (by id), current runs, prepared order ids,
 *   freeze boundary, accumulated compensation, revision counter.
 *
 * plan(input): build the initial plan.
 * replan(events): rolling update.
 *   - Runs starting before the freeze boundary are frozen and never move.
 *   - Unfrozen runs are dissolved; their batches return to the waiting queue
 *     (already-loaded parts in frozen runs are kept). Waiting orders age.
 *   - Urgent orders preempt normal ones at run boundaries via priority.
 *   - Canceling an unfrozen order releases its quota; if tooling preparation
 *     already happened for it, a fixed compensation slot is deducted from the
 *     furnace timeline right after the frozen part and added to the objective.
 */
import { normalizeConfig, normalizeOrder, validateOrders } from './model.js';
import { greedySchedule } from './scheduler.js';

export class Engine {
  constructor() {
    this.state = null;
  }

  static fromState(state) {
    const engine = new Engine();
    engine.state = state;
    return engine;
  }

  plan(input) {
    const cfg = normalizeConfig(input.config);
    const orders = (input.orders ?? []).map((o) => normalizeOrder(o, 0));
    const errors = validateOrders(cfg, orders);
    if (errors.length > 0) return { ok: false, errors };

    const sch = greedySchedule(cfg, orders.map((o) => ({ ...o })), { now: 0 });
    const runs = sch.runs.map((r) => ({ ...r, frozen: false }));
    const prepared = [...new Set(runs.flatMap((r) => r.loads.map((l) => l.order)))].sort();

    this.state = {
      config: cfg,
      orders: Object.fromEntries(orders.map((o) => [o.id, o])),
      canceled: [],
      runs,
      prepared,
      freezeBoundary: input.freezeBoundary ?? 0,
      compensation: 0,
      compensationEvents: [],
      revision: 1,
    };
    return this.buildResult({
      keptRuns: [],
      removedRuns: [],
      addedRuns: runs.map((r) => r.runNo),
      canceled: [],
      compensationEvents: [],
    });
  }

  replan(events = {}) {
    if (!this.state) {
      return { ok: false, errors: ['no existing plan; run `plan` first'] };
    }
    const s = this.state;
    const cfg = s.config;
    const now = events.now ?? s.freezeBoundary;
    const freezeBoundary = Math.max(s.freezeBoundary, events.freezeHorizon ?? now);

    // Tooling preparation: every order in the published plan counts as prepared.
    const prepared = new Set(s.prepared);
    for (const r of s.runs) for (const l of r.loads) prepared.add(l.order);
    for (const id of events.prepare ?? []) prepared.add(String(id));

    const prevRuns = s.runs;
    const frozenRuns = prevRuns
      .filter((r) => r.start < freezeBoundary)
      .map((r) => ({ ...r, frozen: true }));
    const unfrozenRuns = prevRuns.filter((r) => r.start >= freezeBoundary);

    const frozenBatches = new Map();
    for (const r of frozenRuns) {
      for (const l of r.loads) {
        frozenBatches.set(l.order, (frozenBatches.get(l.order) ?? 0) + l.batches);
      }
    }

    // Cancellations.
    const errors = [];
    const canceledNow = [];
    let compensationDelta = 0;
    const compEvents = [];
    for (const rawId of events.cancel ?? []) {
      const id = String(rawId);
      const o = s.orders[id];
      if (!o || s.canceled.includes(id)) {
        errors.push(`cancel: unknown order "${id}"`);
        continue;
      }
      if ((frozenBatches.get(id) ?? 0) >= o.batches) {
        errors.push(`cancel: order "${id}" is fully frozen and cannot be canceled`);
        continue;
      }
      canceledNow.push(id);
      if (prepared.has(id)) {
        compensationDelta += cfg.compensationSlots;
        compEvents.push({ order: id, slots: cfg.compensationSlots });
      }
    }
    if (errors.length > 0) return { ok: false, errors };

    // New urgent/normal orders arrive now.
    const added = (events.add ?? []).map((o) => normalizeOrder(o, now));
    const addErrors = validateOrders(cfg, added, { existingIds: new Set(Object.keys(s.orders)) });
    if (addErrors.length > 0) return { ok: false, errors: addErrors };
    for (const o of added) s.orders[o.id] = o;

    // Rebuild the waiting queue: unfrozen remainders requeue and keep aging.
    const canceledSet = new Set([...s.canceled, ...canceledNow]);
    const queue = [];
    for (const o of Object.values(s.orders)) {
      if (canceledSet.has(o.id)) continue;
      const rem = o.batches - (frozenBatches.get(o.id) ?? 0);
      if (rem > 0) queue.push({ ...o, batches: rem });
    }

    // Quota already consumed by frozen runs stays consumed.
    const quotaUsed = new Map();
    for (const r of frozenRuns) {
      for (const l of r.loads) {
        const key = `${r.day}|${l.recipe}`;
        quotaUsed.set(key, (quotaUsed.get(key) ?? 0) + l.units);
      }
    }

    const lastFrozen = frozenRuns.length > 0 ? frozenRuns[frozenRuns.length - 1] : null;
    const startTime = (lastFrozen ? lastFrozen.end : 0) + compensationDelta;
    const sch = greedySchedule(cfg, queue, {
      now,
      startTime,
      prevGroup: lastFrozen ? lastFrozen.group : null,
      firstRunNo: lastFrozen ? lastFrozen.runNo + 1 : 1,
      quotaUsed,
    });
    const newRuns = sch.runs.map((r) => ({ ...r, frozen: false }));
    for (const r of newRuns) for (const l of r.loads) prepared.add(l.order);

    s.canceled = [...canceledSet].sort();
    s.runs = [...frozenRuns, ...newRuns];
    s.prepared = [...prepared].sort();
    s.freezeBoundary = freezeBoundary;
    s.compensation += compensationDelta;
    s.compensationEvents = [...s.compensationEvents, ...compEvents];
    s.revision += 1;

    return this.buildResult({
      keptRuns: frozenRuns.map((r) => r.runNo),
      removedRuns: unfrozenRuns.map((r) => r.runNo),
      addedRuns: newRuns.map((r) => r.runNo),
      canceled: canceledNow,
      compensationEvents: compEvents,
    });
  }

  buildResult(diff) {
    const s = this.state;
    const cfg = s.config;
    let tardiness = 0;
    let cleaning = 0;
    const quota = new Map();
    const perOrder = new Map();
    for (const r of s.runs) {
      cleaning += r.cleanBefore;
      for (const l of r.loads) {
        const o = s.orders[l.order];
        const t = Math.max(0, r.end - o.due);
        tardiness += l.batches * t;
        const key = `${r.day}|${l.recipe}`;
        quota.set(key, (quota.get(key) ?? 0) + l.units);
        const agg = perOrder.get(l.order) ?? { end: -Infinity, tard: 0, batches: 0 };
        agg.end = Math.max(agg.end, r.end);
        agg.tard += l.batches * t;
        agg.batches += l.batches;
        perOrder.set(l.order, agg);
      }
    }
    const quotaUsage = [...quota.entries()]
      .map(([key, used]) => {
        const sep = key.indexOf('|');
        const day = Number(key.slice(0, sep));
        const recipe = key.slice(sep + 1);
        return { day, recipe, used, quota: cfg.recipes[recipe].dailyQuota };
      })
      .sort((a, b) => a.day - b.day || (a.recipe < b.recipe ? -1 : 1));
    const orders = Object.values(s.orders)
      .map((o) => {
        const agg = perOrder.get(o.id);
        const canceled = s.canceled.includes(o.id);
        return {
          id: o.id,
          recipe: o.recipe,
          priority: o.priority,
          status: canceled ? 'canceled' : 'scheduled',
          batches: o.batches,
          scheduledBatches: agg ? agg.batches : 0,
          completion: agg ? agg.end : null,
          tardiness: agg ? agg.tard : 0,
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return {
      ok: true,
      revision: s.revision,
      objective: {
        tardiness,
        cleaning,
        compensation: s.compensation,
        total: tardiness + cleaning + s.compensation,
      },
      freezeBoundary: {
        time: s.freezeBoundary,
        frozenRuns: s.runs.filter((r) => r.frozen).map((r) => r.runNo),
      },
      runs: s.runs,
      quotaUsage,
      orders,
      diff,
    };
  }
}
