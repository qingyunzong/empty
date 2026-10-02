const PRIORITY_WEIGHT = { normal: 0, high: 1_000_000 };

/**
 * Rework routing scheduler.
 *
 * A defective work order travels a route of stations (diagnosis -> repair ->
 * re-inspection, or any ordered list). Allocation is attempted station by
 * station; every step tentatively consumes station capacity and line labor
 * budget. If any later step cannot be satisfied, all tentative holds of that
 * order are rolled back and released — no partial locks survive.
 *
 * High-priority orders may preempt normal ones, but only by evicting a
 * victim whose stations overlapping the preemptor's remaining route form a
 * complete contiguous segment of the victim's route. Eviction releases the
 * victim's whole allocation (atomic) and re-queues it.
 *
 * The waiting queue is ordered by (priority weight + age) descending, so
 * normal orders that keep losing are eventually re-dispatched.
 */
export class Scheduler {
  constructor(config = {}) {
    const { lines = [], stations = [] } = config;

    this.lines = new Map();
    for (const line of lines) {
      if (!line || typeof line.id !== 'string' || line.id.length === 0) {
        throw new TypeError('each line requires a non-empty string id');
      }
      if (!Number.isFinite(line.budgetPerShift) || line.budgetPerShift < 0) {
        throw new RangeError(`line ${line.id}: budgetPerShift must be a non-negative number`);
      }
      this.lines.set(line.id, { id: line.id, budgetPerShift: line.budgetPerShift });
    }

    this.stations = new Map();
    for (const station of stations) {
      if (!station || typeof station.id !== 'string' || station.id.length === 0) {
        throw new TypeError('each station requires a non-empty string id');
      }
      if (!this.lines.has(station.lineId)) {
        throw new RangeError(`station ${station.id}: unknown line ${station.lineId}`);
      }
      if (!Number.isFinite(station.capacityPerShift) || station.capacityPerShift < 0) {
        throw new RangeError(`station ${station.id}: capacityPerShift must be a non-negative number`);
      }
      if (station.calendar !== undefined) {
        if (!Array.isArray(station.calendar)) {
          throw new TypeError(`station ${station.id}: calendar must be an array of {capacity}`);
        }
        for (const entry of station.calendar) {
          if (!entry || !Number.isFinite(entry.capacity) || entry.capacity < 0) {
            throw new RangeError(`station ${station.id}: calendar capacities must be non-negative numbers`);
          }
        }
      }
      this.stations.set(station.id, {
        id: station.id,
        lineId: station.lineId,
        capacityPerShift: station.capacityPerShift,
        calendar: station.calendar ?? null,
      });
    }

    this.shiftIndex = 0;
    this.seq = 0;
    this.events = [];
    this.preemptions = [];
    this.rollbacks = [];
    this.errors = [];
    this.allocations = new Map(); // orderId -> [{level, station, lineId, minutes, shift}]
    this.orderMeta = new Map(); // orderId -> {id, priority, route, age, seq, preemptedCount}
    this.waiting = [];
    this.arrivals = [];
    this.remainingCapacity = new Map();
    this.remainingBudget = new Map();
    this.#resetShiftResources();
  }

  #stationCapacityAt(station, shift) {
    if (station.calendar) {
      const entry = station.calendar[shift];
      return entry ? entry.capacity : 0;
    }
    return station.capacityPerShift;
  }

  #resetShiftResources() {
    for (const [id, station] of this.stations) {
      this.remainingCapacity.set(id, this.#stationCapacityAt(station, this.shiftIndex));
    }
    for (const [id, line] of this.lines) {
      this.remainingBudget.set(id, line.budgetPerShift);
    }
  }

  /** Validate and register an order. Invalid orders are recorded in `errors`. */
  addOrder(order) {
    const problem = this.#validateOrder(order);
    if (problem) {
      this.errors.push({
        orderId: order && typeof order.id === 'string' ? order.id : null,
        code: problem.code,
        message: problem.message,
        shift: this.shiftIndex,
      });
      return false;
    }
    this.orderMeta.set(order.id, {
      id: order.id,
      priority: order.priority ?? 'normal',
      route: order.route.map((step, level) => ({
        station: step.station,
        minutes: step.minutes,
        level,
      })),
      age: 0,
      seq: this.seq++,
      preemptedCount: 0,
    });
    this.arrivals.push(order.id);
    return true;
  }

  #validateOrder(order) {
    if (!order || typeof order.id !== 'string' || order.id.length === 0) {
      return { code: 'INVALID_ORDER', message: 'order requires a non-empty string id' };
    }
    if (this.orderMeta.has(order.id)) {
      return { code: 'DUPLICATE_ORDER', message: `order ${order.id}: duplicate id` };
    }
    const priority = order.priority ?? 'normal';
    if (priority !== 'normal' && priority !== 'high') {
      return { code: 'INVALID_PRIORITY', message: `order ${order.id}: priority must be "normal" or "high"` };
    }
    if (!Array.isArray(order.route) || order.route.length === 0) {
      return { code: 'EMPTY_ROUTE', message: `order ${order.id}: route must be a non-empty array` };
    }
    for (const step of order.route) {
      const station = this.stations.get(step?.station);
      if (!station) {
        return { code: 'UNKNOWN_STATION', message: `order ${order.id}: unknown station ${step?.station}` };
      }
      if (!Number.isFinite(step.minutes) || step.minutes <= 0) {
        return {
          code: 'NEGATIVE_MINUTES',
          message: `order ${order.id}: minutes must be a positive number, got ${step?.minutes}`,
        };
      }
      const line = this.lines.get(station.lineId);
      if (step.minutes > line.budgetPerShift) {
        return {
          code: 'OVER_BUDGET',
          message: `order ${order.id}: step at ${step.station} needs ${step.minutes}min, exceeds per-shift budget of line ${line.id} (${line.budgetPerShift}min)`,
        };
      }
    }
    return null;
  }

  /** Process all pending arrivals (in submission order), then drain the waiting queue. */
  run() {
    for (const id of this.arrivals) {
      const meta = this.orderMeta.get(id);
      const result = this.#allocateAttempt(meta);
      if (!result.ok) this.#enqueue(meta);
    }
    this.arrivals = [];
    this.#dispatchLoop();
    return this.getResult();
  }

  /** Move to the next shift: calendars and budgets reset, waiting queue re-dispatched. */
  advanceShift() {
    this.shiftIndex += 1;
    this.#resetShiftResources();
    this.#dispatchLoop();
    return this.getResult();
  }

  #enqueue(meta) {
    if (!this.waiting.includes(meta)) this.waiting.push(meta);
  }

  #dispatchLoop() {
    for (;;) {
      this.waiting.sort((a, b) => {
        const scoreA = PRIORITY_WEIGHT[a.priority] + a.age;
        const scoreB = PRIORITY_WEIGHT[b.priority] + b.age;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return a.seq - b.seq;
      });
      let progress = false;
      for (const meta of [...this.waiting]) {
        const result = this.#allocateAttempt(meta);
        if (result.ok) {
          this.waiting = this.waiting.filter((entry) => entry !== meta);
          progress = true;
        } else {
          meta.age += 1;
        }
      }
      if (!progress) return;
    }
  }

  #allocateAttempt(meta) {
    const tentative = [];
    for (const step of meta.route) {
      const station = this.stations.get(step.station);
      const lineId = station.lineId;
      if (this.remainingCapacity.get(step.station) < step.minutes && meta.priority === 'high') {
        this.#preempt(meta, step);
      }
      if (this.remainingCapacity.get(step.station) < step.minutes) {
        this.#rollback(meta, tentative, `insufficient capacity at station ${step.station}`);
        return { ok: false, reason: 'capacity', station: step.station };
      }
      if (this.remainingBudget.get(lineId) < step.minutes) {
        this.#rollback(meta, tentative, `insufficient budget on line ${lineId}`);
        return { ok: false, reason: 'budget', lineId };
      }
      this.remainingCapacity.set(step.station, this.remainingCapacity.get(step.station) - step.minutes);
      this.remainingBudget.set(lineId, this.remainingBudget.get(lineId) - step.minutes);
      tentative.push({
        level: step.level,
        station: step.station,
        lineId,
        minutes: step.minutes,
        shift: this.shiftIndex,
      });
      this.events.push({
        type: 'consume',
        shift: this.shiftIndex,
        orderId: meta.id,
        level: step.level,
        station: step.station,
        lineId,
        minutes: step.minutes,
      });
    }
    this.allocations.set(meta.id, tentative);
    return { ok: true };
  }

  /**
   * High-priority preemption. Only normal orders occupying `step.station`
   * are candidates, and a victim may be evicted only when the stations it
   * shares with the preemptor's remaining route form a complete contiguous
   * segment of the victim's route. Eviction releases the victim's entire
   * allocation and re-queues it.
   */
  #preempt(meta, step) {
    const needed = step.minutes - this.remainingCapacity.get(step.station);
    if (needed <= 0) return;
    const neededStations = new Set(
      meta.route.filter((s) => s.level >= step.level).map((s) => s.station),
    );
    let freed = 0;
    const victims = [];
    for (const [id, alloc] of this.allocations) {
      const victimMeta = this.orderMeta.get(id);
      if (victimMeta.priority !== 'normal') continue;
      if (!alloc.some((a) => a.station === step.station)) continue;
      victims.push(victimMeta);
    }
    victims.sort((a, b) => b.seq - a.seq); // newest normal order first
    for (const victim of victims) {
      if (freed >= needed) break;
      const victimStations = victim.route.map((s) => s.station);
      const segmentIdx = [];
      victimStations.forEach((stationId, idx) => {
        if (neededStations.has(stationId)) segmentIdx.push(idx);
      });
      const contiguous =
        segmentIdx.length > 0 && segmentIdx.every((value, idx) => value === segmentIdx[0] + idx);
      if (!contiguous) continue; // may only preempt a complete contiguous station segment
      const alloc = this.allocations.get(victim.id);
      for (const a of alloc) {
        this.remainingCapacity.set(a.station, this.remainingCapacity.get(a.station) + a.minutes);
        this.remainingBudget.set(a.lineId, this.remainingBudget.get(a.lineId) + a.minutes);
        this.events.push({
          type: 'release',
          cause: 'preempted',
          shift: this.shiftIndex,
          orderId: victim.id,
          level: a.level,
          station: a.station,
          lineId: a.lineId,
          minutes: a.minutes,
        });
      }
      this.allocations.delete(victim.id);
      victim.preemptedCount += 1;
      this.#enqueue(victim);
      freed += alloc
        .filter((a) => a.station === step.station)
        .reduce((sum, a) => sum + a.minutes, 0);
      this.preemptions.push({
        shift: this.shiftIndex,
        by: meta.id,
        victim: victim.id,
        station: step.station,
        segment: segmentIdx.map((idx) => victimStations[idx]),
        released: alloc.map((a) => ({ ...a })),
      });
    }
  }

  /** Reverse every tentative hold of a failed attempt, in reverse order. */
  #rollback(meta, tentative, reason) {
    for (const t of [...tentative].reverse()) {
      this.remainingCapacity.set(t.station, this.remainingCapacity.get(t.station) + t.minutes);
      this.remainingBudget.set(t.lineId, this.remainingBudget.get(t.lineId) + t.minutes);
      this.events.push({
        type: 'release',
        cause: 'rollback',
        shift: this.shiftIndex,
        orderId: meta.id,
        level: t.level,
        station: t.station,
        lineId: t.lineId,
        minutes: t.minutes,
      });
    }
    if (tentative.length > 0) {
      this.rollbacks.push({
        shift: this.shiftIndex,
        orderId: meta.id,
        reason,
        released: tentative.map((t) => ({ ...t })),
      });
    }
  }

  getResult() {
    const routes = [];
    const budgetDeductions = [];
    for (const [id, alloc] of this.allocations) {
      const meta = this.orderMeta.get(id);
      routes.push({
        orderId: id,
        priority: meta.priority,
        steps: alloc.map((a) => ({ ...a })),
      });
      for (const a of alloc) {
        budgetDeductions.push({
          orderId: id,
          level: a.level,
          station: a.station,
          lineId: a.lineId,
          minutes: a.minutes,
          shift: a.shift,
        });
      }
    }
    return {
      shift: this.shiftIndex,
      routes,
      budgetDeductions,
      preemptions: this.preemptions.map((p) => ({ ...p })),
      rollbacks: this.rollbacks.map((r) => ({ ...r })),
      errors: this.errors.map((e) => ({ ...e })),
      waiting: this.waiting.map((m) => ({
        orderId: m.id,
        priority: m.priority,
        age: m.age,
        preemptedCount: m.preemptedCount,
      })),
      events: this.events.map((e) => ({ ...e })),
    };
  }
}
