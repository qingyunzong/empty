#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildReport, formatText } from "./report.js";
import { search } from "./search.js";
import { parseSpec, SpecError } from "./spec.js";
import { verifyResult } from "./verify.js";

const USAGE = `Usage: perm-diff <spec.json | -> [options]

Find the minimal attribute assignment on which two permission policies
resolve differently. Candidates are enumerated with the fewest specified
fields first, ties broken by field value order (domain declaration order).

Options:
  --budget N       Maximum number of candidate assignments to evaluate
                   (overrides the spec's "budget"; default 1000000).
  --json           Emit the report as JSON instead of text.
  --no-verify      Skip the independent enumeration cross-check.
  --verify-limit N Node limit for the independent cross-check (default 2000000).
  -h, --help       Show this help.

Exit codes: 0 = DIFFER, 1 = EQUIVALENT, 2 = UNDECIDED, 3 = error.`;

export interface CliIO {
  out(chunk: string): void;
  err(chunk: string): void;
  readStdin(): string;
}

export function run(argv: string[], io: CliIO): number {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        budget: { type: "string" },
        json: { type: "boolean", default: false },
        "no-verify": { type: "boolean", default: false },
        "verify-limit": { type: "string" },
        help: { type: "boolean", default: false },
        h: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    io.err(`error: ${(err as Error).message}\n${USAGE}\n`);
    return 3;
  }
  if (args.values.help || args.values.h) {
    io.out(USAGE + "\n");
    return 0;
  }
  if (args.positionals.length !== 1) {
    io.err(`error: expected exactly one spec file (or "-" for stdin)\n${USAGE}\n`);
    return 3;
  }

  const parseIntOption = (name: string): number | undefined => {
    const raw = args.values[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new SpecError(`--${name} must be a non-negative integer`);
    return value;
  };

  try {
    const path = args.positionals[0]!;
    const source = path === "-" ? io.readStdin() : readFileSync(path, "utf8");
    const spec = parseSpec(JSON.parse(source));
    const budget = parseIntOption("budget") ?? spec.budget;
    const verifyLimit = parseIntOption("verify-limit");
    const result = search(spec, budget);
    const verify = args.values["no-verify"]
      ? { status: "skipped" as const, checks: [], failures: [], notes: ["cross-check disabled via --no-verify"] }
      : verifyResult(spec, result, verifyLimit);
    if (args.values.json) {
      io.out(JSON.stringify(buildReport(spec, result, verify), null, 2) + "\n");
    } else {
      io.out(formatText(spec, result, verify) + "\n");
    }
    if (verify.status === "failed") return 3;
    return result.verdict === "DIFFER" ? 0 : result.verdict === "EQUIVALENT" ? 1 : 2;
  } catch (err) {
    const message = err instanceof SpecError ? `invalid spec: ${err.message}` : `error: ${(err as Error).message}`;
    io.err(message + "\n");
    return 3;
  }
}

const isMain = typeof process.argv[1] === "string" && process.argv[1].endsWith("cli.js");
if (isMain) {
  process.exitCode = run(process.argv.slice(2), {
    out: (chunk) => process.stdout.write(chunk),
    err: (chunk) => process.stderr.write(chunk),
    readStdin: () => readFileSync(0, "utf8"),
  });
}
