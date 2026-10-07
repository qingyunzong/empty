/**
 * In-process CLI entry logic, separated from src/cli.ts so tests can run
 * the full pipeline without spawning a subprocess.
 */

import { parseProblem } from "./parser";
import { solveProblem } from "./solver";
import { verifyProblem, DEFAULT_VERIFY_LIMIT } from "./verify";
import { formatHuman, formatJson } from "./format";

export const EXIT_SAT = 0;
export const EXIT_UNSAT = 1;
export const EXIT_ERROR = 2;

export const USAGE = `Usage: linsolve [problem-file] [--json] [--verify-limit N] [--no-verify]

Input format (one statement per line, '#' starts a comment):
  var x in [-100, 100]          variable with signed 64-bit closed interval domain
  2*x + 3 <= 15                 linear inequality (<=, <, >=, >, ==, !=)
  x % 7 == 3                    congruence (also: x == 3 (mod 7))

Output: minimal step intervals covering all solutions, or an UNSAT certificate.
All arithmetic is exact (bigint); strict inequalities never use floats.
After solving, the shrunk domain is verified exhaustively (up to --verify-limit
candidates, default ${DEFAULT_VERIFY_LIMIT}) against the original constraints.

Exit codes: 0 = SAT, 1 = UNSAT, 2 = error.`;

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

interface CliOptions {
  json: boolean;
  verify: boolean;
  verifyLimit: bigint;
  help: boolean;
}

export function parseArgs(argv: string[]): { opts: CliOptions; file: string | null } {
  const opts: CliOptions = { json: false, verify: true, verifyLimit: DEFAULT_VERIFY_LIMIT, help: false };
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-verify") opts.verify = false;
    else if (arg === "--verify-limit") {
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new Error("--verify-limit expects a non-negative integer");
      }
      opts.verifyLimit = BigInt(raw);
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (file === null) {
      file = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return { opts, file };
}

/** Run the solver on problem text; pure function of (argv, input). */
export function runCli(argv: string[], input: string): CliResult {
  try {
    const { opts } = parseArgs(argv);
    if (opts.help) return { code: EXIT_SAT, out: USAGE + "\n", err: "" };
    const problem = parseProblem(input);
    const result = solveProblem(problem);
    const verifications =
      opts.verify && result.certificate === null
        ? verifyProblem(problem, result, opts.verifyLimit)
        : null;
    const out =
      (opts.json ? formatJson(result, verifications) : formatHuman(result, verifications)) + "\n";
    if (verifications && verifications.some((v) => !v.ok)) {
      return { code: EXIT_ERROR, out, err: "verification failed\n" };
    }
    return { code: result.status === "sat" ? EXIT_SAT : EXIT_UNSAT, out, err: "" };
  } catch (err) {
    return { code: EXIT_ERROR, out: "", err: `error: ${err instanceof Error ? err.message : String(err)}\n` };
  }
}
