/**
 * Application logic behind the CLI, factored out so tests can run it
 * in-process (the sandbox may forbid spawning child processes).
 */

import { readFileSync } from "node:fs";
import { Automaton, ParseError, parseAutomaton } from "./model.js";
import { CheckResult, checkEquivalence } from "./equivalence.js";
import { formatTrace } from "./trace.js";

export const EXIT_EQUIVALENT = 0;
export const EXIT_DISTINGUISHED = 1;
export const EXIT_UNKNOWN = 2;
export const EXIT_ERROR = 3;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliArgs {
  fileA: string;
  fileB: string;
  budget?: number;
  verifyDepth?: number;
}

export function usage(): string {
  return [
    "Usage: proto-diff <automatonA.json> <automatonB.json> [--budget N] [--verify-depth D]",
    "",
    "  --budget N        max product configurations to explore (default 1000000);",
    "                    if exceeded, result is UNKNOWN and equivalence is not claimed",
    "  --verify-depth D  word length bound for the post-equivalence enumeration check",
    "                    (default: number of states of the smaller automaton)",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs | "help" {
  const positional: string[] = [];
  let budget: number | undefined;
  let verifyDepth: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--budget" || arg === "--verify-depth") {
      const raw = argv[++i];
      const value = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new ParseError(`invalid value for ${arg}: ${JSON.stringify(raw)}`);
      }
      if (arg === "--budget") budget = value;
      else verifyDepth = value;
    } else if (arg === "--help" || arg === "-h") {
      return "help";
    } else if (arg.startsWith("--")) {
      throw new ParseError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new ParseError(`expected exactly 2 automaton files, got ${positional.length}`);
  }
  return { fileA: positional[0]!, fileB: positional[1]!, budget, verifyDepth };
}

function loadAutomaton(path: string, fallbackName: string): Automaton {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ParseError(`cannot read file: ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ParseError(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  return parseAutomaton(json, fallbackName);
}

function formatWord(word: string[]): string {
  return word.length === 0 ? "(empty word)" : word.join(" ");
}

function renderResult(result: CheckResult, a: Automaton, b: Automaton): { code: number; text: string } {
  const out: string[] = [];
  switch (result.kind) {
    case "distinguished": {
      out.push("Result: NOT EQUIVALENT");
      out.push(`Shortest distinguishing word: ${formatWord(result.word)} (length ${result.word.length})`);
      out.push(`Reason: ${result.detail}`);
      out.push("");
      out.push(`Trace ${a.name}:`);
      out.push(formatTrace(a, result.traceA));
      out.push("");
      out.push(`Trace ${b.name}:`);
      out.push(formatTrace(b, result.traceB));
      return { code: EXIT_DISTINGUISHED, text: out.join("\n") + "\n" };
    }
    case "equivalent": {
      out.push("Result: EQUIVALENT");
      out.push(`Reachable product configurations explored: ${result.explored}`);
      out.push("Certificate of reachable product states:");
      for (const line of result.certificate) out.push(`  ${line}`);
      const v = result.verification;
      out.push(
        `Verification: enumerated ${v.wordsChecked} words of length <= ${v.depth} ` +
        `(smaller automaton "${v.smallerAutomaton}", ${v.smallerStates} states); all agree` +
        (v.complete ? "" : " [truncated: word limit reached]")
      );
      return { code: EXIT_EQUIVALENT, text: out.join("\n") + "\n" };
    }
    case "unknown": {
      out.push("Result: UNKNOWN");
      out.push(
        `State budget exceeded after exploring ${result.explored} product configurations ` +
        `(budget ${result.budget}).`
      );
      out.push("Cannot claim equivalence.");
      return { code: EXIT_UNKNOWN, text: out.join("\n") + "\n" };
    }
  }
}

/** Run the CLI logic; pure with respect to process state (except file reads). */
export function run(argv: string[]): RunResult {
  let args: CliArgs | "help";
  try {
    args = parseArgs(argv);
  } catch (err) {
    return { code: EXIT_ERROR, stdout: "", stderr: `error: ${(err as Error).message}\n${usage()}\n` };
  }
  if (args === "help") {
    return { code: EXIT_EQUIVALENT, stdout: usage() + "\n", stderr: "" };
  }

  let a: Automaton;
  let b: Automaton;
  try {
    a = loadAutomaton(args.fileA, "A");
    b = loadAutomaton(args.fileB, "B");
    if (a.alphabet.join("") !== b.alphabet.join("")) {
      throw new ParseError("both automata must use the same alphabet in the same order");
    }
    if (a.registerNames.join(",") !== b.registerNames.join(",")) {
      throw new ParseError(
        `both automata must declare the same registers (got [${a.registerNames}] vs [${b.registerNames}])`
      );
    }
  } catch (err) {
    return { code: EXIT_ERROR, stdout: "", stderr: `error: ${(err as Error).message}\n` };
  }

  const result = checkEquivalence(a, b, { budget: args.budget, verifyDepth: args.verifyDepth });
  const rendered = renderResult(result, a, b);
  return { code: rendered.code, stdout: rendered.text, stderr: "" };
}
