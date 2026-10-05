import type { Buffer, ItemId } from "./buffer.js";

export type MachineState = "idle" | "processing" | "blocked" | "down";

export interface Recipe {
  /** Items consumed from the input buffer when a job starts. */
  readonly inputs: Readonly<Record<ItemId, number>>;
  /** Items produced into the output buffer when a job unloads. */
  readonly outputs: Readonly<Record<ItemId, number>>;
  /** Ticks of work required to finish a job. */
  readonly processTicks: number;
}

export interface FailureSpec {
  /** Tick at which the breakdown occurs (applied at the start of that tick). */
  readonly tick: number;
  /** Ticks needed to repair; the machine resumes at tick + repairTicks. */
  readonly repairTicks: number;
}

export interface MachineOptions {
  readonly id: string;
  readonly recipe: Recipe;
  readonly input: Buffer;
  readonly output: Buffer;
  readonly failures?: readonly FailureSpec[];
}

/**
 * A machine consumes recipe inputs, works for `processTicks` ticks, then holds
 * the finished goods until they fit into the output buffer. While holding
 * finished goods the machine is `blocked` and cannot start a new job: the
 * machine is never released early. A breakdown pauses processing in place;
 * progress is preserved and resumes after repair.
 */
export class Machine {
  readonly id: string;
  readonly recipe: Recipe;
  readonly input: Buffer;
  readonly output: Buffer;
  readonly failures: readonly FailureSpec[];

  state: MachineState = "idle";
  /** Ticks of work already done on the current job. */
  progress = 0;
  /** Repair ticks remaining while `down`. */
  downRemaining = 0;
  /** State to return to after repair. */
  private resumeState: MachineState = "idle";
  /** Inputs consumed for the job currently being processed. */
  readonly heldInputs = new Map<ItemId, number>();
  /** Finished goods held while waiting for output buffer space. */
  readonly heldOutputs = new Map<ItemId, number>();
  /** True while the machine has reported being blocked for the current load. */
  blockedReported = false;

  constructor(options: MachineOptions) {
    if (!Number.isInteger(options.recipe.processTicks) || options.recipe.processTicks < 1) {
      throw new Error(`machine ${options.id}: processTicks must be a positive integer`);
    }
    this.id = options.id;
    this.recipe = options.recipe;
    this.input = options.input;
    this.output = options.output;
    this.failures = options.failures ?? [];
  }

  breakDown(repairTicks: number): void {
    this.resumeState = this.state;
    this.state = "down";
    this.downRemaining = repairTicks;
  }

  /** Returns the restored state if repair finished this tick, else null. */
  repairTick(): MachineState | null {
    if (this.state !== "down") return null;
    this.downRemaining -= 1;
    if (this.downRemaining > 0) return null;
    this.state = this.resumeState;
    return this.state;
  }

  failureAt(tick: number): FailureSpec | undefined {
    return this.failures.find((f) => f.tick === tick);
  }

  snapshot(): MachineSnapshot {
    return {
      id: this.id,
      state: this.state,
      progress: this.progress,
      downRemaining: this.downRemaining,
      heldInputs: Object.fromEntries(this.heldInputs),
      heldOutputs: Object.fromEntries(this.heldOutputs),
    };
  }
}

export interface MachineSnapshot {
  readonly id: string;
  readonly state: MachineState;
  readonly progress: number;
  readonly downRemaining: number;
  readonly heldInputs: Readonly<Record<ItemId, number>>;
  readonly heldOutputs: Readonly<Record<ItemId, number>>;
}
