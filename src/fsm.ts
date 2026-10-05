export interface Machine {
  states: string[];
  initial: string;
  failureStates: string[];
  transitions: Record<string, Record<string, string>>;
}

export type Verdict = "fail" | "pass" | "invalid";

export interface SimResult {
  verdict: Verdict;
  finalState: string | null;
  invalidAt: number | null;
  invalidEvent: string | null;
}

export function validateMachine(machine: Machine): string[] {
  const errors: string[] = [];
  if (!Array.isArray(machine.states) || machine.states.length === 0) {
    errors.push("states must be a non-empty array");
    return errors;
  }
  const stateSet = new Set(machine.states);
  if (!stateSet.has(machine.initial)) {
    errors.push(`initial state "${machine.initial}" is not listed in states`);
  }
  for (const f of machine.failureStates ?? []) {
    if (!stateSet.has(f)) {
      errors.push(`failure state "${f}" is not listed in states`);
    }
  }
  for (const [from, row] of Object.entries(machine.transitions ?? {})) {
    if (!stateSet.has(from)) {
      errors.push(`transitions key "${from}" is not a known state`);
    }
    for (const [event, to] of Object.entries(row)) {
      if (!stateSet.has(to)) {
        errors.push(`transition ${from} --${event}--> ${to}: target is not a known state`);
      }
    }
  }
  return errors;
}

/**
 * Replay an event history against the machine.
 * A history that hits a missing transition is "invalid", never a failure.
 * A history that ends in a failure state is "fail"; anything else is "pass".
 */
export function simulate(machine: Machine, events: string[]): SimResult {
  const failureStates = new Set(machine.failureStates);
  let state = machine.initial;
  for (let i = 0; i < events.length; i++) {
    const row = machine.transitions[state];
    const next = row ? row[events[i]] : undefined;
    if (next === undefined) {
      return { verdict: "invalid", finalState: null, invalidAt: i, invalidEvent: events[i] };
    }
    state = next;
  }
  return {
    verdict: failureStates.has(state) ? "fail" : "pass",
    finalState: state,
    invalidAt: null,
    invalidEvent: null,
  };
}
