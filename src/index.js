import { validateInput } from './validate.js';
import { createState, scheduleInitial, undoInstruction, buildOutput, settle } from './scheduler.js';
import { exactImprove } from './exact.js';

export { validateInput } from './validate.js';
export { replay, hashState } from './certificates.js';
export { checkSchedule } from './feasibility.js';
export { createState, scheduleInitial, undoInstruction, repair, buildOutput } from './scheduler.js';

// Runs the full deterministic pipeline: validate -> schedule (greedy with
// preemption, then exact cardinality pass for small n) -> apply undo list
// with incremental repair -> normalized output.
export function run(raw) {
  const validation = validateInput(raw);
  if (!validation.ok) {
    return { schedule: [], certificates: [], errors: validation.errors };
  }
  const { config, instructions, undo, excluded } = validation.value;
  const state = createState(config, instructions, excluded);
  state.errors.push(...validation.errors); // non-fatal: MISSING_DEP, CYCLE

  scheduleInitial(state);
  exactImprove(state);
  settle(state);
  for (const id of undo) {
    undoInstruction(state, id);
  }
  return buildOutput(state);
}
