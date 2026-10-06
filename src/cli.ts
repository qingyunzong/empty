/**
 * Command-line interface.
 *
 * Usage: proto-equiv <spec.json> [--budget N] [--enum-words N] [--cert-limit N]
 *
 * Exit codes: 0 = equivalent, 1 = distinguished (counterexample found),
 *             2 = unknown (state budget exhausted), 3 = usage/input error.
 */

import * as fs from "node:fs";
import { parseSpec, SpecError, REGISTER_BITS } from "./model";
import { Machine } from "./machine";
import { checkEquivalence } from "./equivalence";
import { verifyByEnumeration } from "./enumerate";
import { formatRegs, formatTrace } from "./trace";

export interface IO {
  out(s: string): void;
  err(s: string): void;
}

const USAGE = "usage: proto-equiv <spec.json> [--budget N] [--enum-words N] [--cert-limit N]";

export const EXIT_EQUIVALENT = 0;
export const EXIT_DISTINGUISHED = 1;
export const EXIT_UNKNOWN = 2;
export const EXIT_ERROR = 3;

function parseFlagInt(argv: string[], name: string, fallback: number): number {
  const idx = argv.indexOf(name);
  if (idx < 0) return fallback;
  const raw = argv[idx + 1];
  const v = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(v) || v < 1) throw new SpecError(`flag ${name}: expected a positive integer, got '${raw}'`);
  return v;
}

export function formatWord(word: string[]): string {
  return word.length === 0 ? "(empty word)" : word.join(" ");
}

export function run(argv: string[], io: IO): number {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (argv[i] === "--budget" || argv[i] === "--enum-words" || argv[i] === "--cert-limit") {
        i++;
      } else {
        io.err(`unknown flag: ${argv[i]}`);
        io.err(USAGE);
        return EXIT_ERROR;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) {
    io.err(USAGE);
    return EXIT_ERROR;
  }
  const specPath = positional[0];

  try {
    const rawText = fs.readFileSync(specPath, "utf8");
    const spec = parseSpec(JSON.parse(rawText));
    const budget = parseFlagInt(argv, "--budget", spec.stateBudget);
    const enumWords = parseFlagInt(argv, "--enum-words", 250000);
    const certLimit = parseFlagInt(argv, "--cert-limit", 50);

    const m1 = new Machine(spec.automata[0], spec.alphabet, spec.registers);
    const m2 = new Machine(spec.automata[1], spec.alphabet, spec.registers);

    io.out(`alphabet (ordered): ${spec.alphabet.join(" ")}`);
    io.out(`registers (${REGISTER_BITS}-bit): ${spec.registers.length ? spec.registers.join(", ") : "(none)"}`);
    io.out(`automata: ${m1.name} (${m1.states.length} states) vs ${m2.name} (${m2.states.length} states)`);
    io.out(`state budget: ${budget}`);
    io.out("");

    const result = checkEquivalence(m1, m2, spec.initialRegisters, budget, certLimit);

    if (result.status === "distinguished") {
      io.out("Result: NOT EQUIVALENT");
      io.out(`Divergence kind: ${result.kind} mismatch`);
      io.out(`Shortest distinguishing word (lexicographically first): ${formatWord(result.word)}  (length ${result.word.length})`);
      io.out(`Configurations explored: ${result.explored}`);
      io.out("");
      io.out(`Trace ${m1.name}:`);
      io.out(formatTrace(m1, spec.registers, spec.initialRegisters, result.word));
      io.out(`Trace ${m2.name}:`);
      io.out(formatTrace(m2, spec.registers, spec.initialRegisters, result.word));
      return EXIT_DISTINGUISHED;
    }

    if (result.status === "unknown") {
      io.out("Result: UNKNOWN");
      io.out(`Reason: ${result.reason}`);
      io.out("Note: equivalence was NOT established; raise --budget to continue.");
      return EXIT_UNKNOWN;
    }

    io.out("Result: EQUIVALENT");
    const cert = result.certificate;
    io.out(
      `Certificate: ${cert.reachableConfigurations} reachable product configurations ` +
        `(${m1.name}: ${cert.states1} states x ${m2.name}: ${cert.states2} states x ${REGISTER_BITS}-bit registers)`,
    );
    const shown = cert.configurations.slice(0, certLimit);
    for (const c of shown) {
      io.out(`  (${m1.name}=${c.s1} ${formatRegs(spec.registers, c.r1)}, ${m2.name}=${c.s2} ${formatRegs(spec.registers, c.r2)})`);
    }
    if (cert.reachableConfigurations > shown.length) {
      io.out(`  ... (${cert.reachableConfigurations - shown.length} more configurations omitted)`);
    }

    const report = verifyByEnumeration(m1, m2, spec.initialRegisters, enumWords);
    if (report.ok) {
      io.out(`Enumeration check: ${report.checkedWords} words up to length ${report.maxLength} verified - OK`);
    } else {
      io.out(`Enumeration check: FAILED - counterexample ${formatWord(report.counterexample ?? [])}`);
      return EXIT_DISTINGUISHED;
    }
    return EXIT_EQUIVALENT;
  } catch (e) {
    if (e instanceof SpecError) {
      io.err(`spec error: ${e.message}`);
    } else if (e instanceof SyntaxError) {
      io.err(`invalid JSON: ${e.message}`);
    } else {
      io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return EXIT_ERROR;
  }
}
