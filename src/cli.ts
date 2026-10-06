#!/usr/bin/env node
/**
 * lincon — exact solver for linear inequalities and congruences
 * over 64-bit integer domains.
 *
 * Usage:
 *   lincon solve --var 'x:[-100,100]' -c '2*x + 3 <= 50' -c 'x % 7 == 3'
 *   lincon solve --file spec.json [--enumerate[=N]] [--pretty]
 *   cat spec.json | lincon solve --file -
 *
 * Spec file format (JSON; 64-bit bounds should be given as strings):
 *   { "variables": { "x": ["-100", "100"] },
 *     "constraints": ["2*x + 3 <= 50", "x % 7 == 3"] }
 *
 * Exit codes: 0 = satisfiable, 1 = unsatisfiable (certificate printed),
 *             2 = usage / parse / input error.
 */

import process from "node:process";
import { readFileSync } from "node:fs";
import { ParseError, parseConstraint, type Constraint } from "./parser.js";
import {
  INT64_MAX,
  INT64_MIN,
  UnsupportedConstraintError,
  solveSystem,
  validateDomain,
  type Domain,
  type StepInterval,
  type SystemResult,
} from "./solver.js";

const USAGE = `lincon — exact solver for linear inequalities and congruences (64-bit integer domains)

Usage:
  lincon solve --var 'x:[LO,HI]' [--var 'y:[LO,HI]'] -c 'CONSTRAINT' [-c ...] [options]
  lincon solve --file SPEC.json [options]
  lincon --help

Options:
  --var 'name:[lo,hi]'   declare a variable with its closed 64-bit domain (repeatable)
  -c, --constraint STR   add a constraint (repeatable)
  --file PATH            read a JSON spec file ('-' reads stdin)
  --enumerate[=N]        also list all solutions when a variable has at most N (default 1000)
  --pretty               human-readable output instead of JSON
  --help                 show this help

Constraint syntax (linear, arbitrary-precision integer constants):
  2*x + 3 <= 50        strict forms <, > are allowed and handled exactly (no floats)
  3*x - 12 == 0
  (2*x + 1) % 6 == 4   or   2*x + 1 == 4 (mod 6)   or   2*x + 1 ≡ 4 (mod 6)

Exit codes: 0 = SAT, 1 = UNSAT (certificate printed), 2 = input error.
`;

class CliError extends Error {}

interface Options {
  variables: Map<string, Domain>;
  constraints: string[];
  enumerate: bigint | null;
  pretty: boolean;
}

function toBigInt(v: unknown, what: string): bigint {
  if (typeof v === "string") {
    if (!/^-?[0-9]+$/.test(v.trim())) throw new CliError(`${what}: invalid integer '${v}'`);
    return BigInt(v.trim());
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new CliError(`${what}: ${v} is not a safe integer; pass it as a string`);
    }
    return BigInt(v);
  }
  throw new CliError(`${what}: expected integer or string, got ${JSON.stringify(v)}`);
}

function parseVarDecl(s: string): [string, Domain] {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[\s*(-?[0-9]+)\s*,\s*(-?[0-9]+)\s*\]$/.exec(s);
  if (!m) throw new CliError(`invalid --var declaration '${s}', expected 'name:[lo,hi]'`);
  return [m[1]!, { lo: BigInt(m[2]!), hi: BigInt(m[3]!) }];
}

function loadSpec(path: string, opts: Options, io: CliIO): void {
  const text = path === "-" ? io.readStdin() : readFileSync(path, "utf8");
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (e) {
    throw new CliError(`invalid JSON in spec file: ${(e as Error).message}`);
  }
  if (typeof spec !== "object" || spec === null) throw new CliError("spec must be a JSON object");
  const obj = spec as Record<string, unknown>;
  if (obj.variables !== undefined) {
    if (typeof obj.variables !== "object" || obj.variables === null) {
      throw new CliError("spec.variables must be an object mapping names to [lo, hi]");
    }
    for (const [name, range] of Object.entries(obj.variables as Record<string, unknown>)) {
      if (!Array.isArray(range) || range.length !== 2) {
        throw new CliError(`spec.variables.${name}: expected [lo, hi]`);
      }
      opts.variables.set(name, {
        lo: toBigInt(range[0], `spec.variables.${name}[0]`),
        hi: toBigInt(range[1], `spec.variables.${name}[1]`),
      });
    }
  }
  if (obj.constraints !== undefined) {
    if (!Array.isArray(obj.constraints) || !obj.constraints.every((c) => typeof c === "string")) {
      throw new CliError("spec.constraints must be an array of strings");
    }
    opts.constraints.push(...(obj.constraints as string[]));
  }
}

function parseArgs(argv: string[], io: CliIO): Options | "help" {
  const opts: Options = { variables: new Map(), constraints: [], enumerate: null, pretty: false };
  const args = [...argv];
  if (args[0] === "solve") args.shift();
  if (args.length === 0) return "help";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new CliError(`option ${a} requires an argument`);
      return v;
    };
    if (a === "--help" || a === "-h" || a === "help") return "help";
    else if (a === "--var") {
      const [name, dom] = parseVarDecl(next());
      opts.variables.set(name, dom);
    } else if (a === "-c" || a === "--constraint") opts.constraints.push(next());
    else if (a === "--file") loadSpec(next(), opts, io);
    else if (a === "--pretty") opts.pretty = true;
    else if (a === "--enumerate") opts.enumerate = 1000n;
    else if (a.startsWith("--enumerate=")) {
      const n = toBigInt(a.slice("--enumerate=".length), "--enumerate");
      if (n < 0n) throw new CliError("--enumerate limit must be non-negative");
      opts.enumerate = n;
    } else throw new CliError(`unknown option '${a}'`);
  }
  return opts;
}

function checkDomains(variables: Map<string, Domain>): void {
  if (variables.size === 0) throw new CliError("no variables declared (use --var or --file)");
  for (const [name, dom] of variables) {
    validateDomain(name, dom);
  }
}

function serialize(result: SystemResult, enumerate: bigint | null): unknown {
  if (result.status === "unsat") {
    return { status: "unsat", variable: result.variable, certificate: result.certificate };
  }
  const solutions: Record<string, unknown> = {};
  for (const [name, s] of result.solutions) {
    const entry: Record<string, unknown> = {
      start: s.start,
      end: s.end,
      step: s.step,
      count: s.count,
    };
    if (enumerate !== null) {
      if (s.count <= enumerate) {
        const values: bigint[] = [];
        for (let x = s.start; x <= s.end; x += s.step) values.push(x);
        entry.values = values;
      } else {
        entry.valuesOmitted = `count ${s.count} exceeds --enumerate limit ${enumerate}`;
      }
    }
    solutions[name] = entry;
  }
  return { status: "sat", solutions };
}

function prettyPrint(result: SystemResult, enumerate: bigint | null): string {
  const lines: string[] = [];
  if (result.status === "unsat") {
    const where = result.variable === null ? "" : ` (variable ${result.variable})`;
    lines.push(`UNSAT${where}`);
    lines.push(`certificate: ${JSON.stringify(result.certificate, bigintReplacer, 2)}`);
    return lines.join("\n");
  }
  lines.push("SAT");
  for (const [name, s] of result.solutions) {
    lines.push(
      `${name} ∈ { ${s.start}, ${s.start + s.step}, … , ${s.end} }  ` +
        `[start=${s.start}, end=${s.end}, step=${s.step}, count=${s.count}]`,
    );
    if (enumerate !== null && s.count <= enumerate) {
      const values: string[] = [];
      for (let x = s.start; x <= s.end; x += s.step) values.push(x.toString());
      lines.push(`  values: ${values.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => string;
}

const defaultIO: CliIO = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin: () => readFileSync(0, "utf8"),
};

export function run(argv: string[], io: CliIO = defaultIO): number {
  let opts: Options | "help";
  try {
    opts = parseArgs(argv, io);
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}\n`);
    return 2;
  }
  if (opts === "help") {
    io.stdout(USAGE);
    return 0;
  }

  try {
    checkDomains(opts.variables);
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}\n`);
    return 2;
  }

  let constraints: Constraint[];
  try {
    constraints = opts.constraints.map((c) => parseConstraint(c));
  } catch (e) {
    if (e instanceof ParseError) {
      io.stderr(`parse error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  let result: SystemResult;
  try {
    result = solveSystem(opts.variables, constraints);
  } catch (e) {
    if (e instanceof UnsupportedConstraintError) {
      io.stderr(`unsupported: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  const out = opts.pretty
    ? prettyPrint(result, opts.enumerate)
    : JSON.stringify(serialize(result, opts.enumerate), bigintReplacer, 2);
  io.stdout(out + "\n");
  return result.status === "sat" ? 0 : 1;
}

// Run when executed directly (not imported by tests).
const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("cli.js") || invokedAs.endsWith("cli.ts")) {
  // Use exitCode (not process.exit) so piped stdout is flushed before exit.
  process.exitCode = run(process.argv.slice(2));
}

// Re-exported so the type is referenced (keeps tsc happy about unused imports).
export type { StepInterval };
export { INT64_MIN, INT64_MAX };
