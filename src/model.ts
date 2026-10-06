/**
 * Input specification model + validation.
 *
 * A spec describes two deterministic automata over a shared ordered alphabet
 * and a shared set of 8-bit registers. Transitions carry an integer output
 * (constant or register expression) and register updates.
 */

export const MAX_STATES = 30;
export const REGISTER_BITS = 8;
export const DEFAULT_STATE_BUDGET = 200000;

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

export interface TransitionSpec {
  from: string;
  on: string;
  to: string;
  output?: number | string | null;
  update?: Record<string, string>;
}

export interface AutomatonSpec {
  name?: string;
  states: string[];
  initial: string;
  accepting?: string[];
  transitions?: TransitionSpec[];
}

export interface Spec {
  alphabet: string[];
  registers?: string[];
  initialRegisters?: Record<string, number>;
  stateBudget?: number;
  automata: AutomatonSpec[];
}

export type OutputSpec =
  | { kind: "const"; value: number }
  | { kind: "expr"; src: string }
  | null;

export interface NormalizedTransition {
  from: string;
  on: string;
  to: string;
  output: OutputSpec;
  updateSrc: Record<string, string>;
}

export interface NormalizedAutomaton {
  name: string;
  states: string[];
  initial: string;
  accepting: string[];
  transitions: NormalizedTransition[];
}

export interface NormalizedSpec {
  alphabet: string[];
  registers: string[];
  initialRegisters: number[];
  stateBudget: number;
  automata: [NormalizedAutomaton, NormalizedAutomaton];
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function fail(msg: string): never {
  throw new SpecError(msg);
}

function normOutput(raw: unknown, ctx: string): OutputSpec {
  if (raw === undefined) return { kind: "const", value: 0 };
  if (raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) fail(`${ctx}: output must be an integer, got ${raw}`);
    return { kind: "const", value: raw };
  }
  if (typeof raw === "string") return { kind: "expr", src: raw };
  fail(`${ctx}: output must be an integer, an expression string, or null`);
}

function normAutomaton(raw: unknown, index: number, alphabet: Set<string>): NormalizedAutomaton {
  const ctx = `automata[${index}]`;
  if (!isObj(raw)) fail(`${ctx}: must be an object`);
  const name = raw.name === undefined ? `M${index + 1}` : raw.name;
  if (typeof name !== "string") fail(`${ctx}.name: must be a string`);

  if (!Array.isArray(raw.states) || raw.states.length === 0) fail(`${ctx}.states: must be a non-empty array`);
  const states: string[] = [];
  for (const s of raw.states) {
    if (typeof s !== "string" || s.length === 0) fail(`${ctx}.states: state names must be non-empty strings`);
    if (states.includes(s)) fail(`${ctx}.states: duplicate state '${s}'`);
    states.push(s);
  }
  if (states.length > MAX_STATES) fail(`${ctx}: ${states.length} states exceeds the ${MAX_STATES}-state limit`);

  if (typeof raw.initial !== "string" || !states.includes(raw.initial)) {
    fail(`${ctx}.initial: must be one of the declared states`);
  }
  const initial = raw.initial;

  const accepting: string[] = [];
  if (raw.accepting !== undefined) {
    if (!Array.isArray(raw.accepting)) fail(`${ctx}.accepting: must be an array`);
    for (const s of raw.accepting) {
      if (typeof s !== "string" || !states.includes(s)) fail(`${ctx}.accepting: unknown state '${String(s)}'`);
      if (!accepting.includes(s)) accepting.push(s);
    }
  }

  const transitions: NormalizedTransition[] = [];
  const seen = new Set<string>();
  if (raw.transitions !== undefined) {
    if (!Array.isArray(raw.transitions)) fail(`${ctx}.transitions: must be an array`);
    raw.transitions.forEach((t, ti) => {
      const tctx = `${ctx}.transitions[${ti}]`;
      if (!isObj(t)) fail(`${tctx}: must be an object`);
      if (typeof t.from !== "string" || !states.includes(t.from)) fail(`${tctx}.from: unknown state '${String(t.from)}'`);
      if (typeof t.on !== "string" || !alphabet.has(t.on)) fail(`${tctx}.on: '${String(t.on)}' is not in the alphabet`);
      if (typeof t.to !== "string" || !states.includes(t.to)) fail(`${tctx}.to: unknown state '${String(t.to)}'`);
      const key = `${t.from} ${t.on}`;
      if (seen.has(key)) fail(`${tctx}: duplicate transition for (${t.from}, ${t.on}) - automaton must be deterministic`);
      seen.add(key);
      const updateSrc: Record<string, string> = {};
      if (t.update !== undefined) {
        if (!isObj(t.update)) fail(`${tctx}.update: must be an object mapping register names to expressions`);
        for (const [reg, src] of Object.entries(t.update)) {
          if (typeof src !== "string") fail(`${tctx}.update.${reg}: must be an expression string`);
          updateSrc[reg] = src;
        }
      }
      transitions.push({ from: t.from, on: t.on, to: t.to, output: normOutput(t.output, tctx), updateSrc });
    });
  }

  return { name, states, initial, accepting, transitions };
}

export function parseSpec(raw: unknown): NormalizedSpec {
  if (!isObj(raw)) fail("spec: must be a JSON object");

  if (!Array.isArray(raw.alphabet) || raw.alphabet.length === 0) fail("spec.alphabet: must be a non-empty array of symbols");
  const alphabetSet = new Set<string>();
  for (const s of raw.alphabet) {
    if (typeof s !== "string" || s.length === 0) fail("spec.alphabet: symbols must be non-empty strings");
    if (alphabetSet.has(s)) fail(`spec.alphabet: duplicate symbol '${s}'`);
    alphabetSet.add(s);
  }
  // The alphabet is ordered: sort to obtain the canonical lexicographic order.
  const alphabet = [...alphabetSet].sort();

  const registers: string[] = [];
  if (raw.registers !== undefined) {
    if (!Array.isArray(raw.registers)) fail("spec.registers: must be an array of names");
    for (const r of raw.registers) {
      if (typeof r !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r)) fail(`spec.registers: invalid register name '${String(r)}'`);
      if (registers.includes(r)) fail(`spec.registers: duplicate register '${r}'`);
      registers.push(r);
    }
  }

  const initialRegisters: number[] = registers.map(() => 0);
  if (raw.initialRegisters !== undefined) {
    if (!isObj(raw.initialRegisters)) fail("spec.initialRegisters: must be an object");
    for (const [reg, v] of Object.entries(raw.initialRegisters)) {
      const idx = registers.indexOf(reg);
      if (idx < 0) fail(`spec.initialRegisters: unknown register '${reg}'`);
      if (typeof v !== "number" || !Number.isInteger(v)) fail(`spec.initialRegisters.${reg}: must be an integer`);
      initialRegisters[idx] = v & 0xff;
    }
  }

  let stateBudget = DEFAULT_STATE_BUDGET;
  if (raw.stateBudget !== undefined) {
    if (typeof raw.stateBudget !== "number" || !Number.isInteger(raw.stateBudget) || raw.stateBudget < 1) {
      fail("spec.stateBudget: must be a positive integer");
    }
    stateBudget = raw.stateBudget;
  }

  if (!Array.isArray(raw.automata) || raw.automata.length !== 2) fail("spec.automata: exactly two automata are required");
  const a = normAutomaton(raw.automata[0], 0, alphabetSet);
  const b = normAutomaton(raw.automata[1], 1, alphabetSet);

  return { alphabet, registers, initialRegisters, stateBudget, automata: [a, b] };
}
