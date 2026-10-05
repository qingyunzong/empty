/** Problem model: single machine, non-preemptive tasks, heat dynamics. */

export interface Task {
  id: string;
  /** Ticks the task occupies the machine. */
  duration: number;
  /** Integer heat added per tick while the task runs. */
  heat: number;
  /** Task must finish at a tick <= deadline. */
  deadline: number;
}

export interface Instance {
  /** Heat removed per idle tick (heat never drops below 0). */
  coolRate: number;
  /** Heat must stay <= heatCap after every tick. */
  heatCap: number;
  /** Hard horizon: schedule must complete within maxTicks (<= 50). */
  maxTicks: number;
  tasks: Task[];
}

export const MAX_TASKS = 14;
export const MAX_TICKS_LIMIT = 50;

export function validateInstance(inst: Instance): void {
  if (!Number.isInteger(inst.coolRate) || inst.coolRate < 0) {
    throw new Error("coolRate must be a non-negative integer");
  }
  if (!Number.isInteger(inst.heatCap) || inst.heatCap < 0) {
    throw new Error("heatCap must be a non-negative integer");
  }
  if (
    !Number.isInteger(inst.maxTicks) ||
    inst.maxTicks < 1 ||
    inst.maxTicks > MAX_TICKS_LIMIT
  ) {
    throw new Error(`maxTicks must be an integer in [1, ${MAX_TICKS_LIMIT}]`);
  }
  if (!Array.isArray(inst.tasks) || inst.tasks.length === 0) {
    throw new Error("tasks must be a non-empty array");
  }
  if (inst.tasks.length > MAX_TASKS) {
    throw new Error(`at most ${MAX_TASKS} tasks are supported`);
  }
  const seen = new Set<string>();
  for (const t of inst.tasks) {
    if (typeof t.id !== "string" || t.id.length === 0) {
      throw new Error("each task needs a non-empty string id");
    }
    if (seen.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    seen.add(t.id);
    if (!Number.isInteger(t.duration) || t.duration < 1) {
      throw new Error(`task ${t.id}: duration must be a positive integer`);
    }
    if (!Number.isInteger(t.heat) || t.heat < 0) {
      throw new Error(`task ${t.id}: heat must be a non-negative integer`);
    }
    if (!Number.isInteger(t.deadline) || t.deadline < 1) {
      throw new Error(`task ${t.id}: deadline must be a positive integer`);
    }
  }
}

/** One entry of the per-tick heat trajectory. */
export interface TickTrace {
  tick: number;
  action: string; // task id or "idle"
  heatAfter: number;
}

export interface ScheduleEntry {
  taskId: string;
  start: number; // first tick (1-based)
  end: number; // last tick (inclusive); completion time = end
}

export interface Solution {
  feasible: boolean;
  makespan: number; // -1 when infeasible
  schedule: ScheduleEntry[];
  trace: TickTrace[];
}
