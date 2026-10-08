import {
  DEFAULT_CAP,
  MAX_STEPS,
  invertChain,
  parseStep,
  verifyIntervals,
  type Step,
} from "./core.js";

export const USAGE = `Usage: quote <amount> --steps <p/q>[,<p/q>...] [options]

Invert a rounded quote amount back to the integer original-price range.

Arguments:
  amount              final rounded amount (integer, 0 <= amount)

Options:
  --steps <list>      1..${MAX_STEPS} rational multipliers applied in order,
                      e.g. --steps 9/10,4/5  (comma-separated or repeated flag)
  --cap <n>           inclusive original-price upper bound (default ${DEFAULT_CAP})
  --verify            forward-compute every value in low price domains to
                      confirm the inverted intervals (boundaries sampled above)
  --json              emit machine-readable JSON
  -h, --help          show this help

Output: one disjoint closed interval per line, "[lo, hi]", or "EMPTY".
`;

interface Options {
  amount: bigint;
  steps: Step[];
  cap: bigint;
  verify: boolean;
  json: boolean;
}

export class CliError extends Error {}

function parseArgs(argv: string[]): Options | "help" {
  let amount: bigint | undefined;
  const stepTexts: string[] = [];
  let cap = DEFAULT_CAP;
  let verify = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--steps": {
        const value = argv[++i];
        if (value === undefined) throw new CliError("--steps requires a value");
        stepTexts.push(...value.split(",").filter((s) => s.trim() !== ""));
        break;
      }
      case "--cap": {
        const value = argv[++i];
        if (value === undefined || !/^\d+$/.test(value)) {
          throw new CliError("--cap requires a non-negative integer");
        }
        cap = BigInt(value);
        break;
      }
      case "--verify":
        verify = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        if (arg.startsWith("--")) throw new CliError(`unknown option ${arg}`);
        if (amount !== undefined) throw new CliError(`unexpected argument "${arg}"`);
        if (!/^\d+$/.test(arg)) {
          throw new CliError(`amount must be a non-negative integer, got "${arg}"`);
        }
        amount = BigInt(arg);
    }
  }

  if (amount === undefined) throw new CliError("missing <amount>");
  if (stepTexts.length === 0) throw new CliError("missing --steps");
  let steps: Step[];
  try {
    steps = stepTexts.map(parseStep);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  if (steps.length > MAX_STEPS) {
    throw new CliError(`at most ${MAX_STEPS} steps allowed, got ${steps.length}`);
  }
  return { amount, steps, cap, verify, json };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the CLI purely: arguments in, captured output and exit code out. */
export function runCli(argv: string[]): CliResult {
  let opts: Options | "help";
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { code: 2, stdout: "", stderr: `quote: ${(err as Error).message}\n\n${USAGE}` };
  }
  if (opts === "help") return { code: 0, stdout: USAGE, stderr: "" };

  const intervals = invertChain(opts.amount, opts.steps, opts.cap);

  let verifyNote = "";
  if (opts.verify) {
    const report = verifyIntervals(opts.amount, opts.steps, intervals, opts.cap);
    if (!report.ok) {
      const lines = report.failures.map((f) => `verify FAILED: ${f}`).join("\n");
      return { code: 1, stdout: "", stderr: lines + "\n" };
    }
    verifyNote =
      `verify ok (${report.checked} forward checks, ` +
      `${report.exhaustive ? "exhaustive" : "boundary-sampled"})\n`;
  }

  if (opts.json) {
    const stdout =
      JSON.stringify({
        amount: opts.amount.toString(),
        steps: opts.steps.map((s) => `${s.p}/${s.q}`),
        cap: opts.cap.toString(),
        intervals: intervals.map((iv) => [iv.lo.toString(), iv.hi.toString()]),
        ...(opts.verify ? { verify: verifyNote.trim() } : {}),
      }) + "\n";
    return { code: 0, stdout, stderr: verifyNote };
  }

  const stdout =
    intervals.length === 0
      ? "EMPTY\n"
      : intervals.map(({ lo, hi }) => `[${lo}, ${hi}]`).join("\n") + "\n";
  return { code: 0, stdout, stderr: verifyNote };
}
