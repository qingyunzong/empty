// Minimal conflict extraction: deletion-based minimization of the task set
// that keeps the problem infeasible, then report the involved tanks and
// cleaning rules alongside the tasks.

import { Scheduler } from './scheduler.js';
import { isCompatible } from './problem.js';

const CONFLICT_BUDGET = 200000;

export function minimalConflict(problem, holds = []) {
  const tasksById = new Map(problem.tasks.map((task) => [task.id, task]));
  const isInfeasible = (taskIds) => {
    const sub = { ...problem, tasks: taskIds.map((id) => tasksById.get(id)) };
    const scheduler = new Scheduler(sub, { holds });
    return scheduler.solve({ budget: CONFLICT_BUDGET }).status === 'infeasible';
  };

  let core = problem.tasks.map((task) => task.id);
  for (const id of [...core]) {
    const trial = core.filter((other) => other !== id);
    if (trial.length > 0 && isInfeasible(trial)) core = trial;
  }

  const coreTasks = core.map((id) => tasksById.get(id));
  const materials = new Set(coreTasks.map((task) => task.material));
  const tanks = problem.tanks
    .filter((tank) => coreTasks.some((task) =>
      tank.capacity >= task.minCapacity &&
      tank.capacity <= task.maxCapacity &&
      isCompatible(problem, task.material, tank.material)))
    .map((tank) => tank.id);
  const cleaning = problem.cleaning.filter(
    (rule) => materials.has(rule.from) && materials.has(rule.to),
  );

  return {
    tasks: core,
    locked: coreTasks.filter((task) => task.locked).map((task) => task.id),
    holds: holds.map((hold) => hold.id),
    tanks,
    cleaning,
  };
}
