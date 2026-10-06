/**
 * Data model and JSON parsing/validation for deterministic register automata.
 *
 * An automaton has:
 *  - at most MAX_STATES control states,
 *  - an ordered alphabet (the given order defines lexicographic order),
 *  - a set of 8-bit registers (values 0..255),
 *  - transitions carrying an integer output and register updates.
 *
 * Missing edges are implicit transitions into a rejecting sink state.
 */

export const MAX_STATES = 30;
export const REGISTER_MODULUS = 256;

export type UpdateOp = "set" | "add" | "sub" | "xor" | "and" | "or";

export interface RegUpdate {
  op: UpdateOp;
  value: number;
}

export interface Transition {
  next: string;
  output: number;
  update: Record<string, RegUpdate>;
}

export interface StateDef {
  accepting: boolean;
  transitions: Record<string, Transition>;
}

export interface Automaton {
  name: string;
  /** Ordered alphabet; index in this array defines lexicographic order. */
  alphabet: string[];
  initialState: string;
  registerNames: string[];
  initialRegisters: Record<string, number>;
  states: Record<string, StateDef>;
}

export class ParseError extends Error {}

function fail(message: string): never {
  throw new ParseError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < REGISTER_MODULUS;
}

function parseUpdate(raw: unknown, where: string): RegUpdate {
  if (typeof raw === "number") {
    if (!isByte(raw)) fail(`${where}: set value must be an integer in 0..255, got ${raw}`);
    return { op: "set", value: raw };
  }
  if (isRecord(raw)) {
    const op = raw.op;
    const value = raw.value;
    if (op !== "set" && op !== "add" && op !== "sub" && op !== "xor" && op !== "and" && op !== "or") {
      fail(`${where}: unknown update op ${JSON.stringify(op)}`);
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
      fail(`${where}: update value must be an integer`);
    }
    return { op, value };
  }
  return fail(`${where}: update must be a byte or an object {op, value}`);
}

export function parseAutomaton(raw: unknown, fallbackName: string): Automaton {
  if (!isRecord(raw)) fail("automaton definition must be a JSON object");

  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : fallbackName;

  if (!Array.isArray(raw.alphabet) || raw.alphabet.length === 0) {
    fail(`${name}: "alphabet" must be a non-empty array of symbols`);
  }
  const alphabet: string[] = [];
  for (const sym of raw.alphabet) {
    if (typeof sym !== "string" || sym.length === 0) {
      fail(`${name}: alphabet symbols must be non-empty strings`);
    }
    if (alphabet.includes(sym)) fail(`${name}: duplicate alphabet symbol ${JSON.stringify(sym)}`);
    alphabet.push(sym);
  }

  if (!isRecord(raw.states)) fail(`${name}: "states" must be an object`);
  const stateNames = Object.keys(raw.states);
  if (stateNames.length === 0) fail(`${name}: automaton must declare at least one state`);
  if (stateNames.length > MAX_STATES) {
    fail(`${name}: automaton has ${stateNames.length} states, maximum is ${MAX_STATES}`);
  }

  if (typeof raw.initialState !== "string" || !stateNames.includes(raw.initialState)) {
    fail(`${name}: "initialState" must be one of the declared states`);
  }
  const initialState = raw.initialState;

  const rawRegs = raw.initialRegisters ?? {};
  if (!isRecord(rawRegs)) fail(`${name}: "initialRegisters" must be an object`);
  const initialRegisters: Record<string, number> = {};
  for (const [reg, value] of Object.entries(rawRegs)) {
    if (!isByte(value)) fail(`${name}: register ${reg} initial value must be an integer in 0..255`);
    initialRegisters[reg] = value;
  }
  const registerNames = Object.keys(initialRegisters).sort();

  const states: Record<string, StateDef> = {};
  for (const stateName of stateNames) {
    const rawState = (raw.states as Record<string, unknown>)[stateName];
    if (!isRecord(rawState)) fail(`${name}: state ${stateName} must be an object`);
    const accepting = rawState.accepting === true;
    const rawTransitions = rawState.transitions ?? {};
    if (!isRecord(rawTransitions)) fail(`${name}: state ${stateName} "transitions" must be an object`);
    const transitions: Record<string, Transition> = {};
    for (const [sym, rawTr] of Object.entries(rawTransitions)) {
      const where = `${name}: transition ${stateName} --${sym}-->`;
      if (!alphabet.includes(sym)) fail(`${where}: symbol not in alphabet`);
      if (!isRecord(rawTr)) fail(`${where}: transition must be an object`);
      if (typeof rawTr.next !== "string" || !stateNames.includes(rawTr.next)) {
        fail(`${where}: "next" must be one of the declared states`);
      }
      if (typeof rawTr.output !== "number" || !Number.isInteger(rawTr.output)) {
        fail(`${where}: "output" must be an integer`);
      }
      const rawUpdate = rawTr.update ?? {};
      if (!isRecord(rawUpdate)) fail(`${where}: "update" must be an object`);
      const update: Record<string, RegUpdate> = {};
      for (const [reg, rawUp] of Object.entries(rawUpdate)) {
        if (!(reg in initialRegisters)) fail(`${where}: unknown register ${reg}`);
        update[reg] = parseUpdate(rawUp, `${where} register ${reg}`);
      }
      transitions[sym] = { next: rawTr.next, output: rawTr.output, update };
    }
    states[stateName] = { accepting, transitions };
  }

  return { name, alphabet, initialState, registerNames, initialRegisters, states };
}

/** Apply a register update, keeping every value in 0..255 (8-bit wrap-around). */
export function applyUpdate(
  registers: Record<string, number>,
  update: Record<string, RegUpdate>
): Record<string, number> {
  const next = { ...registers };
  for (const [reg, u] of Object.entries(update)) {
    const current = next[reg] ?? 0;
    let value: number;
    switch (u.op) {
      case "set": value = u.value; break;
      case "add": value = current + u.value; break;
      case "sub": value = current - u.value; break;
      case "xor": value = current ^ u.value; break;
      case "and": value = current & u.value; break;
      case "or":  value = current | u.value; break;
    }
    next[reg] = ((value % REGISTER_MODULUS) + REGISTER_MODULUS) % REGISTER_MODULUS;
  }
  return next;
}
