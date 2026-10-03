'use strict';

const { normalizeProblem } = require('./model');
const { solve } = require('./solve');

// Computes a minimal (irreducible) infeasible constraint subset by
// deletion-based filtering: every remaining constraint is required, i.e.
// removing any single one makes the subset feasible. Feasibility is monotone
// in constraint removal, so a single pass suffices to guarantee minimality.
// Constraints considered: each task (with its release/due/duration/line),
// each precedence pair, each capacity override. The default per-slot
// capacity is part of the model and reported in the certificate for context.
function minimalInfeasibleSubset(problemJSON) {
  const isInfeasible = (candidate) => {
    try {
      return !solve(normalizeProblem(candidate)).feasible;
    } catch {
      return false;
    }
  };

  let current = structuredClone(problemJSON);
  current.tasks = current.tasks ?? [];
  current.precedence = current.precedence ?? [];
  current.capacity = current.capacity ?? {};

  for (const task of [...current.tasks]) {
    const trial = structuredClone(current);
    trial.tasks = trial.tasks.filter((t) => t.id !== task.id);
    trial.precedence = trial.precedence.filter(([a, b]) => a !== task.id && b !== task.id);
    if (isInfeasible(trial)) current = trial;
  }
  for (const edge of [...current.precedence]) {
    const trial = structuredClone(current);
    trial.precedence = trial.precedence.filter((e) => !(e[0] === edge[0] && e[1] === edge[1]));
    if (isInfeasible(trial)) current = trial;
  }
  for (const [line, slots] of Object.entries(current.capacity)) {
    for (const slot of Object.keys(slots)) {
      const trial = structuredClone(current);
      delete trial.capacity[line][slot];
      if (Object.keys(trial.capacity[line]).length === 0) delete trial.capacity[line];
      if (isInfeasible(trial)) current = trial;
    }
  }

  return {
    kind: 'minimalInfeasibleSubset',
    tasks: current.tasks,
    precedence: current.precedence,
    capacity: current.capacity,
    defaultCapacity: current.defaultCapacity ?? 1,
  };
}

module.exports = { minimalInfeasibleSubset };
