/**
 * Equivalence engine.
 *
 * Two register automata are equivalent iff, over every reachable product
 * configuration (control state pair + both 8-bit register valuations):
 *   1. acceptance agrees,
 *   2. every shared register holds the same value,
 *   3. for every alphabet symbol both edges emit the same integer output
 *      (a missing edge emits nothing, which differs from any integer output).
 *
 * The search is a breadth-first traversal of the product configuration graph,
 * expanding symbols in alphabet order, so the first counterexample found is a
 * shortest distinguishing word, lexicographically smallest among shortest.
 *
 * If the number of explored product configurations exceeds the state budget,
 * the search reports "unknown" and equivalence is NOT claimed.
 */

import { Automaton } from "./model.js";
import {
  Config,
  SINK_STATE,
  configKey,
  formatConfig,
  initialConfig,
  isAccepting,
  step,
} from "./machine.js";
import { Trace, runTrace } from "./trace.js";

export const DEFAULT_BUDGET = 1_000_000;
export const DEFAULT_MAX_VERIFY_WORDS = 1_000_000;

export interface CheckOptions {
  /** Maximum number of product configurations that may be explored. */
  budget?: number;
  /** Depth for the post-equivalence word enumeration (default: size of the smaller automaton). */
  verifyDepth?: number;
  /** Safety cap on the number of enumerated verification words. */
  maxVerifyWords?: number;
}

export type DistinguishReason = "acceptance" | "output" | "register";

export interface Distinguished {
  kind: "distinguished";
  word: string[];
  reason: DistinguishReason;
  detail: string;
  traceA: Trace;
  traceB: Trace;
}

export interface Equivalent {
  kind: "equivalent";
  explored: number;
  /** Reachable product configurations, in BFS discovery order. */
  certificate: string[];
  verification: {
    depth: number;
    wordsChecked: number;
    complete: boolean;
    smallerAutomaton: string;
    smallerStates: number;
  };
}

export interface Unknown {
  kind: "unknown";
  explored: number;
  budget: number;
}

export type CheckResult = Distinguished | Equivalent | Unknown;

interface ProductNode {
  a: Config;
  b: Config;
  word: string[];
}

function productKey(a: Automaton, b: Automaton, na: Config, nb: Config): string {
  return `${configKey(a, na)}|${configKey(b, nb)}`;
}

function sharedRegisters(a: Automaton, b: Automaton): string[] {
  const bRegs = new Set(b.registerNames);
  return a.registerNames.filter((r) => bRegs.has(r));
}

function registerMismatch(
  shared: string[],
  na: Config,
  nb: Config
): string | null {
  for (const reg of shared) {
    const va = na.registers[reg] ?? 0;
    const vb = nb.registers[reg] ?? 0;
    if (va !== vb) return `register ${reg}: ${va} != ${vb}`;
  }
  return null;
}

export function checkEquivalence(a: Automaton, b: Automaton, options: CheckOptions = {}): CheckResult {
  const budget = options.budget ?? DEFAULT_BUDGET;

  if (a.alphabet.join("") !== b.alphabet.join("")) {
    throw new Error("both automata must declare the same alphabet in the same order");
  }
  const alphabet = a.alphabet;
  const shared = sharedRegisters(a, b);

  const start: ProductNode = { a: initialConfig(a), b: initialConfig(b), word: [] };
  const visited = new Set<string>([productKey(a, b, start.a, start.b)]);
  const certificate: string[] = [];
  const queue: ProductNode[] = [start];
  let head = 0;
  let explored = 0;

  while (head < queue.length) {
    if (explored >= budget) {
      return { kind: "unknown", explored, budget };
    }
    const node = queue[head++]!;
    explored++;
    certificate.push(
      `(${formatConfig(a, node.a)})  x  (${formatConfig(b, node.b)})`
    );

    const accA = isAccepting(a, node.a.state);
    const accB = isAccepting(b, node.b.state);
    if (accA !== accB) {
      return distinguished(a, b, node.word, "acceptance",
        `acceptance differs after the word: ${a.name} accepting=${accA}, ${b.name} accepting=${accB}`);
    }

    const regDiff = registerMismatch(shared, node.a, node.b);
    if (regDiff !== null) {
      return distinguished(a, b, node.word, "register",
        `register state differs after the word: ${regDiff}`);
    }

    for (const symbol of alphabet) {
      const stepA = step(a, node.a, symbol);
      const stepB = step(b, node.b, symbol);
      if (stepA.output !== stepB.output) {
        return distinguished(a, b, [...node.word, symbol], "output",
          `output differs at step ${node.word.length + 1} on symbol "${symbol}": ` +
          `${a.name} emitted ${fmtOut(stepA.output)}, ${b.name} emitted ${fmtOut(stepB.output)}`);
      }
      const key = productKey(a, b, stepA.next, stepB.next);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ a: stepA.next, b: stepB.next, word: [...node.word, symbol] });
      }
    }
  }

  return {
    kind: "equivalent",
    explored,
    certificate,
    verification: verifyByEnumeration(a, b, shared, options),
  };
}

function fmtOut(output: number | null): string {
  return output === null ? "no output (sink edge)" : String(output);
}

function distinguished(
  a: Automaton,
  b: Automaton,
  word: string[],
  reason: DistinguishReason,
  detail: string
): Distinguished {
  return {
    kind: "distinguished",
    word,
    reason,
    detail,
    traceA: runTrace(a, word),
    traceB: runTrace(b, word),
  };
}

/**
 * Post-equivalence sanity check: enumerate every word up to the state count
 * of the smaller automaton and replay it on both machines, comparing outputs,
 * acceptance, and shared register values. A disagreement here would
 * contradict the BFS proof and indicates an internal bug.
 */
function verifyByEnumeration(
  a: Automaton,
  b: Automaton,
  shared: string[],
  options: CheckOptions
): Equivalent["verification"] {
  const smaller = Object.keys(a.states).length <= Object.keys(b.states).length ? a : b;
  const depth = options.verifyDepth ?? Math.min(Object.keys(a.states).length, Object.keys(b.states).length);
  const maxWords = options.maxVerifyWords ?? DEFAULT_MAX_VERIFY_WORDS;
  const alphabet = a.alphabet;

  let wordsChecked = 0;
  let complete = true;
  let level: string[][] = [[]];

  outer: for (let d = 0; d <= depth; d++) {
    const nextLevel: string[][] = [];
    for (const word of level) {
      if (wordsChecked >= maxWords) {
        complete = false;
        break outer;
      }
      assertWordAgrees(a, b, shared, word);
      wordsChecked++;
      if (d < depth) {
        for (const symbol of alphabet) nextLevel.push([...word, symbol]);
      }
    }
    level = nextLevel;
  }

  return {
    depth,
    wordsChecked,
    complete,
    smallerAutomaton: smaller.name,
    smallerStates: Object.keys(smaller.states).length,
  };
}

function assertWordAgrees(
  a: Automaton,
  b: Automaton,
  shared: string[],
  word: string[]
): void {
  let ca = initialConfig(a);
  let cb = initialConfig(b);
  for (const symbol of word) {
    const ra = step(a, ca, symbol);
    const rb = step(b, cb, symbol);
    if (ra.output !== rb.output) {
      throw new Error(`internal inconsistency: outputs diverge on word ${JSON.stringify(word)}`);
    }
    ca = ra.next;
    cb = rb.next;
  }
  if (isAccepting(a, ca.state) !== isAccepting(b, cb.state)) {
    throw new Error(`internal inconsistency: acceptance diverges on word ${JSON.stringify(word)}`);
  }
  const regDiff = registerMismatch(shared, ca, cb);
  if (regDiff !== null) {
    throw new Error(`internal inconsistency: registers diverge on word ${JSON.stringify(word)} (${regDiff})`);
  }
}

export { SINK_STATE };
