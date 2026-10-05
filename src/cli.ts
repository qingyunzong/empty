import { readFileSync } from "node:fs";
import { InputError, parseProblem } from "./model";
import { solve } from "./solve";
import { solveBruteForce } from "./brute";
import { buildCertificate } from "./certificate";
import { compareRanked } from "./compare";

const USAGE = `Usage: team-cli [input.json] [options]

Reads a team-formation problem (JSON) from a file argument, or from stdin
when no file (or "-") is given.

Options:
  --brute    Use exhaustive enumeration of all teams (small instances).
  --verify   Also run the other solver and cross-check that both agree.
  --help     Show this help.

Input schema:
  {
    "people": [{ "id": "p1", "skills": ["go"], "cost": 5 }, ...],   // <= 24 people, <= 12 skills
    "forbiddenPairs": [["p1", "p2"], ...],                          // optional
    "required": { "go": 1, ... }                                    // optional, per-skill minimums
  }

Objective: minimize total cost, then team size, then the lexicographically
smallest sorted id list. Exit codes: 0 feasible, 2 infeasible, 1 error.`;

interface Options {
  file: string | null;
  brute: boolean;
  verify: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { file: null, brute: false, verify: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exitCode = 0;
      throw new ExitRequested();
    } else if (arg === "--brute") {
      options.brute = true;
    } else if (arg === "--verify") {
      options.verify = true;
    } else if (arg.startsWith("--")) {
      throw new InputError(`unknown option: ${arg}`);
    } else if (options.file === null) {
      options.file = arg;
    } else {
      throw new InputError(`unexpected extra argument: ${arg}`);
    }
  }
  return options;
}

class ExitRequested extends Error {}

function run(argv: string[]): number {
  const options = parseArgs(argv);
  const text =
    options.file === null || options.file === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(options.file, "utf8");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new InputError(`invalid JSON: ${(error as Error).message}`);
  }
  const problem = parseProblem(raw);

  const solution = options.brute ? solveBruteForce(problem) : solve(problem);

  let crossCheck: Record<string, unknown> | undefined;
  if (options.verify) {
    const other = options.brute ? solve(problem) : solveBruteForce(problem);
    const agree =
      solution.feasible === other.feasible &&
      (!solution.feasible ||
        compareRanked(
          { cost: solution.cost, size: solution.team.length, ids: solution.team },
          { cost: other.cost, size: other.team.length, ids: other.team },
        ) === 0);
    crossCheck = {
      method: options.brute ? "branch-and-bound" : "exhaustive-enumeration",
      agreement: agree,
    };
  }

  if (!solution.feasible) {
    const out: Record<string, unknown> = { feasible: false };
    if (crossCheck !== undefined) out.crossCheck = crossCheck;
    console.log(JSON.stringify(out, null, 2));
    return 2;
  }

  const certificate = buildCertificate(problem, solution.team);
  const out: Record<string, unknown> = {
    feasible: true,
    cost: solution.cost,
    size: solution.team.length,
    team: solution.team,
    certificate,
  };
  if (crossCheck !== undefined) out.crossCheck = crossCheck;
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

try {
  const code = run(process.argv.slice(2));
  if (process.exitCode === undefined) {
    process.exitCode = code;
  }
} catch (error) {
  if (error instanceof ExitRequested) {
    // --help already printed.
  } else if (error instanceof InputError) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(`error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
