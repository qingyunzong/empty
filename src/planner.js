import { Calendar, MINUTE_MS } from './calendar.js';
import { CODES, PlanError } from './errors.js';
import { normalizeMachines, normalizeOrder } from './normalize.js';
import { compareOrders, scheduleGreedy } from './scheduler.js';
import { enumerateSchedules } from './reference.js';

const iso = (ms) => new Date(ms).toISOString();

function clone(value) {
  return structuredClone(value);
}

export function diffPlacements(next, baseline, oldOrderIds) {
  const ids = [];
  for (const id of oldOrderIds) {
    const before = baseline.get(id);
    const after = next.get(id);
    if (!before || !after || before.length !== after.length) {
      ids.push(id);
      continue;
    }
    const changed = before.some(
      (op, i) => op.machine !== after[i].machine || op.start !== after[i].start || op.end !== after[i].end,
    );
    if (changed) ids.push(id);
  }
  return { count: ids.length, ids };
}

export class Planner {
  constructor({ calendar, machines, nodeCap } = {}) {
    this.calendar = calendar instanceof Calendar ? calendar : new Calendar(calendar);
    this.machineIds = normalizeMachines(machines);
    this.nodeCap = nodeCap ?? 200_000;
    this.orders = new Map();
    this.plan = null;
    this.history = [];
    this.redoStack = [];
    this.openGroup = null;
  }

  snapshot() {
    return clone({ orders: this.orders, plan: this.plan });
  }

  restore(snap) {
    const c = clone(snap);
    this.orders = c.orders;
    this.plan = c.plan;
  }

  beginGroup(label = 'group') {
    if (this.openGroup) {
      throw new PlanError(CODES.INVALID_STATE, 'a command group is already open');
    }
    this.openGroup = { label, before: this.snapshot() };
  }

  commitGroup() {
    if (!this.openGroup) {
      throw new PlanError(CODES.INVALID_STATE, 'no command group is open');
    }
    const group = this.openGroup;
    this.openGroup = null;
    group.after = this.snapshot();
    this.history.push(group);
    this.redoStack = [];
    return { ok: true, label: group.label };
  }

  record(label, before) {
    if (this.openGroup) return;
    this.history.push({ label, before, after: this.snapshot() });
    this.redoStack = [];
  }

  addOrder(raw) {
    const order = normalizeOrder(raw, this.machineIds);
    if (this.orders.has(order.id)) {
      throw new PlanError(CODES.VALIDATION, `duplicate order id ${order.id}`);
    }
    const before = this.openGroup ? null : this.snapshot();
    this.orders.set(order.id, order);
    this.record(`addOrder:${order.id}`, before);
    return { ok: true, orderId: order.id };
  }

  schedule() {
    const before = this.openGroup ? null : this.snapshot();
    let result;
    try {
      result = scheduleGreedy({ orders: [...this.orders.values()], calendar: this.calendar, machineIds: this.machineIds });
    } catch (e) {
      if (e instanceof PlanError && e.code === CODES.INFEASIBLE) {
        return { ok: false, code: CODES.INFEASIBLE, message: e.message, details: e.details };
      }
      throw e;
    }
    this.plan = { placements: result.placements, decisions: result.decisions };
    this.record('schedule', before);
    return { ok: true, plan: this.planJson() };
  }

  commitRush(rush, placements, decisions, label) {
    const before = this.openGroup ? null : this.snapshot();
    this.orders.set(rush.id, rush);
    this.plan = { placements, decisions };
    this.record(label, before);
  }

  insertRush(rawOrder, { budget = Number.POSITIVE_INFINITY } = {}) {
    if (!(budget === Number.POSITIVE_INFINITY || (Number.isInteger(budget) && budget >= 0))) {
      throw new PlanError(CODES.VALIDATION, 'budget must be a non-negative integer');
    }
    const rush = normalizeOrder(rawOrder, this.machineIds);
    if (this.orders.has(rush.id)) {
      throw new PlanError(CODES.VALIDATION, `duplicate order id ${rush.id}`);
    }
    const all = [...this.orders.values(), rush];
    let greedy;
    try {
      greedy = scheduleGreedy({ orders: all, calendar: this.calendar, machineIds: this.machineIds });
    } catch (e) {
      if (e instanceof PlanError && e.code === CODES.INFEASIBLE) {
        return { ok: false, code: CODES.INFEASIBLE, message: e.message, details: e.details };
      }
      throw e;
    }
    const baseline = this.plan?.placements ?? null;
    const oldIds = [...this.orders.keys()];
    const greedyDiff = baseline
      ? diffPlacements(greedy.placements, baseline, oldIds)
      : { count: 0, ids: [] };
    if (greedyDiff.count <= budget) {
      this.commitRush(rush, greedy.placements, greedy.decisions, `insertRush:${rush.id}`);
      return {
        ok: true,
        orderId: rush.id,
        disturbed: greedyDiff.ids,
        disturbedCount: greedyDiff.count,
        budget,
        schedule: 'greedy',
        plan: this.planJson(),
      };
    }
    const ref = enumerateSchedules({
      orders: all,
      calendar: this.calendar,
      machineIds: this.machineIds,
      baseline,
      nodeCap: this.nodeCap,
    });
    if (ref.best && ref.best.disturbed <= budget) {
      this.commitRush(rush, ref.best.placements, [], `insertRush:${rush.id}`);
      return {
        ok: true,
        orderId: rush.id,
        disturbed: diffPlacements(ref.best.placements, baseline, oldIds).ids,
        disturbedCount: ref.best.disturbed,
        budget,
        schedule: 'reference',
        proven: ref.proven,
        plan: this.planJson(),
      };
    }
    const required = ref.best ? ref.best.disturbed : greedyDiff.count;
    return {
      ok: false,
      code: CODES.BUDGET_EXCEEDED,
      message: `reschedule would disturb at least ${required} order(s); budget is ${budget}`,
      gap: { budget, required, deficit: required - budget, proven: ref.proven },
    };
  }

  undo() {
    if (this.history.length === 0) {
      return { ok: false, code: CODES.INVALID_STATE, message: 'nothing to undo' };
    }
    const group = this.history.pop();
    this.redoStack.push(group);
    this.restore(group.before);
    return { ok: true, label: group.label };
  }

  redo() {
    if (this.redoStack.length === 0) {
      return { ok: false, code: CODES.INVALID_STATE, message: 'nothing to redo' };
    }
    const group = this.redoStack.pop();
    this.history.push(group);
    this.restore(group.after);
    return { ok: true, label: group.label };
  }

  planJson() {
    const placements = this.plan?.placements ?? new Map();
    const decisions = this.plan?.decisions ?? [];
    const busyByMachine = new Map(this.machineIds.map((m) => [m, []]));
    const ordersJson = [];
    let makespan = null;
    for (const order of [...this.orders.values()].sort(compareOrders)) {
      const ops = placements.get(order.id);
      if (!ops) continue;
      ordersJson.push({
        orderId: order.id,
        ops: ops.map((o) => ({
          opId: o.opId,
          machine: o.machine,
          start: iso(o.start),
          end: iso(o.end),
          durationMinutes: o.duration / MINUTE_MS,
        })),
      });
      for (const o of ops) {
        busyByMachine.get(o.machine).push([o.start, o.end]);
        if (makespan === null || o.end > makespan) makespan = o.end;
      }
    }
    const machinesJson = [];
    let totalIdle = 0;
    for (const [id, machineBusy] of busyByMachine) {
      machineBusy.sort((a, b) => a[0] - b[0]);
      let idle = 0;
      if (machineBusy.length > 0) {
        const busySum = machineBusy.reduce((acc, [s, e]) => acc + (e - s), 0);
        idle = this.calendar.workingTimeBetween(machineBusy[0][0], machineBusy[machineBusy.length - 1][1]) - busySum;
      }
      totalIdle += idle;
      machinesJson.push({
        id,
        busy: machineBusy.map(([s, e]) => ({ start: iso(s), end: iso(e) })),
        idleMinutes: idle / MINUTE_MS,
      });
    }
    return {
      orders: ordersJson,
      machines: machinesJson,
      makespan: makespan === null ? null : iso(makespan),
      totalIdleMinutes: totalIdle / MINUTE_MS,
      decisions: decisions.map((d) => ({
        orderId: d.orderId,
        opId: d.opId,
        chosen: { machine: d.chosen.machine, start: iso(d.chosen.start) },
        candidates: d.candidates.map((c) => ({
          machine: c.machine,
          start: iso(c.start),
          idleDeltaMinutes: c.idleDelta / MINUTE_MS,
        })),
      })),
    };
  }
}
