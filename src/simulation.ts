import { Buffer, type ItemId } from "./buffer.js";
import { MaterialLedger } from "./ledger.js";
import { Machine, type MachineSnapshot, type Recipe, type FailureSpec } from "./machine.js";

export type EventType =
  | "injected"
  | "extracted"
  | "breakdown"
  | "repaired"
  | "completed"
  | "unloaded"
  | "blocked"
  | "started";

export interface SimEvent {
  readonly tick: number;
  readonly type: EventType;
  readonly machine?: string;
  readonly buffer?: string;
  readonly detail?: string;
}

export interface TickSnapshot {
  readonly tick: number;
  readonly machines: readonly MachineSnapshot[];
  readonly buffers: Readonly<Record<string, Readonly<Record<ItemId, number>>>>;
}

export interface BufferOptions {
  readonly id: string;
  readonly capacity: number;
}

export interface MachineConfig {
  readonly id: string;
  readonly recipe: Recipe;
  readonly input: string;
  readonly output: string;
  readonly failures?: readonly FailureSpec[];
}

/**
 * Tick-phase simulation. Each tick executes, in order:
 *
 *   1. failures & repairs: scheduled breakdowns apply; repair timers count down
 *      and repaired machines resume their interrupted state;
 *   2. completion (完工): processing machines advance one tick of work; a job
 *      reaching its process time converts held inputs into held outputs;
 *   3. unload (入库): machines holding finished goods move them into the
 *      output buffer if — and only if — everything fits; otherwise they stay
 *      blocked and keep holding the goods (the machine is not released early);
 *   4. start (开工): idle machines with enough input material consume the
 *      recipe inputs and begin a new job.
 *
 * After every tick the material ledger is checked against the physical count
 * (buffers + goods held inside machines) and a snapshot is recorded.
 */
export class Simulation {
  tick = 0;
  readonly events: SimEvent[] = [];
  readonly snapshots: TickSnapshot[] = [];
  readonly ledger = new MaterialLedger();
  /** When true (default), conservation is verified after every tick. */
  strictConservation = true;

  private readonly buffers = new Map<string, Buffer>();
  private readonly machines: Machine[] = [];

  addBuffer(options: BufferOptions): Buffer {
    if (this.buffers.has(options.id)) throw new Error(`duplicate buffer ${options.id}`);
    const buf = new Buffer(options.id, options.capacity);
    this.buffers.set(options.id, buf);
    return buf;
  }

  getBuffer(id: string): Buffer {
    const buf = this.buffers.get(id);
    if (!buf) throw new Error(`unknown buffer ${id}`);
    return buf;
  }

  addMachine(config: MachineConfig): Machine {
    const machine = new Machine({
      id: config.id,
      recipe: config.recipe,
      input: this.getBuffer(config.input),
      output: this.getBuffer(config.output),
      ...(config.failures !== undefined ? { failures: config.failures } : {}),
    });
    this.machines.push(machine);
    return machine;
  }

  getMachine(id: string): Machine {
    const machine = this.machines.find((m) => m.id === id);
    if (!machine) throw new Error(`unknown machine ${id}`);
    return machine;
  }

  /** Adds material from outside the system (counted by the ledger). */
  inject(bufferId: string, item: ItemId, qty: number): void {
    const buf = this.getBuffer(bufferId);
    buf.add(item, qty);
    this.ledger.recordInject(item, qty);
    this.events.push({ tick: this.tick, type: "injected", buffer: bufferId, detail: `${qty} ${item}` });
  }

  /** Removes material from the system (counted by the ledger). */
  extract(bufferId: string, item: ItemId, qty: number): void {
    const buf = this.getBuffer(bufferId);
    buf.remove(item, qty);
    this.ledger.recordExtract(item, qty);
    this.events.push({ tick: this.tick, type: "extracted", buffer: bufferId, detail: `${qty} ${item}` });
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
  }

  /** Advances the model by one tick. */
  step(): void {
    this.tick += 1;

    // Phase 1: failures & repairs.
    for (const m of this.machines) {
      if (m.repairTick() !== null) {
        this.emit({ tick: this.tick, type: "repaired", machine: m.id, detail: `resumed ${m.state}` });
      }
    }
    for (const m of this.machines) {
      const failure = m.failureAt(this.tick);
      if (failure !== undefined && m.state !== "down") {
        m.breakDown(failure.repairTicks);
        this.emit({ tick: this.tick, type: "breakdown", machine: m.id, detail: `repair ${failure.repairTicks}t` });
      }
    }

    // Phase 2: completion (完工).
    for (const m of this.machines) {
      if (m.state !== "processing") continue;
      m.progress += 1;
      if (m.progress === m.recipe.processTicks) {
        m.heldInputs.clear();
        for (const [item, qty] of Object.entries(m.recipe.outputs)) {
          m.heldOutputs.set(item, (m.heldOutputs.get(item) ?? 0) + qty);
        }
        m.state = "blocked";
        m.blockedReported = false;
        this.ledger.recordConversion(m.recipe.inputs, m.recipe.outputs);
        this.emit({ tick: this.tick, type: "completed", machine: m.id });
      }
    }

    // Phase 3: unload (入库). All-or-nothing: the machine keeps holding the
    // finished goods until the whole batch fits into the output buffer.
    for (const m of this.machines) {
      if (m.state !== "blocked") continue;
      const outputs = Object.fromEntries(m.heldOutputs);
      if (m.output.canFitAll(outputs)) {
        for (const [item, qty] of m.heldOutputs) m.output.add(item, qty);
        m.heldOutputs.clear();
        m.progress = 0;
        m.state = "idle";
        this.emit({ tick: this.tick, type: "unloaded", machine: m.id, buffer: m.output.id });
      } else if (!m.blockedReported) {
        m.blockedReported = true;
        this.emit({ tick: this.tick, type: "blocked", machine: m.id, buffer: m.output.id });
      }
    }

    // Phase 4: start (开工).
    for (const m of this.machines) {
      if (m.state !== "idle") continue;
      if (!m.input.hasAll(m.recipe.inputs)) continue;
      for (const [item, qty] of Object.entries(m.recipe.inputs)) {
        m.input.remove(item, qty);
        m.heldInputs.set(item, (m.heldInputs.get(item) ?? 0) + qty);
      }
      m.state = "processing";
      this.emit({ tick: this.tick, type: "started", machine: m.id });
    }

    if (this.strictConservation) this.checkConservation();
    this.snapshots.push(this.takeSnapshot());
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  /** Physical count of every item type: buffers plus goods held in machines. */
  physicalCount(): Map<ItemId, number> {
    const total = new Map<ItemId, number>();
    const bump = (item: ItemId, qty: number) => total.set(item, (total.get(item) ?? 0) + qty);
    for (const buf of this.buffers.values()) {
      for (const [item, qty] of Object.entries(buf.snapshot())) bump(item, qty);
    }
    for (const m of this.machines) {
      for (const [item, qty] of m.heldInputs) bump(item, qty);
      for (const [item, qty] of m.heldOutputs) bump(item, qty);
    }
    return total;
  }

  /** Verifies per-item material conservation against the ledger. */
  checkConservation(): void {
    try {
      this.ledger.check(this.physicalCount());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`tick ${this.tick}: ${message}`);
    }
  }

  takeSnapshot(): TickSnapshot {
    const buffers: Record<string, Readonly<Record<ItemId, number>>> = {};
    for (const [id, buf] of this.buffers) buffers[id] = buf.snapshot();
    return {
      tick: this.tick,
      machines: this.machines.map((m) => m.snapshot()),
      buffers,
    };
  }
}
