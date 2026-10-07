#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { calibrate, DEFAULT_VERIFY_LIMIT } from "./calibrate";

const USAGE = `Usage: calibrate [input.json] [options]

Reads a calibration request as JSON (from a file argument or stdin) and writes
the optimal per-group thresholds, confusion matrices, and a DP optimality
certificate as JSON to stdout.

Input schema:
{
  "budget":  <non-negative integer, global FP budget>,
  "version": <optional non-negative integer, snapshot version>,
  "groups": [                            // 1..8 groups
    {
      "name": "optional-name",
      "samples": [
        { "id": "s1", "score": 7, "label": true,  "since": 0 },
        { "id": "s2", "score": 3, "label": false, "since": 1, "until": 4 }
      ]
    }
  ]
}

A sample is active at version v when since <= v < until (until omitted = never
removed). Default version is the latest version mentioned in the input.
Acceptance rule: a sample is accepted iff score >= threshold, so tied scores
always receive the same decision.

Options:
  --budget N        Override the budget from the input file.
  --version N       Override the snapshot version from the input file.
  --verify-limit N  Max threshold-vector combinations for the exhaustive
                    optimality check (default ${DEFAULT_VERIFY_LIMIT}, 0 disables).
  --compact         Emit compact single-line JSON.
  -h, --help        Show this help.

Exit code 0 on success, 1 on invalid input or arguments.`;

interface CliArgs {
  inputPath?: string;
  budget?: number;
  version?: number;
  verifyLimit?: number;
  compact: boolean;
  help: boolean;
}

function parseIntFlag(name: string, value: string | undefined): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new Error(`flag ${name} requires an integer argument, got ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`flag ${name} requires a non-negative safe integer, got ${value}`);
  }
  return n;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { compact: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args.help = true;
    } else if (a === "--budget") {
      args.budget = parseIntFlag(a, argv[++i]);
    } else if (a === "--version") {
      args.version = parseIntFlag(a, argv[++i]);
    } else if (a === "--verify-limit") {
      args.verifyLimit = parseIntFlag(a, argv[++i]);
    } else if (a === "--compact") {
      args.compact = true;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (args.inputPath === undefined) {
      args.inputPath = a;
    } else {
      throw new Error(`unexpected extra argument: ${a}`);
    }
  }
  return args;
}

export function runCli(argv: string[], readStdin?: () => string): string {
  const args = parseArgs(argv);
  if (args.help) return USAGE + "\n";
  const text =
    args.inputPath !== undefined
      ? readFileSync(args.inputPath, "utf8")
      : readStdin !== undefined
        ? readStdin()
        : readFileSync(0, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`input is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("input must be a JSON object");
  }
  const merged = { ...(raw as Record<string, unknown>) };
  if (args.budget !== undefined) merged.budget = args.budget;
  if (args.version !== undefined) merged.version = args.version;
  const result = calibrate(merged, {
    verifyLimit: args.verifyLimit === 0 ? 0 : args.verifyLimit,
  });
  const json = args.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2);
  return json + "\n";
}

function main(): void {
  try {
    process.stdout.write(runCli(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`calibrate: error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
