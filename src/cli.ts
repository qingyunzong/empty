import { readFileSync } from "node:fs";
import { InputError, parseProblem } from "./model";
import { DEFAULT_VERIFY_BUDGET, planTests } from "./plan";

const USAGE = `test-planner - pick the minimum samples distinguishing every strategy pair

Usage:
  node dist/src/cli.js plan <input.json | -> [options]
  node dist/src/cli.js --help

Input JSON:
  {
    "samples": ["s1", "s2", ...],                 // 1..30 unique sample ids
    "strategies": [                               // 1..20 strategies
      { "id": "A", "outputs": [<one per sample>] },
      { "id": "B", "outputs": { "s1": 0, "s2": 1 } }
    ]
  }
  "outputs" may be an array aligned with "samples" or an object keyed by
  sample id; every sample must be covered. Output values may be any JSON.

Options:
  --no-verify          skip the independent subset-enumeration check
  --verify-budget <n>  node budget for enumeration (default ${DEFAULT_VERIFY_BUDGET})
  --help               show this help

Exit codes: 0 ok, 1 invalid input, 2 usage error.`;

export interface CliIO {
  writeOut(text: string): void;
  writeErr(text: string): void;
  readStdin(): string;
}

const defaultIO: CliIO = {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
  readStdin: () => readFileSync(process.stdin.fd, "utf8"),
};

function readInput(path: string, io: CliIO): string {
  if (path === "-") {
    return io.readStdin();
  }
  return readFileSync(path, "utf8");
}

export function run(argv: string[], io: CliIO = defaultIO): number {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.writeOut(USAGE + "\n");
    return args.length === 0 ? 2 : 0;
  }
  const command = args[0];
  if (command !== "plan") {
    io.writeErr(`unknown command "${command}"\n\n` + USAGE + "\n");
    return 2;
  }

  let inputPath: string | null = null;
  let verify = true;
  let verifyBudget = DEFAULT_VERIFY_BUDGET;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-verify") {
      verify = false;
    } else if (arg === "--verify-budget") {
      const raw = args[++i];
      const parsed = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        io.writeErr(`--verify-budget expects a positive integer, got "${raw}"\n`);
        return 2;
      }
      verifyBudget = parsed;
    } else if (arg.startsWith("--")) {
      io.writeErr(`unknown option "${arg}"\n`);
      return 2;
    } else if (inputPath === null) {
      inputPath = arg;
    } else {
      io.writeErr(`unexpected extra argument "${arg}"\n`);
      return 2;
    }
  }
  if (inputPath === null) {
    io.writeErr("missing input file (use \"-\" to read from stdin)\n");
    return 2;
  }

  let text: string;
  try {
    text = readInput(inputPath, io);
  } catch (error) {
    io.writeErr(`cannot read input: ${(error as Error).message}\n`);
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    io.writeErr(`input is not valid JSON: ${(error as Error).message}\n`);
    return 1;
  }

  try {
    const problem = parseProblem(raw);
    const started = process.hrtime.bigint();
    const result = planTests(problem, { verify, verifyBudget });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const output = { ...result, elapsedMs: Math.round(elapsedMs * 1000) / 1000 };
    io.writeOut(JSON.stringify(output, null, 2) + "\n");
    return 0;
  } catch (error) {
    if (error instanceof InputError) {
      io.writeErr(`invalid input: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv);
}
