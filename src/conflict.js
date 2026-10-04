// Minimal conflict (irreducible infeasible core) over the removable
// constraints: feeder capacity limits and interlocks. A constraint is kept
// in the core only when removing it restores feasibility, so the result is
// a minimal explanation of why the gap cannot be met.

import { solve, totalMaxShed } from './solver.js';

const CONFLICT_BUDGET = 2_000_000;

function relax(model, droppedFeeders, droppedInterlocks) {
  return {
    ...model,
    feeders: model.feeders.map((feeder, i) => (
      droppedFeeders.has(i)
        ? { ...feeder, capacity: feeder.capacity.map(() => Infinity) }
        : feeder
    )),
    interlocks: model.interlocks.filter((_, i) => !droppedInterlocks.has(i)),
  };
}

function feasible(model, gap) {
  const result = solve(model, { gap, budget: CONFLICT_BUDGET, findFirst: true });
  // Conservative: an inconclusive relaxation keeps the constraint in the core.
  return result.status !== 'infeasible';
}

export function minimalConflict(model, gap) {
  const feederConstraints = model.feeders.map((feeder, i) => ({
    kind: 'feeder', index: i, id: feeder.id,
  }));
  const interlockConstraints = model.interlocks.map((interlock, i) => ({
    kind: 'interlock', index: i, type: interlock.type, loads: interlock.loadIds,
  }));

  const droppedFeeders = new Set();
  const droppedInterlocks = new Set();
  const core = [];

  for (const constraint of [...feederConstraints, ...interlockConstraints]) {
    if (constraint.kind === 'feeder') droppedFeeders.add(constraint.index);
    else droppedInterlocks.add(constraint.index);
    if (feasible(relax(model, droppedFeeders, droppedInterlocks), gap)) {
      // Removing this constraint alone fixes it: it belongs to the core.
      if (constraint.kind === 'feeder') droppedFeeders.delete(constraint.index);
      else droppedInterlocks.delete(constraint.index);
      core.push(constraint);
    }
  }

  return {
    gap,
    maxShed: totalMaxShed(model),
    feeders: core.filter((c) => c.kind === 'feeder').map((c) => c.id),
    interlocks: core
      .filter((c) => c.kind === 'interlock')
      .map((c) => ({ type: c.type, loads: c.loads })),
  };
}
