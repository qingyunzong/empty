/** Problem model: thermal-aware non-preemptive single-machine scheduling. */

export interface Task {
  id: string;
  /** ticks the task runs once started (integer >= 1) */
  duration: number;
  /** integer heat units added to temperature per tick while running */
  heat: number;
  /** task must complete at or before this tick */
  deadline: number;
}

export interface Problem {
  /** hard temperature ceiling, checked after every tick */
  maxTemp: number;
  /** temperature drop per idle tick (floored at 0) */
  coolingRate: number;
  /** starting temperature */
  initialTemp: number;
  /** scheduling horizon, at most 50 */
  maxTicks: number;
  tasks: Task[];
}

export const MAX_TASKS = 14;
export const MAX_TICKS_LIMIT = 50;

export function validateProblem(p: Problem): void {
  if (!Number.isInteger(p.maxTemp) || p.maxTemp < 0) {
    throw new Error(`maxTemp must be a non-negative integer, got ${p.maxTemp}`);
  }
  if (!Number.isInteger(p.coolingRate) || p.coolingRate < 0) {
    throw new Error(`coolingRate must be a non-negative integer, got ${p.coolingRate}`);
  }
  if (!Number.isInteger(p.initialTemp) || p.initialTemp < 0 || p.initialTemp > p.maxTemp) {
    throw new Error(`initialTemp must be an integer in [0, maxTemp], got ${p.initialTemp}`);
  }
  if (!Number.isInteger(p.maxTicks) || p.maxTicks < 1 || p.maxTicks > MAX_TICKS_LIMIT) {
    throw new Error(`maxTicks must be an integer in [1, ${MAX_TICKS_LIMIT}], got ${p.maxTicks}`);
  }
  if (p.tasks.length === 0) {
    throw new Error("at least one task is required");
  }
  if (p.tasks.length > MAX_TASKS) {
    throw new Error(`at most ${MAX_TASKS} tasks supported, got ${p.tasks.length}`);
  }
  const seen = new Set<string>();
  for (const t of p.tasks) {
    if (!t.id || seen.has(t.id)) {
      throw new Error(`task ids must be non-empty and unique, got "${t.id}"`);
    }
    seen.add(t.id);
    if (!Number.isInteger(t.duration) || t.duration < 1) {
      throw new Error(`task ${t.id}: duration must be an integer >= 1, got ${t.duration}`);
    }
    if (!Number.isInteger(t.heat) || t.heat < 0) {
      throw new Error(`task ${t.id}: heat must be an integer >= 0, got ${t.heat}`);
    }
    if (!Number.isInteger(t.deadline) || t.deadline < 1 || t.deadline > p.maxTicks) {
      throw new Error(`task ${t.id}: deadline must be an integer in [1, maxTicks], got ${t.deadline}`);
    }
  }
}

export function parseProblem(json: string): Problem {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const p: Problem = {
    maxTemp: raw.maxTemp as number,
    coolingRate: raw.coolingRate as number,
    initialTemp: (raw.initialTemp as number | undefined) ?? 0,
    maxTicks: (raw.maxTicks as number | undefined) ?? MAX_TICKS_LIMIT,
    tasks: raw.tasks as Task[],
  };
  validateProblem(p);
  return p;
}
