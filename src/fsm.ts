export interface FsmSpec {
  initial: string;
  failureStates: string[];
  transitions: Record<string, Record<string, string>>;
}

export interface Fsm {
  initial: string;
  failureStates: ReadonlySet<string>;
  transitions: ReadonlyMap<string, ReadonlyMap<string, string>>;
  states: ReadonlySet<string>;
}

function fail(message: string): never {
  throw new Error(`invalid FSM: ${message}`);
}

export function parseFsm(spec: unknown): Fsm {
  if (typeof spec !== "object" || spec === null) fail("root must be an object");
  const obj = spec as Record<string, unknown>;

  if (typeof obj.initial !== "string" || obj.initial.length === 0) {
    fail('"initial" must be a non-empty string');
  }
  if (!Array.isArray(obj.failureStates) || obj.failureStates.some((s) => typeof s !== "string")) {
    fail('"failureStates" must be an array of strings');
  }
  if (typeof obj.transitions !== "object" || obj.transitions === null || Array.isArray(obj.transitions)) {
    fail('"transitions" must be an object of { state: { event: nextState } }');
  }

  const transitions = new Map<string, Map<string, string>>();
  const states = new Set<string>([obj.initial, ...(obj.failureStates as string[])]);

  for (const [state, row] of Object.entries(obj.transitions as Record<string, unknown>)) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail(`transitions["${state}"] must be an object`);
    }
    states.add(state);
    const rowMap = new Map<string, string>();
    for (const [event, target] of Object.entries(row as Record<string, unknown>)) {
      if (typeof target !== "string" || target.length === 0) {
        fail(`transitions["${state}"]["${event}"] must be a non-empty string`);
      }
      rowMap.set(event, target);
      states.add(target);
    }
    transitions.set(state, rowMap);
  }

  return {
    initial: obj.initial,
    failureStates: new Set(obj.failureStates as string[]),
    transitions,
    states,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
