import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solve, InfeasibleError, InvalidInputError, type Instance } from "./solver.js";

const USAGE = [
  "Usage: binpack [input.json] [--pretty]",
  "",
  "Reads a packing instance from a JSON file (or stdin when no file is given).",
  "",
  "Input format:",
  "  {",
  '    "capacity": 10,',
  '    "items": [{ "id": 1, "size": 4, "group": "a" }, { "id": 2, "size": 6 }],',
  '    "forbidden": [[1, 2]]',
  "  }",
  "",
  "Rules: at most 20 items; same-group items share a bin; forbidden pairs never",
  "share a bin. Minimizes the bin count, then the load sequence of the bins",
  "ordered by each bin's smallest item id. Bin numbers in the output are",
  "normalized the same way: the bin holding the smallest item id is bin 1.",
].join("\n");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** True when the arguments contain no input file, i.e. stdin will be read. */
export function needsStdin(argv: string[]): boolean {
  return !argv.some((a) => !a.startsWith("-"));
}

/**
 * Pure CLI core: takes argv (without node/script) and the stdin contents,
 * returns the exit code and what would be printed. File arguments are read
 * from disk directly.
 */
export function runCli(argv: string[], stdin: string): CliResult {
  let pretty = false;
  let file: string | null = null;
  for (const arg of argv) {
    if (arg === "--pretty") pretty = true;
    else if (arg === "--help" || arg === "-h") return { code: 0, stdout: USAGE + "\n", stderr: "" };
    else if (file === null && !arg.startsWith("-")) file = arg;
    else return fail(2, "invalid_input", "unrecognized argument: " + arg);
  }
  try {
    const raw = file !== null ? readFileSync(file, "utf8") : stdin;
    let inst: Instance;
    try {
      inst = JSON.parse(raw) as Instance;
    } catch {
      throw new InvalidInputError("input is not valid JSON");
    }
    const sol = solve(inst);
    const assignment: Record<string, number> = {};
    for (const [id, bin] of [...sol.assignment.entries()].sort((a, b) => a[0] - b[0])) {
      assignment[String(id)] = bin;
    }
    const out = { bins: sol.bins, loads: sol.loads, assignment };
    return { code: 0, stdout: JSON.stringify(out, null, pretty ? 2 : 0) + "\n", stderr: "" };
  } catch (err) {
    if (err instanceof InfeasibleError) return fail(1, "infeasible", err.message);
    if (err instanceof InvalidInputError) return fail(2, "invalid_input", err.message);
    throw err;
  }
}

function fail(code: number, error: string, message: string): CliResult {
  return { code, stdout: "", stderr: JSON.stringify({ error, message }) + "\n" };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const stdin = needsStdin(argv) ? readFileSync(0, "utf8") : "";
  const result = runCli(argv, stdin);
  if (result.stdout !== "") console.log(result.stdout.replace(/\n$/, ""));
  if (result.stderr !== "") console.error(result.stderr.replace(/\n$/, ""));
  process.exit(result.code);
}
