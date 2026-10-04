import type { Fsm } from "./fsm.js";

export type Verdict = "fail" | "pass" | "invalid";

export interface ReplayResult {
  verdict: Verdict;
  finalState: string | null;
  illegalAt: number | null;
}

/**
 * Replays an event history on the FSM.
 * A history that takes an undefined transition is "invalid" (illegal history)
 * and is never treated as a failure.
 */
export function replay(fsm: Fsm, events: readonly string[]): ReplayResult {
  let state = fsm.initial;
  for (let i = 0; i < events.length; i++) {
    const next = fsm.transitions.get(state)?.get(events[i] as string);
    if (next === undefined) {
      return { verdict: "invalid", finalState: null, illegalAt: i };
    }
    state = next;
  }
  return {
    verdict: fsm.failureStates.has(state) ? "fail" : "pass",
    finalState: state,
    illegalAt: null,
  };
}
