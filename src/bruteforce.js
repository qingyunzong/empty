// Independent full-permutation enumerator, used to cross-check the main
// enumerator on small pools (<= 3 tasks). It generates every permutation of
// the complete step multiset, applies the longest legal prefix, and keeps
// the ones that end in a terminal state (no enabled steps left). It shares
// no enumeration logic with src/enumerate.js.

import { splitLabel } from './enumerate.js';

export function bruteForceSchedules(model) {
  model.reset();
  const steps = [];
  for (const task of model.tasks) {
    steps.push(`${task.id}:R`, `${task.id}:C`);
  }
  const schedules = new Set();
  const used = new Array(steps.length).fill(false);
  const perm = [];

  function evaluate() {
    model.reset();
    const path = [];
    for (const label of perm) {
      const [taskId, phase] = splitLabel(label);
      if (!model.applicable(taskId, phase)) break;
      model.apply(taskId, phase);
      path.push(label);
    }
    if (model.enabledSteps().length === 0) {
      schedules.add(path.join(' '));
    }
  }

  function permute() {
    if (perm.length === steps.length) {
      evaluate();
      return;
    }
    for (let i = 0; i < steps.length; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      perm.push(steps[i]);
      permute();
      perm.pop();
      used[i] = false;
    }
  }

  permute();
  model.reset();
  return schedules;
}
