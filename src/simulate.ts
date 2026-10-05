/**
 * Trajectory validator: replays a schedule tick by tick and checks every
 * constraint (temperature ceiling each tick, cooling on idle ticks, task
 * durations, deadlines, horizon). Used to validate solver output.
 */

import type { Problem } from "./model.js";
import type { TaskRun } from "./solver.js";

export interface SimulationResult {
  ok: boolean;
  errors: string[];
  temps: number[]; // temperature after each tick, 1..makespan
}

export function simulate(p: Problem, runs: TaskRun[]): SimulationResult {
  const errors: string[] = [];
  const temps: number[] = [];
  const byId = new Map(p.tasks.map((t) => [t.id, t]));

  // Build per-tick action table.
  const actionAt = new Map<number, string>();
  for (const r of runs) {
    const task = byId.get(r.id);
    if (task === undefined) {
      errors.push(`unknown task id "${r.id}"`);
      continue;
    }
    if (r.end - r.start !== task.duration) {
      errors.push(`task ${r.id}: run length ${r.end - r.start} != duration ${task.duration}`);
    }
    if (r.end > task.deadline) {
      errors.push(`task ${r.id}: completes at ${r.end}, deadline ${task.deadline}`);
    }
    for (let t = r.start + 1; t <= r.end; t++) {
      if (actionAt.has(t)) {
        errors.push(`tick ${t}: overlapping tasks (${actionAt.get(t)} and ${r.id})`);
      }
      actionAt.set(t, r.id);
    }
  }
  const scheduled = new Set(runs.map((r) => r.id));
  for (const t of p.tasks) {
    if (!scheduled.has(t.id)) errors.push(`task ${t.id} never scheduled`);
  }

  const makespan = runs.reduce((m, r) => Math.max(m, r.end), 0);
  if (makespan > p.maxTicks) {
    errors.push(`makespan ${makespan} exceeds horizon ${p.maxTicks}`);
  }

  let temp = p.initialTemp;
  for (let t = 1; t <= makespan; t++) {
    const id = actionAt.get(t);
    if (id === undefined) {
      temp = Math.max(0, temp - p.coolingRate);
    } else {
      temp += byId.get(id)!.heat;
    }
    temps.push(temp);
    if (temp > p.maxTemp) {
      errors.push(`tick ${t}: temperature ${temp} exceeds maxTemp ${p.maxTemp}`);
    }
  }
  return { ok: errors.length === 0, errors, temps };
}
