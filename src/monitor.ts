import {
  compileCondition,
  compileConditions,
  type CompiledCondition,
  type TimingConditionSpec,
} from "./condition.js";

/** Read-only view of one live (pending) instance, for per-tick enumeration. */
export interface InstanceView {
  readonly id: number;
  readonly condition: string;
  readonly bornTick: number;
  readonly deadline: number;
  readonly remainingTicks: number;
  /** Required event name -> first tick at which it was observed. */
  readonly seenRequired: Readonly<Record<string, number>>;
  readonly status: "pending";
}

export interface MatchOutcome {
  readonly kind: "match";
  readonly instanceId: number;
  readonly condition: string;
  /** Tick at which the instance was resolved (its deadline). */
  readonly tick: number;
  /** Window covered by the instance: (bornTick, deadline]. */
  readonly window: readonly [number, number];
  readonly evidence: {
    /** Required event name -> first tick it was observed inside the window. */
    readonly required: Readonly<Record<string, number>>;
  };
}

export type ViolationOutcome =
  | {
      readonly kind: "violation";
      readonly reason: "forbidden-event";
      readonly instanceId: number;
      readonly condition: string;
      /** Tick at which the forbidden event was observed. */
      readonly tick: number;
      readonly event: string;
      readonly window: readonly [number, number];
    }
  | {
      readonly kind: "violation";
      readonly reason: "missing-required";
      readonly instanceId: number;
      readonly condition: string;
      /** Tick at which the instance timed out (its deadline). */
      readonly tick: number;
      readonly missing: readonly string[];
      readonly window: readonly [number, number];
    };

export type Outcome = MatchOutcome | ViolationOutcome;

interface Instance {
  id: number;
  cond: CompiledCondition;
  bornTick: number;
  deadline: number;
  /** Required event name -> first tick seen (insertion order = require order). */
  seen: Map<string, number>;
}

/** JSON-serializable monitor state for snapshot/resume. */
export interface Snapshot {
  readonly version: 1;
  readonly tick: number;
  readonly nextId: number;
  readonly conditions: readonly TimingConditionSpec[];
  readonly instances: readonly {
    readonly id: number;
    readonly condition: string;
    readonly bornTick: number;
    readonly deadline: number;
    readonly seen: Readonly<Record<string, number>>;
  }[];
  readonly log: readonly Outcome[];
}

export class Monitor {
  private readonly conditions: readonly CompiledCondition[];
  private readonly byTrigger: Map<string, CompiledCondition[]>;
  private readonly instances = new Map<number, Instance>();
  private readonly log: Outcome[] = [];
  private currentTick = 0;
  private nextId = 1;

  constructor(conditions: CompiledCondition | readonly CompiledCondition[]) {
    this.conditions = Array.isArray(conditions)
      ? (conditions as readonly CompiledCondition[])
      : [conditions as CompiledCondition];
    if (this.conditions.length === 0) {
      throw new Error("Monitor: at least one compiled condition is required");
    }
    this.byTrigger = new Map();
    for (const cond of this.conditions) {
      const list = this.byTrigger.get(cond.trigger) ?? [];
      list.push(cond);
      this.byTrigger.set(cond.trigger, list);
    }
  }

  /** Current tick. Starts at 0; each step() call advances it by one. */
  get tick(): number {
    return this.currentTick;
  }

  /** All outcomes produced so far, in production order. */
  get outcomes(): readonly Outcome[] {
    return this.log;
  }

  /**
   * Advance exactly one tick, feeding the events that occur during it.
   *
   * Ordering guarantee: all input events of the tick are applied to live
   * instances (and new instances are spawned) BEFORE any deadline expiring
   * on this tick is resolved. An event arriving exactly on an instance's
   * deadline tick therefore still counts towards that instance.
   *
   * Returns the outcomes produced during this tick.
   */
  step(events: readonly string[] = []): Outcome[] {
    this.currentTick += 1;
    const produced: Outcome[] = [];
    const emit = (outcome: Outcome): void => {
      produced.push(outcome);
      this.log.push(outcome);
    };

    // 1. Inputs: apply each event to the instances that were live when the
    // tick began. Instances spawned this tick are created only afterwards,
    // so events simultaneous with a trigger fall outside its window (t, t+d].
    for (const event of events) {
      for (const instance of [...this.instances.values()]) {
        if (instance.cond.forbid.includes(event)) {
          this.instances.delete(instance.id);
          emit({
            kind: "violation",
            reason: "forbidden-event",
            instanceId: instance.id,
            condition: instance.cond.name,
            tick: this.currentTick,
            event,
            window: [instance.bornTick, instance.deadline],
          });
        } else if (
          instance.cond.require.includes(event) &&
          !instance.seen.has(event)
        ) {
          instance.seen.set(event, this.currentTick);
        }
      }
    }

    // 2. Spawns: each trigger event creates one instance per condition.
    for (const event of events) {
      const triggered = this.byTrigger.get(event);
      if (triggered) {
        for (const cond of triggered) {
          const id = this.nextId++;
          this.instances.set(id, {
            id,
            cond,
            bornTick: this.currentTick,
            deadline: this.currentTick + cond.windowTicks,
            seen: new Map(),
          });
        }
      }
    }

    // 3. Timeouts: resolve instances whose deadline expires on this tick.
    for (const instance of [...this.instances.values()]) {
      if (instance.deadline > this.currentTick) continue;
      this.instances.delete(instance.id);
      const missing = instance.cond.require.filter((e) => !instance.seen.has(e));
      const window: readonly [number, number] = [
        instance.bornTick,
        instance.deadline,
      ];
      if (missing.length === 0) {
        emit({
          kind: "match",
          instanceId: instance.id,
          condition: instance.cond.name,
          tick: this.currentTick,
          window,
          evidence: { required: Object.fromEntries(instance.seen) },
        });
      } else {
        emit({
          kind: "violation",
          reason: "missing-required",
          instanceId: instance.id,
          condition: instance.cond.name,
          tick: this.currentTick,
          missing,
          window,
        });
      }
    }

    return produced;
  }

  /** Advance n ticks without input events. */
  advance(ticks: number): Outcome[] {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new Error("advance: ticks must be a non-negative integer");
    }
    const produced: Outcome[] = [];
    for (let i = 0; i < ticks; i++) produced.push(...this.step());
    return produced;
  }

  /**
   * Cancel exactly the live instance with the given id. Other instances —
   * including ones spawned by the same condition — are unaffected.
   * Returns true when an instance was removed.
   */
  cancel(instanceId: number): boolean {
    return this.instances.delete(instanceId);
  }

  /** Enumerate live instances (sorted by id) for per-tick comparison. */
  enumerate(): InstanceView[] {
    return [...this.instances.values()]
      .sort((a, b) => a.id - b.id)
      .map((instance) => ({
        id: instance.id,
        condition: instance.cond.name,
        bornTick: instance.bornTick,
        deadline: instance.deadline,
        remainingTicks: instance.deadline - this.currentTick,
        seenRequired: Object.fromEntries(instance.seen),
        status: "pending" as const,
      }));
  }

  /** Capture the full monitor state as JSON-serializable data. */
  snapshot(): Snapshot {
    return {
      version: 1,
      tick: this.currentTick,
      nextId: this.nextId,
      conditions: this.conditions.map((cond) => ({
        name: cond.name,
        trigger: cond.trigger,
        windowTicks: cond.windowTicks,
        require: [...cond.require],
        forbid: [...cond.forbid],
      })),
      instances: this.enumerate().map((view) => ({
        id: view.id,
        condition: view.condition,
        bornTick: view.bornTick,
        deadline: view.deadline,
        seen: { ...view.seenRequired },
      })),
      log: this.log.map((outcome) => ({ ...outcome })),
    };
  }

  /** Serialize snapshot() to a JSON string. */
  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  /** Resume a monitor from a snapshot produced by snapshot(). */
  static fromSnapshot(snapshot: Snapshot): Monitor {
    if (snapshot === null || typeof snapshot !== "object") {
      throw new Error("fromSnapshot: snapshot must be an object");
    }
    if (snapshot.version !== 1) {
      throw new Error(`fromSnapshot: unsupported version ${snapshot.version}`);
    }
    const conditions = compileConditions(
      snapshot.conditions.map((spec) => ({ ...spec })),
    );
    const monitor = new Monitor(conditions);
    monitor.currentTick = snapshot.tick;
    monitor.nextId = snapshot.nextId;
    const byName = new Map(conditions.map((cond) => [cond.name, cond]));
    for (const saved of snapshot.instances) {
      const cond = byName.get(saved.condition);
      if (!cond) {
        throw new Error(
          `fromSnapshot: unknown condition "${saved.condition}" in instances`,
        );
      }
      monitor.instances.set(saved.id, {
        id: saved.id,
        cond,
        bornTick: saved.bornTick,
        deadline: saved.deadline,
        seen: new Map(Object.entries(saved.seen)),
      });
    }
    monitor.log.push(...snapshot.log.map((outcome) => ({ ...outcome })));
    return monitor;
  }

  /** Resume a monitor from a JSON string produced by serialize(). */
  static deserialize(json: string): Monitor {
    return Monitor.fromSnapshot(JSON.parse(json) as Snapshot);
  }
}

export function monitorFor(
  spec: TimingConditionSpec | readonly TimingConditionSpec[],
): Monitor {
  return new Monitor(
    Array.isArray(spec)
      ? compileConditions(spec as readonly TimingConditionSpec[])
      : compileCondition(spec as TimingConditionSpec),
  );
}
