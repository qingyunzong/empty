import type {
  ChargerSpec,
  EnergyEvent,
  LegSpec,
  SimConfig,
  TickSnapshot,
  VehicleSnapshot,
  VehicleSpec,
  VehicleState,
} from "./types.js";

export interface VehicleRuntime {
  spec: VehicleSpec;
  node: string;
  state: VehicleState;
  battery: number;
  legIndex: number;
  legProgress: number;
  charged: number;
  driveConsumed: number;
  auxConsumed: number;
  requestTick: number | null;
}

export interface ChargerRuntime {
  spec: ChargerSpec;
  /** Vehicle ids currently holding a slot (insertion ordered). */
  occupants: string[];
  /** Vehicle ids queued for a slot, FIFO by (requestTick, id). */
  queue: string[];
}

/** Serializable full state, used for snapshot / restore / replay. */
export interface SimSnapshot {
  tick: number;
  vehicles: VehicleRuntime[];
  chargers: ChargerRuntime[];
  events: EnergyEvent[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Integer energy cost of one tick of a leg at the given progress tick. */
export function legTickCost(leg: LegSpec, progress: number): number {
  const base = Math.floor(leg.energy / leg.ticks);
  const remainder = leg.energy % leg.ticks;
  return base + (progress < remainder ? 1 : 0);
}

function isOpen(spec: ChargerSpec, tick: number): boolean {
  return spec.windows.some((w) => tick >= w.start && tick < w.end);
}

export class Simulation {
  private vehicles: VehicleRuntime[];
  private chargers: ChargerRuntime[];
  private readonly maxTicks: number;
  private readonly recordHistory: boolean;
  private tick = 0;
  private events: EnergyEvent[] = [];
  private readonly historyLog: TickSnapshot[] = [];

  constructor(readonly config: SimConfig) {
    validateConfig(config);
    this.maxTicks = config.maxTicks;
    this.recordHistory = config.recordHistory ?? false;
    this.vehicles = config.vehicles.map((spec) => ({
      spec,
      node: spec.startNode,
      state: "idle" as VehicleState,
      battery: spec.initialBattery,
      legIndex: 0,
      legProgress: 0,
      charged: 0,
      driveConsumed: 0,
      auxConsumed: 0,
      requestTick: null,
    }));
    this.chargers = config.chargers.map((spec) => ({
      spec,
      occupants: [],
      queue: [],
    }));
    // Vehicles sitting on a charger node at tick 0 request charging before
    // the first grant phase, exactly like any other arrival.
    for (const v of this.vehicles) {
      this.handleArrival(v);
    }
    if (this.recordHistory) {
      this.historyLog.push(this.publicSnapshot());
    }
  }

  get currentTick(): number {
    return this.tick;
  }

  get eventLog(): readonly EnergyEvent[] {
    return this.events;
  }

  get history(): readonly TickSnapshot[] {
    return this.historyLog;
  }

  /** Run until quiescent or maxTicks; returns the number of ticks executed. */
  run(): number {
    while (this.tick < this.maxTicks && !this.isQuiescent()) {
      this.step();
    }
    return this.tick;
  }

  /** Advance exactly one tick. */
  step(): void {
    const tick = this.tick;

    // Phase 1: movement and arrivals.
    for (const v of this.vehicles) {
      if (v.state !== "moving") continue;
      const leg = v.spec.path[v.legIndex];
      if (!leg) {
        v.state = "done";
        continue;
      }
      const cost = legTickCost(leg, v.legProgress);
      if (v.battery >= cost) {
        v.battery -= cost;
        v.driveConsumed += cost;
        if (cost > 0) {
          this.events.push({ tick, vehicleId: v.spec.id, type: "drive", amount: cost });
        }
        v.legProgress += 1;
        if (v.legProgress === leg.ticks) {
          v.node = leg.to;
          v.legIndex += 1;
          v.legProgress = 0;
          this.handleArrival(v);
        }
      } else {
        // Battery 0 (or insufficient for the integer tick cost): the vehicle
        // may stop, but it cannot keep driving. Battery never goes negative.
        v.state = "stalled";
      }
    }

    // Phase 2: charging grants (strictly after same-tick arrivals).
    for (const c of this.chargers) {
      // Release occupants that reached their target / full battery.
      for (const id of [...c.occupants]) {
        const v = this.vehicle(id);
        if (v.battery >= this.chargeTarget(v, c.spec.node)) {
          c.occupants.splice(c.occupants.indexOf(id), 1);
          this.resume(v);
        }
      }
      if (isOpen(c.spec, tick)) {
        c.queue.sort((a, b) => {
          const va = this.vehicle(a);
          const vb = this.vehicle(b);
          const ra = va.requestTick ?? 0;
          const rb = vb.requestTick ?? 0;
          return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
        });
        while (c.occupants.length < c.spec.capacity && c.queue.length > 0) {
          const id = c.queue.shift() as string;
          c.occupants.push(id);
          const v = this.vehicle(id);
          v.state = "charging";
          v.requestTick = null;
        }
        for (const id of c.occupants) {
          const v = this.vehicle(id);
          const amount = Math.min(
            c.spec.ratePerTick,
            this.chargeTarget(v, c.spec.node) - v.battery,
          );
          if (amount > 0) {
            v.battery += amount;
            v.charged += amount;
            this.events.push({ tick, vehicleId: id, type: "charge", amount });
          }
        }
      }
      // Waiting vehicles may burn auxiliary energy, clamped at 0.
      for (const id of c.queue) {
        const v = this.vehicle(id);
        const drain = Math.min(v.spec.auxDrainPerTick ?? 0, v.battery);
        if (drain > 0) {
          v.battery -= drain;
          v.auxConsumed += drain;
          this.events.push({ tick, vehicleId: id, type: "aux", amount: drain });
        }
      }
    }

    this.tick += 1;
    if (this.recordHistory) {
      this.historyLog.push(this.publicSnapshot());
    }
  }

  /** Deep-cloned full state for later restore / replay. */
  snapshot(): SimSnapshot {
    return clone({
      tick: this.tick,
      vehicles: this.vehicles,
      chargers: this.chargers,
      events: this.events,
    });
  }

  /** Restore a previously taken snapshot (replay from that point). */
  restore(snapshot: SimSnapshot): void {
    const s = clone(snapshot);
    this.tick = s.tick;
    this.vehicles = s.vehicles;
    this.chargers = s.chargers;
    this.events = s.events;
    this.historyLog.length = 0;
    if (this.recordHistory) {
      this.historyLog.push(this.publicSnapshot());
    }
  }

  /** Public per-vehicle view at the current tick. */
  vehicleSnapshots(): VehicleSnapshot[] {
    return this.publicSnapshot().vehicles;
  }

  private publicSnapshot(): TickSnapshot {
    return {
      tick: this.tick,
      vehicles: this.vehicles.map((v) => ({
        id: v.spec.id,
        node: v.node,
        state: v.state,
        battery: v.battery,
        legIndex: v.legIndex,
        legProgress: v.legProgress,
      })),
    };
  }

  private vehicle(id: string): VehicleRuntime {
    const v = this.vehicles.find((x) => x.spec.id === id);
    if (!v) throw new Error(`unknown vehicle ${id}`);
    return v;
  }

  private chargeTarget(v: VehicleRuntime, node: string): number {
    const stop = (v.spec.chargePlan ?? []).find((s) => s.node === node);
    const target = stop ? stop.targetBattery : v.spec.batteryCapacity;
    return Math.min(target, v.spec.batteryCapacity);
  }

  private handleArrival(v: VehicleRuntime): void {
    const stop = (v.spec.chargePlan ?? []).find((s) => s.node === v.node);
    const charger = this.chargers.find((c) => c.spec.node === v.node);
    if (stop && charger && v.battery < this.chargeTarget(v, v.node)) {
      v.state = "waiting-charge";
      v.requestTick = this.tick;
      charger.queue.push(v.spec.id);
      return;
    }
    this.resume(v);
  }

  private resume(v: VehicleRuntime): void {
    v.state = v.legIndex < v.spec.path.length ? "moving" : "done";
  }

  private isQuiescent(): boolean {
    return this.vehicles.every(
      (v) => v.state !== "moving" && v.state !== "charging" && v.state !== "waiting-charge",
    );
  }
}

function validateConfig(config: SimConfig): void {
  const ids = new Set<string>();
  for (const v of config.vehicles) {
    if (ids.has(v.id)) throw new Error(`duplicate vehicle id ${v.id}`);
    ids.add(v.id);
    if (!Number.isInteger(v.initialBattery) || v.initialBattery < 0) {
      throw new Error(`vehicle ${v.id}: initialBattery must be a non-negative integer`);
    }
    if (v.initialBattery > v.batteryCapacity) {
      throw new Error(`vehicle ${v.id}: initialBattery exceeds capacity`);
    }
    for (const leg of v.path) {
      if (!Number.isInteger(leg.ticks) || leg.ticks < 1) {
        throw new Error(`vehicle ${v.id}: leg ticks must be an integer >= 1`);
      }
      if (!Number.isInteger(leg.energy) || leg.energy < 0) {
        throw new Error(`vehicle ${v.id}: leg energy must be a non-negative integer`);
      }
    }
    for (const stop of v.chargePlan ?? []) {
      if (!config.chargers.some((c) => c.node === stop.node)) {
        throw new Error(`vehicle ${v.id}: charge stop at ${stop.node} has no charger`);
      }
    }
  }
  for (const c of config.chargers) {
    if (c.capacity < 1) throw new Error(`charger ${c.id}: capacity must be >= 1`);
    if (!Number.isInteger(c.ratePerTick) || c.ratePerTick < 0) {
      throw new Error(`charger ${c.id}: ratePerTick must be a non-negative integer`);
    }
    for (const w of c.windows) {
      if (!(w.start < w.end)) throw new Error(`charger ${c.id}: invalid window`);
    }
  }
  if (!Number.isInteger(config.maxTicks) || config.maxTicks < 0) {
    throw new Error("maxTicks must be a non-negative integer");
  }
}
