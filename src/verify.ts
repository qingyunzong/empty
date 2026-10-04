/**
 * Slice acceptance: delete the non-slice events, replay, and check the
 * target output; then prove minimality by exhaustively enumerating every
 * control-closed proper subset of the slice (traces are capped at 20
 * events, so 2^20 subsets is the worst case).
 *
 * A subset is control-closed when keeping an event implies keeping the
 * `if` predicates that govern it -- control dependencies are preserved,
 * so candidates never silently turn conditional code unconditional.
 */

import { analyze, replay, Structure, TraceEvent } from "./trace";

/** Expand a decision-event set into a replayable keep-set (adds else/end). */
export function projectMask(
  trace: TraceEvent[],
  structure: Structure,
  keep: ReadonlySet<number>,
): Set<number> {
  const mask = new Set<number>(keep);
  for (const i of keep) {
    if (trace[i].op === "if") {
      const elseIdx = structure.elseOf.get(i);
      if (elseIdx !== undefined) mask.add(elseIdx);
      const endIdx = structure.endOf.get(i);
      if (endIdx !== undefined) mask.add(endIdx);
    }
  }
  return mask;
}

export function isControlClosed(structure: Structure, set: ReadonlySet<number>): boolean {
  for (const i of set) {
    for (const c of structure.controllers[i]) {
      if (!set.has(c)) return false;
    }
  }
  return true;
}

export interface SliceCheck {
  /** replaying only the slice reproduces the target output value. */
  reproduces: boolean;
  /** no control-closed proper subset reproduces the target output. */
  minimal: boolean;
  /** first reproducing proper subset, when not minimal. */
  counterexample: number[] | null;
  /** number of control-closed proper subsets actually replayed. */
  checked: number;
  originalValue: number;
  slicedValue: number | undefined;
}

export const MAX_EXHAUSTIVE_EVENTS = 20;

export function checkSlice(trace: TraceEvent[], target: number, slice: Set<number>): SliceCheck {
  const structure = analyze(trace);
  const original = replay(trace).outputs.get(target);
  if (original === undefined) {
    throw new Error(`output event ${target} produced no value in the full trace`);
  }
  if (!isControlClosed(structure, slice)) {
    throw new Error("slice is not control-closed");
  }

  const slicedValue = replay(trace, projectMask(trace, structure, slice)).outputs.get(target);
  const reproduces = slicedValue === original;

  const decision = [...slice].sort((a, b) => a - b);
  if (decision.length > MAX_EXHAUSTIVE_EVENTS) {
    throw new Error(`slice has ${decision.length} events; exhaustive check capped at ${MAX_EXHAUSTIVE_EVENTS}`);
  }
  const fullMask = (1 << decision.length) - 1;
  let checked = 0;
  let counterexample: number[] | null = null;
  for (let m = 0; m < fullMask; m++) {
    const subset = new Set<number>();
    for (let b = 0; b < decision.length; b++) {
      if (m & (1 << b)) subset.add(decision[b]);
    }
    if (!isControlClosed(structure, subset)) continue;
    checked++;
    let value: number | undefined;
    try {
      value = replay(trace, projectMask(trace, structure, subset)).outputs.get(target);
    } catch {
      continue; // broken subtrace (e.g. unwritten variable) cannot reproduce
    }
    if (value === original) {
      counterexample = [...subset].sort((a, b) => a - b);
      break;
    }
  }
  return { reproduces, minimal: counterexample === null, counterexample, checked, originalValue: original, slicedValue };
}
