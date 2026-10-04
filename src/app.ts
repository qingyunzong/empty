import { readFileSync } from "node:fs";
import { parseProblem } from "./model.js";
import { plan } from "./report.js";
import { DEFAULT_COMBINATION_LIMIT } from "./verify.js";

export const USAGE = `Usage: test-planner [options] [input.json]

Reads a test-planning problem and prints the minimum set of samples that
distinguishes every distinguishable strategy pair.

Input JSON:
  {
    "samples":    [{ "id": "T1" }, ...],              // 1..30, unique ids
    "strategies": [{ "id": "S1", "outputs": [...] }]  // 1..20, one output per sample
  }

Options:
  --stdin              read the problem JSON from standard input
  --verify-limit <n>   combination budget for the independent enumeration
                       check (default ${DEFAULT_COMBINATION_LIMIT})
  -h, --help           show this help

Exit codes: 0 = planned and verified, 1 = bad input, 2 = verification
inconclusive or mismatched.
`;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  file: string | null;
  useStdin: boolean;
  verifyLimit: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { file: null, useStdin: false, verifyLimit: DEFAULT_COMBINATION_LIMIT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--stdin") {
      options.useStdin = true;
    } else if (arg === "--verify-limit") {
      const raw = argv[++i];
      const value = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--verify-limit must be a positive integer");
      }
      options.verifyLimit = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      if (options.file !== null) {
        throw new Error("only one input file may be given");
      }
      options.file = arg;
    }
  }
  if (options.useStdin && options.file !== null) {
    throw new Error("pass either a file or --stdin, not both");
  }
  return options;
}

/**
 * Pure CLI core: takes argv (and stdin text when --stdin is used) and returns
 * exit code plus captured output, so it can be tested in-process.
 */
export function runCli(argv: string[], stdinText?: string): CliResult {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `test-planner: ${(error as Error).message}\n` };
  }
  if (options.help) {
    return { exitCode: 0, stdout: USAGE, stderr: "" };
  }

  let text: string;
  if (options.useStdin) {
    if (stdinText === undefined) {
      return { exitCode: 1, stdout: "", stderr: "test-planner: --stdin given but no stdin text provided\n" };
    }
    text = stdinText;
  } else if (options.file !== null) {
    try {
      text = readFileSync(options.file, "utf8");
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: `test-planner: cannot read ${options.file}: ${(error as Error).message}\n` };
    }
  } else {
    return { exitCode: 1, stdout: "", stderr: USAGE };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `test-planner: invalid JSON: ${(error as Error).message}\n` };
  }

  try {
    const problem = parseProblem(raw);
    const report = plan(problem, options.verifyLimit);
    const verified = report.verification.status === "confirmed";
    return {
      exitCode: verified ? 0 : 2,
      stdout: JSON.stringify(report, null, 2) + "\n",
      stderr: "",
    };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `test-planner: ${(error as Error).message}\n` };
  }
}
